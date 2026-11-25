import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import { ChildPipelineCommandClient, ChildPipelineRunClient } from "./machines/pipelineRoutes.js";

registerAppTestHooks();

const execution = "01a1f777-e9fe-777d-b157-8cd6e797d35a";
const binding = {
  rootExecutionId: execution, targetExecutionId: execution, stage: "sketches" as const,
  questionId: "sketch-approval", revision: 1, artifactSha256: "a".repeat(64),
};

/** Stub start-run CLI: records argv + goal text (piped on stdin per the
 * --goal-stdin contract), then succeeds or fails depending on STUB_MODE (the
 * child inherits this process's env). */
async function writeStubScript(dir: string): Promise<string> {
  const stub = join(dir, "start-run-stub.mjs");
  await writeFile(stub, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const argvFile = process.env.STUB_ARGV_OUT;",
    "const argv = process.argv.slice(2);",
    "const goal = argv.includes('--goal-stdin') ? readFileSync(0, 'utf8') : '';",
    "writeFileSync(argvFile, JSON.stringify({ argv, goal }));",
    "if (process.env.STUB_MODE === 'fail') {",
    "  console.log(JSON.stringify({ ok: false, reason: 'temporal_unreachable', detail: 'connect ECONNREFUSED 127.0.0.1:7233' }));",
    "  process.exit(1);",
    "}",
    "console.log('loading workflows');",
    "console.log(JSON.stringify({ ok: true, projectRunId: 'run-123' }));",
  ].join("\n"), "utf8");
  return stub;
}

