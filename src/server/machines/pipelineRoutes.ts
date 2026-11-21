import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isPipelineExecutionId, readPipelineApproval, readPipelineFeedback, type PipelineRevisionFeedback, type PipelineApprovalBinding } from "../../shared/pipelineApproval.js";
import type { PipelineChatStore } from "../storage/pipelineChatStore.js";
import type { FastifyInstance } from "fastify";

/**
 * Machine-local route for launching an owner-approved pipeline run ("+ New
 * Work" first send). The browser talks to this web/API process only; the
 * handler spawns the pipeline start-run CLI — the same local trust domain as
 * the unit supervisor — so the browser never needs a route to the pipeline
 * CLI, Temporal, or the artifact store.
 *
 * Wire contract (pipeline/docs/ALIGNMENT-CONTRACT.md, "The wire"):
 * node <script> --request-id <UUID> --repo <abs repo> --goal-file <tmpfile> [--sketch <abs path>]... --actor rbowen
 * stdout's last line is one JSON object: {ok:true, projectRunId} (exit 0) or
 * {ok:false, reason, detail} (exit nonzero).
 */

const projectDir = process.env["PI_PROJECT_DIR"];
const scriptsDir = join(projectDir === undefined || projectDir === "" ? join(homedir(), "pi") : projectDir, "pipeline", "dist", "scripts");
export const DEFAULT_PIPELINE_START_RUN_SCRIPT = join(scriptsDir, "start-run.js");
export const DEFAULT_PIPELINE_STATUS_SCRIPT = join(scriptsDir, "run-status.js");
export const DEFAULT_PIPELINE_DECIDE_SCRIPT = join(scriptsDir, "approve-run.js");
const PIPELINE_ACTOR = "rbowen";
const RUN_ID_RE = /^[A-Za-z0-9._:-]+$/;

export interface PipelineRunRequest {
  requestId: string;
  repoPath: string;
  goal: string;
  sketches?: string[];
}

export type PipelineRunResult = { ok: true; projectRunId: string; executionRunId?: string } | { ok: false; reason: string; detail: string };

export interface PipelineRunDelegate {
  run(request: PipelineRunRequest): Promise<PipelineRunResult>;
}

export type PipelineStatusResult = { ok: true; view: Record<string, unknown> } | { ok: false; reason: string; detail: string };
export type PipelineDecisionResult = { ok: true; receipt: Record<string, unknown> } | { ok: false; reason: string; detail: string };

export interface PipelineStatusDelegate {
  status(runId: string, execution?: string): Promise<PipelineStatusResult>;
}

export interface PipelineDecisionDelegate {
  decide(runId: string, decision: "approve" | "revise", actor: string, card: PipelineApprovalBinding, feedback?: PipelineRevisionFeedback): Promise<PipelineDecisionResult>;
}

/** Spawn delegate for the pipeline status/decision CLIs. Same trust domain as
 * ChildPipelineRunClient: this process spawns them, the browser never sees
 * Temporal. Success output of both CLIs is one JSON line; failure JSON lines
 * ({ok:false,...}) and non-JSON exits map to typed ok:false results. */
export class ChildPipelineCommandClient implements PipelineStatusDelegate, PipelineDecisionDelegate {
  private readonly statusScript: string;
  private readonly decideScript: string;
  private readonly spawnImpl: SpawnLike;

