import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Machine-local route for launching an owner-approved pipeline run ("+ New
 * Work" first send). The browser talks to this web/API process only; the
 * handler spawns the pipeline start-run CLI — the same local trust domain as
 * the unit supervisor — so the browser never needs a route to the pipeline
 * CLI, Temporal, or the artifact store.
 *
 * Wire contract (pipeline/docs/ALIGNMENT-CONTRACT.md, "The wire"):
 * node <script> --repo <abs repo> --goal-file <tmpfile> [--sketch <abs path>]... --actor rbowen
 * stdout's last line is one JSON object: {ok:true, projectRunId} (exit 0) or
 * {ok:false, reason, detail} (exit nonzero).
 */

export const DEFAULT_PIPELINE_START_RUN_SCRIPT = "/home/rbowen/pi/pipeline/dist/scripts/start-run.js";
export const DEFAULT_PIPELINE_STATUS_SCRIPT = "/home/rbowen/pi/pipeline/dist/scripts/run-status.js";
export const DEFAULT_PIPELINE_DECIDE_SCRIPT = "/home/rbowen/pi/pipeline/dist/scripts/approve-run.js";
const PIPELINE_ACTOR = "rbowen";
const RUN_ID_RE = /^[A-Za-z0-9._:-]+$/;

export interface PipelineRunRequest {
  repoPath: string;
  goal: string;
  sketches?: string[];
}

export type PipelineRunResult = { ok: true; projectRunId: string } | { ok: false; reason: string; detail: string };

export interface PipelineRunDelegate {
  run(request: PipelineRunRequest): Promise<PipelineRunResult>;
}

export type PipelineStatusResult = { ok: true; view: Record<string, unknown> } | { ok: false; reason: string; detail: string };
export type PipelineDecisionResult = { ok: true; receipt: Record<string, unknown> } | { ok: false; reason: string; detail: string };

export interface PipelineStatusDelegate {
  status(runId: string): Promise<PipelineStatusResult>;
}

export interface PipelineDecisionDelegate {
  decide(runId: string, decision: "approve" | "revise", actor: string): Promise<PipelineDecisionResult>;
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

  async status(runId: string): Promise<PipelineStatusResult> {
    return this.toResult(await this.collectCli(this.spawnCli(this.statusScript, ["--run", runId])), (parsed) =>
      parsed["ok"] === true ? { ok: true as const, view: parsed } : undefined);
  }
  async decide(runId: string, decision: "approve" | "revise", actor: string): Promise<PipelineDecisionResult> {
    const receipt = parsedReceiptIsObject(await this.collectCli(this.spawnCli(this.decideScript, ["--run", runId, "--decision", decision, "--actor", actor])));
    return this.toResult(receipt.collected, () => (receipt.value === undefined ? undefined : { ok: true as const, receipt: receipt.value }));
  }

  private spawnCli(script: string, args: string[]): ChildProcess {
    return this.spawnImpl(process.execPath, [script, ...args]);
  }

  private async collectCli(child: ChildProcess): Promise<CollectedCliOutput> {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const code = await new Promise<number | null>((resolve, reject) => {
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", resolve);
    });
    const stdoutText = Buffer.concat(stdout).toString("utf8");
    const stderrText = Buffer.concat(stderr).toString("utf8");
    return { code, parsed: parseLastJsonLine(stdoutText), stdoutText, stderrText };
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const code = await new Promise<number | null>((resolve, reject) => {
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", resolve);
    });
    const stdoutText = Buffer.concat(stdout).toString("utf8");
    const parsed = parseLastJsonLine(stdoutText);
    if (code === 0) {
      if (parsed?.["ok"] === true && typeof parsed["projectRunId"] === "string") {
        return { ok: true, projectRunId: parsed["projectRunId"] };
      }
      return { ok: false, reason: "invalid_cli_output", detail: `start-run exited 0 without a success JSON line: ${tail(stdoutText) || tail(Buffer.concat(stderr).toString("utf8"))}` };
    }
    if (parsed?.["ok"] === false) {
      return {
        ok: false,
        reason: typeof parsed["reason"] === "string" ? parsed["reason"] : "cli_failed",
        detail: typeof parsed["detail"] === "string" ? parsed["detail"] : "",
      };
    }
    return { ok: false, reason: `cli_exit_${code === null ? "signal" : String(code)}`, detail: tail(Buffer.concat(stderr).toString("utf8")) || tail(stdoutText) };
  }
}

/** Register the pipeline run routes. Machine-local by construction: they are
 * plain app routes, never exposed through the /api/machines/:id proxy. */
export function registerPipelineRoutes(
  app: FastifyInstance,
  runner: PipelineRunDelegate = new ChildPipelineRunClient(),
  commands: PipelineStatusDelegate & PipelineDecisionDelegate = new ChildPipelineCommandClient(),
): void {
  app.post("/api/pipeline-runs", async (request, reply) => {
    const body = parseRunBody(request.body);
    if (body === undefined) return reply.code(400).send({ ok: false, reason: "invalid_input", detail: "body must be {repoPath, goal, sketches?}" });
    const invalid = validate(body);
    if (invalid !== undefined) return reply.code(400).send({ ok: false, reason: "invalid_input", detail: invalid });
    const sketches = [...(body.sketches ?? []), ...sketchesFromGoal(body.goal)];
    try {
      return await reply.code(200).send(await runner.run({ ...body, sketches }));
    } catch (error) {
      return reply.code(200).send({ ok: false, reason: "cli_spawn_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { runId: string } }>("/api/pipeline-runs/:runId/status", async (request, reply) => {
    const { runId } = request.params;
    if (!RUN_ID_RE.test(runId)) return reply.code(400).send({ ok: false, reason: "invalid_input", detail: "runId must match [A-Za-z0-9._:-]+" });
    try {
      return await reply.code(200).send(await commands.status(runId));
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
    const actor = typeof body["actor"] === "string" && body["actor"].trim() !== "" ? body["actor"].trim() : PIPELINE_ACTOR;
    try {
      return await reply.code(200).send(await commands.decide(runId, decision, actor));
    } catch (error) {
      return reply.code(200).send({ ok: false, reason: "cli_spawn_failed", detail: error instanceof Error ? error.message : String(error) });
    }
  });
}

function parseRunBody(value: unknown): PipelineRunRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value["repoPath"] !== "string" || typeof value["goal"] !== "string") return undefined;
  const sketches = value["sketches"];
  if (sketches !== undefined && !isStringArray(sketches)) return undefined;
  return { repoPath: value["repoPath"], goal: value["goal"], ...(sketches === undefined ? {} : { sketches }) };
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