describe("buildApp pipeline run route", () => {
  let workDir: string;
  let stubPath: string;
  let stubMode: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pi-web-pipeline-route-test-"));
    stubPath = await writeStubScript(workDir);
    stubMode = process.env["STUB_MODE"];
    process.env["STUB_ARGV_OUT"] = join(workDir, "argv.json");
  });

  afterEach(async () => {
    process.env["STUB_MODE"] = stubMode;
    await rm(workDir, { recursive: true, force: true });
  });

  it("spawns the start-run CLI and returns the run ack", async () => {
    appTestContext.pipelineRunner = new ChildPipelineRunClient({ scriptPath: stubPath });

    const response = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pipeline-runs",
      payload: { requestId: "d17e801d-4fe0-4fe3-860b-23805fa78819", repoPath: workDir, goal: "Ship the flinger fix", sketches: [join(workDir, "sketch.png")] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, projectRunId: "run-123" });
    const argvOut = process.env["STUB_ARGV_OUT"];
    if (argvOut === undefined) throw new Error("stub argv output path not configured");
    const recorded: unknown = JSON.parse(await readFile(argvOut, "utf8"));
    expect(recorded).toMatchObject({
      argv: ["--request-id", "d17e801d-4fe0-4fe3-860b-23805fa78819", "--repo", workDir, "--goal-stdin", "--sketch", join(workDir, "sketch.png"), "--actor", "rbowen"],
      goal: "Ship the flinger fix",
    });
  });

  it("extracts existing server-side paths from the goal text as sketch context", async () => {
    appTestContext.pipelineRunner = new ChildPipelineRunClient({ scriptPath: stubPath });
    const existing = join(workDir, "notes.md");
    await writeFile(existing, "design notes");

    const response = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pipeline-runs",
      payload: { requestId: "d17e801d-4fe0-4fe3-860b-23805fa78819", repoPath: workDir, goal: `Use ${existing} and /definitely/missing.md as context` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, projectRunId: "run-123" });
    const argvOut = process.env["STUB_ARGV_OUT"];
    if (argvOut === undefined) throw new Error("stub argv output path not configured");
    const raw = await readFile(argvOut, "utf8");
    expect(raw).toContain(`"--sketch","${existing}"`);
    expect(raw).toContain(`Use ${existing} and /definitely/missing.md as context`);
    expect(raw).not.toContain("/definitely/missing.md\"");
  });

  it("passes a CLI failure JSON through as ok:false", async () => {
    process.env["STUB_MODE"] = "fail";
    appTestContext.pipelineRunner = new ChildPipelineRunClient({ scriptPath: stubPath });

    const response = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pipeline-runs",
      payload: { requestId: "d17e801d-4fe0-4fe3-860b-23805fa78819", repoPath: workDir, goal: "Ship the flinger fix" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, reason: "temporal_unreachable", detail: "connect ECONNREFUSED 127.0.0.1:7233" });
  });

  it("rejects a relative repoPath without spawning the CLI", async () => {
    let spawnCount = 0;
    appTestContext.pipelineRunner = { run: () => { spawnCount += 1; return Promise.resolve({ ok: true, projectRunId: "run-x" }); } };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pipeline-runs",
      payload: { requestId: "d17e801d-4fe0-4fe3-860b-23805fa78819", repoPath: "relative/path", goal: "Ship it" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(spawnCount).toBe(0);
  });

  it("rejects a repoPath that does not exist", async () => {
    appTestContext.pipelineRunner = { run: () => Promise.resolve({ ok: true, projectRunId: "run-x" }) };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pipeline-runs",
      payload: { requestId: "d17e801d-4fe0-4fe3-860b-23805fa78819", repoPath: "/definitely/not/a/repo", goal: "Ship it" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("rejects an empty goal", async () => {
    appTestContext.pipelineRunner = { run: () => Promise.resolve({ ok: true, projectRunId: "run-x" }) };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pipeline-runs",
      payload: { requestId: "d17e801d-4fe0-4fe3-860b-23805fa78819", repoPath: workDir, goal: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("resolves the CLI script from PI_WEB_PIPELINE_START_RUN", async () => {
    const previous = process.env["PI_WEB_PIPELINE_START_RUN"];
    process.env["PI_WEB_PIPELINE_START_RUN"] = stubPath;
    try {
      const client = new ChildPipelineRunClient();
      const result = await client.run({ requestId: "d17e801d-4fe0-4fe3-860b-23805fa78819", repoPath: workDir, goal: "env override" });
      expect(result).toEqual({ ok: true, projectRunId: "run-123" });
    } finally {
      if (previous === undefined) delete process.env["PI_WEB_PIPELINE_START_RUN"];
      else process.env["PI_WEB_PIPELINE_START_RUN"] = previous;
    }
  });
});

/** Stub status CLI: emits noise, then one JSON line depending on STUB_MODE. */
async function writeStatusStub(dir: string): Promise<string> {
  const stub = join(dir, "run-status-stub.mjs");
  await writeFile(stub, [
    "const run = process.argv[process.argv.indexOf('--run') + 1];",
    "console.log('querying temporal');",
    "if (process.env.STUB_MODE === 'no-card') {",
    "  console.log(JSON.stringify({ ok: true, runId: run, phase: 'MODULE_DESIGN', status: 'active', card: null }));",
    "} else if (process.env.STUB_MODE === 'closed') {",
    "  console.log(JSON.stringify({ ok: true, runId: run, phase: 'CLOSED', closeStatus: 'COMPLETED' }));",
    "} else if (process.env.STUB_MODE === 'fail') {",
    "  console.log(JSON.stringify({ ok: false, reason: 'RUN_STATUS_FAILED', detail: 'temporal unavailable' }));",
    "  process.exit(1);",
    "} else {",
    "  console.log(JSON.stringify({ ok: true, runId: run, phase: 'AWAITING_SKETCH_APPROVAL', status: 'blocked', card: { questionId: 'sketch-approval', revision: 1 } }));",
    "}",
  ].join("\n"), "utf8");
  return stub;
}

/** Stub decide CLI: records argv, emits a receipt or failure JSON line. */
async function writeDecideStub(dir: string): Promise<string> {
  const stub = join(dir, "approve-run-stub.mjs");
  await writeFile(stub, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(process.argv.slice(2)));",
    "if (process.env.STUB_MODE === 'no-card') {",
    "  console.log(JSON.stringify({ ok: false, reason: 'no-open-card', phase: 'MODULE_DESIGN', detail: '' }));",
    "  process.exit(1);",
    "}",
    "console.log(JSON.stringify({ ok: true, receipt: { accepted: true, decisionId: 'dec-approve-1-x', decision: 'approve', revision: 1 } }));",
  ].join("\n"), "utf8");
  return stub;
}

describe("buildApp pipeline status/decision routes", () => {
  let workDir: string;
  let statusStub: string;
  let decideStub: string;
  let stubMode: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pi-web-pipeline-command-test-"));
    statusStub = await writeStatusStub(workDir);
    decideStub = await writeDecideStub(workDir);
    stubMode = process.env["STUB_MODE"];
    process.env["STUB_ARGV_OUT"] = join(workDir, "argv.json");
  });

  afterEach(async () => {
    process.env["STUB_MODE"] = stubMode;
    await rm(workDir, { recursive: true, force: true });
  });

  function stubCommands(): void {
    appTestContext.pipelineCommands = new ChildPipelineCommandClient({ statusScript: statusStub, decideScript: decideStub });
  }

  it("GET status returns the CLI's last JSON line", async () => {
    stubCommands();
    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs/run-42/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, view: { runId: "run-42", phase: "AWAITING_SKETCH_APPROVAL" } });
  });

  it("GET status maps a CLI failure JSON to ok:false", async () => {
    process.env["STUB_MODE"] = "fail";
    stubCommands();
    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs/run-42/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, reason: "RUN_STATUS_FAILED", detail: "temporal unavailable" });
  });

  it("GET status rejects an invalid runId without spawning", async () => {
    let spawned = 0;
    appTestContext.pipelineCommands = { status: () => { spawned += 1; return Promise.resolve({ ok: true, view: {} }); }, decide: () => Promise.resolve({ ok: true, receipt: {} }) };
    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs/bad%2Fid/status" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(spawned).toBe(0);
  });

  it("POST decision submits approve with the default actor", async () => {
    stubCommands();
    const response = await appTestContext.app.inject({ method: "POST", url: "/api/pipeline-runs/run-42/decision", payload: { decision: "approve", card: binding } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, receipt: { accepted: true, decision: "approve" } });
    const argvOut = process.env["STUB_ARGV_OUT"];
    if (argvOut === undefined) throw new Error("stub argv output path not configured");
    expect(JSON.parse(await readFile(argvOut, "utf8"))).toEqual(["--run", "run-42", "--decision", "approve", "--actor", "rbowen", "--binding", JSON.stringify({ executionRunId: binding.rootExecutionId, cardExecutionRunId: binding.targetExecutionId, stage: binding.stage, questionId: binding.questionId, revision: binding.revision, artifactSha256: binding.artifactSha256 })]);
  });

  it("POST decision maps no-open-card to a typed failure", async () => {
    process.env["STUB_MODE"] = "no-card";
    stubCommands();
    const response = await appTestContext.app.inject({ method: "POST", url: "/api/pipeline-runs/run-42/decision", payload: { decision: "revise", card: binding } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, reason: "no-open-card", detail: "" });
  });

  it("POST decision rejects an invalid body without spawning", async () => {
    let spawned = 0;
    appTestContext.pipelineCommands = { status: () => Promise.resolve({ ok: true, view: {} }), decide: () => { spawned += 1; return Promise.resolve({ ok: true, receipt: {} }); } };
    const response = await appTestContext.app.inject({ method: "POST", url: "/api/pipeline-runs/run-42/decision", payload: { decision: "maybe" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(spawned).toBe(0);
  });

  it("resolves the CLI scripts from PI_WEB_PIPELINE_STATUS and PI_WEB_PIPELINE_DECIDE", async () => {
    const previousStatus = process.env["PI_WEB_PIPELINE_STATUS"];
    const previousDecide = process.env["PI_WEB_PIPELINE_DECIDE"];
    process.env["PI_WEB_PIPELINE_STATUS"] = statusStub;
    process.env["PI_WEB_PIPELINE_DECIDE"] = decideStub;
    try {
      const client = new ChildPipelineCommandClient();
      await expect(client.status("run-9")).resolves.toMatchObject({ ok: true, view: { runId: "run-9", phase: "AWAITING_SKETCH_APPROVAL" } });
      await expect(client.decide("run-9", "approve", "rbowen", binding)).resolves.toMatchObject({ ok: true, receipt: { accepted: true } });
    } finally {
      if (previousStatus === undefined) delete process.env["PI_WEB_PIPELINE_STATUS"];
      else process.env["PI_WEB_PIPELINE_STATUS"] = previousStatus;
      if (previousDecide === undefined) delete process.env["PI_WEB_PIPELINE_DECIDE"];
      else process.env["PI_WEB_PIPELINE_DECIDE"] = previousDecide;
    }
  });
});

/** Fake pipeline worker for the SSE/artifact proxy routes: an HTTP server on
 * an ephemeral loopback port whose behavior each test sets via the handle
 * function. Requests are recorded for assertions. */
describe("buildApp pipeline event/artifact proxy routes", () => {
  let upstream: Server | undefined;
  let upstreamRequests: string[];
  let upstreamHeaders: Record<string, string | string[] | undefined>;
  let previousEventsUrl: string | undefined;

  async function startUpstream(handle: (request: { url: string | undefined; headers: Record<string, string | string[] | undefined> }, response: { setHeader: (name: string, value: string) => void; write: (chunk: string) => void; end: (chunk?: string) => void; statusCode: number }) => void): Promise<string> {
    upstreamRequests = [];
    upstreamHeaders = {};
    const server = createServer((request, response) => {
      upstreamRequests.push(request.url ?? "");
      upstreamHeaders = request.headers;
      handle({ url: request.url, headers: request.headers }, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    upstream = server;
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("upstream address missing");
    return `http://127.0.0.1:${String(address.port)}`;
  }

  beforeEach(() => {
    previousEventsUrl = process.env["PI_PIPELINE_EVENTS_URL"];
  });

  afterEach(async () => {
    if (previousEventsUrl === undefined) delete process.env["PI_PIPELINE_EVENTS_URL"];
    else process.env["PI_PIPELINE_EVENTS_URL"] = previousEventsUrl;
    await new Promise<void>((resolve, reject) => {
      if (upstream === undefined) { resolve(); return; }
      upstream.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
    upstream = undefined;
  });

  it("proxies /events frames verbatim with the SSE content type", async () => {
    process.env["PI_PIPELINE_EVENTS_URL"] = await startUpstream((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.write("id: 1\nevent: transition\ndata: {\"seq\":1}\n\n");
      response.write("id: 2\nevent: card\ndata: {\"seq\":2}\n\n");
      response.end();
    });

    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs/events" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe("id: 1\nevent: transition\ndata: {\"seq\":1}\n\nid: 2\nevent: card\ndata: {\"seq\":2}\n\n");
    expect(upstreamRequests).toEqual(["/events"]);
  });

  it("forwards the ?from= query and the Last-Event-ID header to the worker", async () => {
    process.env["PI_PIPELINE_EVENTS_URL"] = await startUpstream((_request, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.end();
    });

    await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs/events?from=7", headers: { "last-event-id": "7" } });

    expect(upstreamRequests).toEqual(["/events?from=7"]);
    expect(upstreamHeaders["last-event-id"]).toBe("7");
  });

  it("ends the SSE response when the pipeline worker is unreachable", async () => {
    // Port 1 on loopback is never listening: fetch fails fast with ECONNREFUSED.
    process.env["PI_PIPELINE_EVENTS_URL"] = "http://127.0.0.1:1";

    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs/events" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe("");
  });

  it("proxies artifact bytes with the upstream status and content type", async () => {
    const sha = "ab".repeat(32);
    process.env["PI_PIPELINE_EVENTS_URL"] = await startUpstream((_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.end("artifact bytes");
    });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/pipeline-runs/artifact/${sha}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toBe("artifact bytes");
    expect(upstreamRequests).toEqual([`/artifact/${sha}`]);
  });

  it("passes an upstream artifact miss (404) through", async () => {
    const sha = "cd".repeat(32);
    process.env["PI_PIPELINE_EVENTS_URL"] = await startUpstream((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.statusCode = 404;
      response.end("{\"ok\":false,\"reason\":\"not_found\"}");
    });

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/pipeline-runs/artifact/${sha}` });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("{\"ok\":false,\"reason\":\"not_found\"}");
  });

  it("rejects a non-hex sha256 with 400 without contacting the worker", async () => {
    process.env["PI_PIPELINE_EVENTS_URL"] = "http://127.0.0.1:1";

    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs/artifact/not-hex" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("reports the worker as unreachable when the artifact proxy cannot connect", async () => {
    const sha = "ef".repeat(32);
    process.env["PI_PIPELINE_EVENTS_URL"] = "http://127.0.0.1:1";

    const response = await appTestContext.app.inject({ method: "GET", url: `/api/pipeline-runs/artifact/${sha}` });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ ok: false, reason: "pipeline_unreachable" });
  });
});