  constructor(options: { statusScript?: string; decideScript?: string; spawnImpl?: SpawnLike } = {}) {
    this.statusScript = options.statusScript ?? process.env["PI_WEB_PIPELINE_STATUS"] ?? DEFAULT_PIPELINE_STATUS_SCRIPT;
    this.decideScript = options.decideScript ?? process.env["PI_WEB_PIPELINE_DECIDE"] ?? DEFAULT_PIPELINE_DECIDE_SCRIPT;
    this.spawnImpl = options.spawnImpl ?? ((command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }));
  }

  async status(runId: string, execution?: string): Promise<PipelineStatusResult> {
    const collected = await this.collectCli(this.spawnCli(this.statusScript, ["--run", runId, ...(execution !== undefined ? ["--execution", execution] : [])]));
    return this.toResult(collected, (parsed) => {
      if (parsed["ok"] !== true) return undefined;
      const view = { ...parsed };
      delete view["result"];
      delete view["pendingApproval"];
      delete view["resolvedConfigFacts"];
      delete view["pendingQuestions"];
      return { ok: true as const, view };
    });
  }
  async decide(runId: string, decision: "approve" | "revise", actor: string, card: PipelineApprovalBinding, feedback?: PipelineRevisionFeedback): Promise<PipelineDecisionResult> {
    const receipt = parsedReceiptIsObject(await this.collectCli(this.spawnCli(this.decideScript, ["--run", runId, "--decision", decision, "--actor", actor, "--card", JSON.stringify(card), ...(feedback ? ["--feedback", JSON.stringify(feedback)] : [])])));
    return this.toResult(receipt.collected, () => (receipt.value === undefined ? undefined : { ok: true as const, receipt: receipt.value }));
  }

  private spawnCli(script: string, args: string[]): ChildProcess {
    return this.spawnImpl(process.execPath, [script, ...args]);
  }

  private async collectCli(child: ChildProcess): Promise<CollectedCliOutput> {
    return await collectOwnedCli(child, 10_000);
  }

  private toResult<T extends { ok: true } | { ok: false; reason: string; detail: string }>(
    collected: CollectedCliOutput,
    success: (parsed: Record<string, unknown>) => T | undefined,
  ): T | { ok: false; reason: string; detail: string } {
    const { code, parsed, stdoutText, stderrText } = collected;
    if (code === 0) {
      const mapped = parsed === undefined ? undefined : success(parsed);
      if (mapped !== undefined) return mapped;
      return { ok: false, reason: "invalid_cli_output", detail: `CLI exited 0 without a success JSON line: ${tail(stdoutText) || tail(stderrText)}` };
    }
    if (parsed?.["ok"] === false) {
      return {
        ok: false,
        reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "cli_failed",
        detail: typeof parsed["detail"] === "string" ? parsed["detail"] : "",
      };
    }
    return { ok: false, reason: `cli_exit_${code === null ? "signal" : String(code)}`, detail: tail(stderrText) || tail(stdoutText) };
  }
}

async function collectOwnedCli(child: ChildProcess, timeoutMs: number): Promise<CollectedCliOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let size = 0;
  const code = await new Promise<number | null>((resolve, reject) => {
    let stopped = false;
    const stop = (message: string): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => { stop("Pipeline command acknowledgement timed out."); }, timeoutMs);
    const collect = (chunks: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) { stop("Pipeline command output exceeded its response limit."); return; }
      chunks.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (exit) => { clearTimeout(timer); resolve(exit); });
  });
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  return { code, parsed: parseLastJsonLine(stdoutText), stdoutText, stderrText };
}

type SpawnLike = (command: string, args: string[]) => ChildProcess;

interface CollectedCliOutput { code: number | null; parsed: Record<string, unknown> | undefined; stdoutText: string; stderrText: string }

export class ChildPipelineRunClient implements PipelineRunDelegate {
  private readonly scriptPath: string;
  private readonly spawnImpl: SpawnLike;

