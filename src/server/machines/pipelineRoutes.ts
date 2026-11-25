import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Machine-local routes for the browser ↔ pipeline integration. The browser
 * talks to this web/API process only; this process spawns the pipeline CLIs
 * (the same local trust domain as the unit supervisor) and proxies the
 * pipeline worker's event stream and artifact store, so the browser never
 * needs a route to the pipeline CLI, Temporal, or the artifact store.
 *
 * Launch (POST /api/pipeline-runs) wire contract (pipeline/docs/ALIGNMENT-CONTRACT.md,
 * "The wire"):
 * node <script> --repo <abs repo> --goal-stdin [--sketch <abs path>]... --actor rbowen
 * The goal text rides on the child's stdin. stdout's last line is one JSON
 * object: {ok:true, projectRunId} (exit 0) or {ok:false, reason, detail} (exit nonzero).
 *
 * Live events (GET /api/pipeline-runs/events) is a Server-Sent Events proxy to
 * the pipeline worker's /events (base URL from PI_PIPELINE_EVENTS_URL, default
 * http://127.0.0.1:5109). Frames are "id: <seq>\nevent: <kind>\ndata: <json>\n\n"
 * with kinds "transition" and "card"; the client's ?from= query and
 * Last-Event-ID header are forwarded, and the worker replays events with a
 * greater seq in order. Artifacts (GET /api/pipeline-runs/artifact/:sha256)
 * is a byte proxy to the worker's /artifact/:sha256, whose content-addressed
 * store verifies the digest before serving.
 */