  constructor(options: { scriptPath?: string; spawnImpl?: SpawnLike } = {}) {
    this.scriptPath = options.scriptPath ?? process.env["PI_WEB_PIPELINE_START_RUN"] ?? DEFAULT_PIPELINE_START_RUN_SCRIPT;
    this.spawnImpl = options.spawnImpl ?? ((command, args) => spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }));
  }

  async run(request: PipelineRunRequest): Promise<PipelineRunResult> {
    const goalDir = await mkdtemp(join(tmpdir(), "pi-web-pipeline-goal-"));
    const goalFile = join(goalDir, "goal.txt");
    try {
      await writeFile(goalFile, request.goal, "utf8");
      const args = [
        this.scriptPath,
        "--request-id", request.requestId,
        "--repo", request.repoPath,
        "--goal-file", goalFile,
        ...(request.sketches ?? []).flatMap((sketch) => ["--sketch", sketch]),
        "--actor", PIPELINE_ACTOR,
      ];
      return await this.collect(this.spawnImpl(process.execPath, args));
    } finally {
      await rm(goalDir, { recursive: true, force: true });
    }
  }

  private async collect(child: ChildProcess): Promise<PipelineRunResult> {
    const { code, parsed, stdoutText, stderrText } = await collectOwnedCli(child, 20_000);
    if (code === 0) {
      if (parsed?.["ok"] === true && typeof parsed["projectRunId"] === "string") {
        return { ok: true, projectRunId: parsed["projectRunId"], ...(isPipelineExecutionId(parsed["executionRunId"]) ? { executionRunId: parsed["executionRunId"] } : {}) };
      }
      return { ok: false, reason: "invalid_cli_output", detail: `start-run exited 0 without a success JSON line: ${tail(stdoutText) || tail(stderrText)}` };
    }
    if (parsed?.["ok"] === false) {
      return {
        ok: false,
        reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "cli_failed",
        detail: typeof parsed["detail"] === "string" ? parsed["detail"] : "",
      };
    }
    return { ok: false, reason: `cli_exit_${code === null ? "signal" : String(code)}`, detail: tail(stderrText) || tail(stdoutText) };
  }
}

/** Register the pipeline run routes. Machine-local by construction: they are
 * plain app routes, never exposed through the /api/machines/:id proxy. */