export const DEFAULT_PIPELINE_START_RUN_SCRIPT = "/home/rbowen/pi/pipeline/dist/scripts/start-run.js";
export const DEFAULT_PIPELINE_DECIDE_SCRIPT = "/home/rbowen/pi/pipeline/dist/scripts/approve-run.js";
export const DEFAULT_PIPELINE_EVENTS_BASE_URL = "http://127.0.0.1:5109";
const PIPELINE_ACTOR = "rbowen";
const RUN_ID_RE = /^[A-Za-z0-9._:-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface PipelineRunRequest {
  repoPath: string;
  goal: string;
  sketches?: string[];
}

export type PipelineRunResult = { ok: true; projectRunId: string } | { ok: false; reason: string; detail: string };

export interface PipelineRunDelegate {
  run(request: PipelineRunRequest): Promise<PipelineRunResult>;
}

export type PipelineDecisionResult = { ok: true; receipt: Record<string, unknown> } | { ok: false; reason: string; detail: string };

export interface PipelineDecisionDelegate {
  decide(runId: string, decision: "approve" | "revise", actor: string): Promise<PipelineDecisionResult>;
}

type SpawnLike = (command: string, args: string[], stdin?: string) => ChildProcess;

interface CollectedCliOutput { code: number | null; parsed: Record<string, unknown> | undefined; stdoutText: string; stderrText: string }

/** Default spawn for the pipeline CLI clients. stdin is piped only when the
 * caller passes text for the child (start-run reads its goal from stdin);
 * stdout/stderr always capture the CLI's JSON lines. */
function defaultSpawnImpl(command: string, args: string[], stdin?: string): ChildProcess {
  const child = spawn(command, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (stdin !== undefined) child.stdin?.end(stdin, "utf8");
  return child;
}

/** Shared spawn/collect machinery for the pipeline CLI clients: every CLI's
 * success output is one JSON line; failure JSON lines ({ok:false,...}) and
 * non-JSON exits map to typed ok:false results. */
export abstract class ChildPipelineCliClient {
  private readonly spawnImpl: SpawnLike;

  protected constructor(options: { spawnImpl?: SpawnLike } = {}) {
    this.spawnImpl = options.spawnImpl ?? defaultSpawnImpl;
  }

  /** The CLI's own name, spoken in invalid-output error details. */
  protected abstract readonly cliLabel: string;

  protected spawnCli(script: string, args: string[], stdin?: string): ChildProcess {
    return this.spawnImpl(process.execPath, [script, ...args], stdin);
  }

  protected async collectCli(child: ChildProcess): Promise<CollectedCliOutput> {
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

  protected toResult<T extends { ok: true } | { ok: false; reason: string; detail: string }>(
    collected: CollectedCliOutput,
    success: (parsed: Record<string, unknown>) => T | undefined,
  ): T | { ok: false; reason: string; detail: string } {
    const { code, parsed, stdoutText, stderrText } = collected;
    if (code === 0) {
      const mapped = parsed === undefined ? undefined : success(parsed);
      if (mapped !== undefined) return mapped;
      return { ok: false, reason: "invalid_cli_output", detail: `${this.cliLabel} exited 0 without a success JSON line: ${tail(stdoutText) || tail(stderrText)}` };
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

/** Decision half of the pipeline CLI clients: spawns the approve-run CLI.
 * Same trust domain as ChildPipelineRunClient: this process spawns it, the
 * browser never sees Temporal. */
export class ChildPipelineCommandClient extends ChildPipelineCliClient implements PipelineDecisionDelegate {
  protected override readonly cliLabel = "approve-run";
  private readonly decideScript: string;

  constructor(options: { decideScript?: string; spawnImpl?: SpawnLike } = {}) {
    super(options);
    this.decideScript = options.decideScript ?? process.env["PI_WEB_PIPELINE_DECIDE"] ?? DEFAULT_PIPELINE_DECIDE_SCRIPT;
  }

  async decide(runId: string, decision: "approve" | "revise", actor: string): Promise<PipelineDecisionResult> {
    const receipt = parsedReceiptIsObject(await this.collectCli(this.spawnCli(this.decideScript, ["--run", runId, "--decision", decision, "--actor", actor])));
    return this.toResult(receipt.collected, () => (receipt.value === undefined ? undefined : { ok: true as const, receipt: receipt.value }));
  }
}

/** Launch half of the pipeline CLI clients: spawns the start-run CLI with the
 * goal text on stdin. */
export class ChildPipelineRunClient extends ChildPipelineCliClient implements PipelineRunDelegate {
  protected override readonly cliLabel = "start-run";
  private readonly scriptPath: string;

  constructor(options: { scriptPath?: string; spawnImpl?: SpawnLike } = {}) {
    super(options);
    this.scriptPath = options.scriptPath ?? process.env["PI_WEB_PIPELINE_START_RUN"] ?? DEFAULT_PIPELINE_START_RUN_SCRIPT;
  }

  async run(request: PipelineRunRequest): Promise<PipelineRunResult> {
    const args = [
      "--repo", request.repoPath,
      // The goal text rides on stdin (--goal-stdin): no temp goal file is ever
      // written, so the old mkdtemp/rm goal-dir relay is gone.
      "--goal-stdin",
      ...(request.sketches ?? []).flatMap((sketch) => ["--sketch", sketch]),
      "--actor", PIPELINE_ACTOR,
    ];
    return this.toResult(await this.collectCli(this.spawnCli(this.scriptPath, args, request.goal)), (parsed) =>
      parsed["ok"] === true && typeof parsed["projectRunId"] === "string" ? { ok: true as const, projectRunId: parsed["projectRunId"] } : undefined);
  }
}

/** Register the pipeline run routes. Machine-local by construction: they are
 * plain app routes, never exposed through the /api/machines/:id proxy. */
export function registerPipelineRoutes(
  app: FastifyInstance,
  runner: PipelineRunDelegate = new ChildPipelineRunClient(),
  commands: PipelineDecisionDelegate = new ChildPipelineCommandClient(),
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

  // Server-Sent Events proxy: the browser opens one EventSource here for all
  // runs; frames route by data.aggregate.id (the projectRunId).
  app.get<{ Querystring: { from?: string } }>("/api/pipeline-runs/events", async (request, reply) => {
    const from = request.query.from;
    const query = typeof from === "string" && from !== "" ? `?from=${encodeURIComponent(from)}` : "";
    const abort = new AbortController();
    // When the browser goes away before the stream ends, the upstream request
    // must follow; left alone, fetch would keep the pipeline worker streaming
    // to a dead socket. (request.raw "close" fires as soon as the body-less
    // GET is fully received, so it cannot signal a gone browser.)
    reply.raw.on("close", () => {
      if (!reply.raw.writableEnded) abort.abort();
    });
    let upstream: Response;
    try {
      upstream = await fetch(`${pipelineEventsBaseUrl()}/events${query}`, { headers: lastEventIdHeader(request.headers), signal: abort.signal });
    } catch (error) {
      // Pipeline worker unreachable: end the stream (200, empty body) so the
      // browser's EventSource schedules its own retry.
      request.log.warn({ error }, "pipeline events upstream unreachable");
      reply.header("content-type", "text/event-stream");
      return reply.send();
    }
    reply.code(upstream.status);
    return sendPipelineUpstreamBody(reply, upstream, "text/event-stream");
  });

  app.get<{ Params: { sha256: string } }>("/api/pipeline-runs/artifact/:sha256", async (request, reply) => {
    const { sha256 } = request.params;
    if (!SHA256_RE.test(sha256)) return reply.code(400).send({ ok: false, reason: "invalid_input", detail: "sha256 must be 64 hex characters" });
    let upstream: Response;
    try {
      upstream = await fetch(`${pipelineEventsBaseUrl()}/artifact/${sha256}`);
    } catch (error) {
      request.log.warn({ error }, "pipeline artifact upstream unreachable");
      return reply.code(502).send({ ok: false, reason: "pipeline_unreachable", detail: error instanceof Error ? error.message : String(error) });
    }
    reply.code(upstream.status);
    return sendPipelineUpstreamBody(reply, upstream, "application/octet-stream");
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

/** Base URL of the pipeline worker's HTTP surface (env
 * PI_PIPELINE_EVENTS_URL), without a trailing slash. */
function pipelineEventsBaseUrl(): string {
  return (process.env["PI_PIPELINE_EVENTS_URL"] ?? DEFAULT_PIPELINE_EVENTS_BASE_URL).replace(/\/+$/, "");
}

/** Resume support: forward the browser's Last-Event-ID header to the pipeline
 * worker, which replays the events after it. */
function lastEventIdHeader(headers: IncomingHttpHeaders): Record<string, string> {
  const lastEventId = headers["last-event-id"];
  return typeof lastEventId === "string" && lastEventId !== "" ? { "last-event-id": lastEventId } : {};
}

/** Pipe the pipeline worker's response body into the Fastify reply verbatim,
 * with the upstream content-type (or the fallback for an empty response).
 * Returns the reply: the route handler must resolve with it, because a handler
 * that resolves undefined after a stream send truncates the body. */
function sendPipelineUpstreamBody(reply: FastifyReply, upstream: Response, fallbackContentType: string): FastifyReply {
  reply.header("content-type", upstream.headers.get("content-type") ?? fallbackContentType);
  if (upstream.body === null) return reply.send();
  return reply.send(Readable.from(upstream.body));
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