export function registerPipelineRoutes(
  app: FastifyInstance,
  runner: PipelineRunDelegate = new ChildPipelineRunClient(),
  commands: PipelineStatusDelegate & PipelineDecisionDelegate = new ChildPipelineCommandClient(),
  history?: PipelineChatStore,
): void {
  app.post("/api/pipeline-runs", async (request, reply) => {
    const body = parseRunBody(request.body);
    if (body === undefined) return reply.code(400).send({ ok: false, reason: "invalid_input", detail: "body must be {requestId, repoPath, goal, sketches?}" });
    const invalid = validate(body);
    if (invalid !== undefined) return reply.code(400).send({ ok: false, reason: "invalid_input", detail: invalid });
    const sketches = [...(body.sketches ?? []), ...sketchesFromGoal(body.goal)];
    try {
      const result = await runner.run({ ...body, sketches });
      if (result.ok && history) {
        try { history.register(result.projectRunId, body.requestId, body.repoPath, body.goal); }
        catch (error) {
          request.log.error({ err: error }, "Pipeline chat could not be registered");
          return await reply.send({ ok: false, reason: "chat_save_pending", detail: "The run was accepted. Its chat is waiting to be saved. Resend the original goal to confirm this same submission." });
        }
      }
      return await reply.code(200).send(result);
    } catch (error) {
      return reply.code(200).send({ ok: false, reason: "cli_spawn_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  if (history) {
    app.addHook("onClose", (_instance, done) => { history.close(); done(); });
    app.get<{ Querystring: { cwd?: string } }>("/api/pipeline-chats", async (req, reply) => {
      const cwd = req.query.cwd;
      if (typeof cwd !== "string" || !isAbsolute(cwd)) return reply.code(400).send();
      return reply.header("Cache-Control", "no-store").send(history.list(cwd));
    });
    app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/api/pipeline-runs/:runId/transcript", async (req, reply) => {
      const { runId } = req.params;
      const after = Number(req.query.after ?? "0");
      if (!RUN_ID_RE.test(runId) || !Number.isSafeInteger(after) || after < 0) return reply.code(400).send();
      if (!history.has(runId)) return reply.code(404).send();
      return reply.header("Cache-Control", "no-store").send(history.page(runId, after));
    });
    app.post<{ Params: { runId: string } }>("/api/pipeline-runs/:runId/transcript", { bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
      const { runId } = req.params;
      if (!RUN_ID_RE.test(runId)) return reply.code(400).send();
      if (!history.has(runId)) return reply.code(404).send();
      if (!isRecord(req.body) || !history.save(runId, req.body["lines"])) return reply.code(400).send();
      return reply.send({ ok: true });
    });
  }

  app.get<{ Params: { runId: string }; Querystring: { execution?: string } }>("/api/pipeline-runs/:runId/status", async (request, reply) => {
    const { runId } = request.params;
    if (!RUN_ID_RE.test(runId)) return reply.code(400).send({ ok: false, reason: "invalid_input", detail: "runId must match [A-Za-z0-9._:-]+" });
    try {
      const execution = request.query.execution;
      if (execution !== undefined && !isPipelineExecutionId(execution)) {
        return await reply.code(400).send({ ok: false, reason: "invalid_input", detail: "invalid execution identity" });
      }
      return await reply.code(200).send(await commands.status(runId, execution));
    } catch (error) {
      return reply.code(200).send({ ok: false, reason: "cli_spawn_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { runId: string } }>("/api/pipeline-runs/:runId/decision", async (request, reply) => {
    const { runId } = request.params;
    if (!RUN_ID_RE.test(runId)) return reply.code(400).send({ ok: false, reason: "invalid_input", detail: "runId must match [A-Za-z0-9._:-]+" });
    const body = isRecord(request.body) ? request.body : {};
    const decision = body["decision"];
    if (decision !== "approve" && decision !== "revise") return reply.code(400).send({ ok: false, reason: "invalid_input", detail: "body must be {decision: \"approve\"|\"revise\", actor?}" });
    const card = readPipelineApproval(body["card"]);
    if (!card) return reply.code(400).send({ ok: false, reason: "review_required", detail: "submit the identity of the card you reviewed" });
    try {
      const feedback = readPipelineFeedback(body["feedback"]);
      if (body["feedback"] !== undefined && (decision !== "revise" || !feedback)) return await reply.code(400).send({ ok: false, reason: "invalid-feedback", detail: "Enter a revision reason and an optional affected requirement." });
      const result = feedback ? await commands.decide(runId, decision, PIPELINE_ACTOR, card, feedback) : await commands.decide(runId, decision, PIPELINE_ACTOR, card);
      return await reply.code(200).send(result);
    } catch (error) {
      return reply.code(200).send({ ok: false, reason: "cli_spawn_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

function parseRunBody(value: unknown): PipelineRunRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value["requestId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value["requestId"])) return undefined;
  if (typeof value["repoPath"] !== "string" || typeof value["goal"] !== "string") return undefined;
  const sketches = value["sketches"];
  if (sketches !== undefined && !isStringArray(sketches)) return undefined;
  return { requestId: value["requestId"], repoPath: value["repoPath"], goal: value["goal"], ...(sketches === undefined ? {} : { sketches }) };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validate(body: PipelineRunRequest): string | undefined {
  if (!isAbsolute(body.repoPath)) return "repoPath must be an absolute path";
  if (!existsSync(body.repoPath) || !statSync(body.repoPath).isDirectory()) return `repoPath does not exist: ${body.repoPath}`;
  if (body.goal.trim() === "") return "goal must be a non-empty string";
  for (const sketch of body.sketches ?? []) {
    if (typeof sketch !== "string" || !isAbsolute(sketch)) return "sketches must be an array of absolute file paths";
  }
  return undefined;
}

/** Server-side path attachments: absolute file paths written in the goal text
 * that exist on this machine ride along as sketch context. The goal text itself
 * is passed through verbatim; explicit sketches win and duplicates drop. */
export function sketchesFromGoal(goal: string): string[] {
  const candidates = goal.match(/(?:\/[^\s,;"')\]]+)/g) ?? [];
  const seen = new Set<string>();
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      if (seen.has(candidate) || !statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

/** Type-guard form of the receipt check (lint: no type assertions). */
function parsedReceiptIsObject(collected: CollectedCliOutput): { collected: CollectedCliOutput; value: Record<string, unknown> | undefined } {
  const parsed = collected.parsed;
  const receipt = parsed?.["receipt"];
  return { collected, value: parsed?.["ok"] === true && isPlainCliRecord(receipt) ? receipt : undefined };
}

function isPlainCliRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLastJsonLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const last = lines.at(-1);
  if (last === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tail(text: string, max = 500): string {
  return text.trim().slice(-max);
}
