import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import { ChildPipelineCommandClient, ChildPipelineRunClient } from "./machines/pipelineRoutes.js";

registerAppTestHooks();

/** Stub start-run CLI: records argv + goal-file content, then succeeds or
 * fails depending on STUB_MODE (the child inherits this process's env). */
async function writeStubScript(dir: string): Promise<string> {
  const stub = join(dir, "start-run-stub.mjs");
  await writeFile(stub, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const argvFile = process.env.STUB_ARGV_OUT;",
    "const argv = process.argv.slice(2);",
    "const goalFileIndex = argv.indexOf('--goal-file');",
    "const goal = goalFileIndex >= 0 ? readFileSync(argv[goalFileIndex + 1], 'utf8') : '';",
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
      payload: { repoPath: workDir, goal: "Ship the flinger fix", sketches: [join(workDir, "sketch.png")] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, projectRunId: "run-123" });
    const argvOut = process.env["STUB_ARGV_OUT"];
    if (argvOut === undefined) throw new Error("stub argv output path not configured");
    const recorded: unknown = JSON.parse(await readFile(argvOut, "utf8"));
    expect(recorded).toMatchObject({
      argv: ["--repo", workDir, "--goal-file", expect.stringMatching(/goal\.txt$/), "--sketch", join(workDir, "sketch.png"), "--actor", "rbowen"],
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
      payload: { repoPath: workDir, goal: `Use ${existing} and /definitely/missing.md as context` },
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
      payload: { repoPath: workDir, goal: "Ship the flinger fix" },
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
      payload: { repoPath: "relative/path", goal: "Ship it" },
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
      payload: { repoPath: "/definitely/not/a/repo", goal: "Ship it" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("rejects an empty goal", async () => {
    appTestContext.pipelineRunner = { run: () => Promise.resolve({ ok: true, projectRunId: "run-x" }) };

    const response = await appTestContext.app.inject({
      method: "POST",
      url: "/api/pipeline-runs",
      payload: { repoPath: workDir, goal: "   " },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("resolves the CLI script from PI_WEB_PIPELINE_START_RUN", async () => {
    const previous = process.env["PI_WEB_PIPELINE_START_RUN"];
    process.env["PI_WEB_PIPELINE_START_RUN"] = stubPath;
    try {
      const client = new ChildPipelineRunClient();
      const result = await client.run({ repoPath: workDir, goal: "env override" });
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
    appTestContext.pipelineCommands = { status: () => { spawned += 1; return Promise.resolve({ ok: true, view: {} }); }, decide: () => Promise.resolve({ ok: true, receipt: {} }), list: () => Promise.resolve({ ok: true, runs: [] }) };
    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs/bad%2Fid/status" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(spawned).toBe(0);
  });

  it("POST decision submits approve with the default actor", async () => {
    stubCommands();
    const response = await appTestContext.app.inject({ method: "POST", url: "/api/pipeline-runs/run-42/decision", payload: { decision: "approve" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, receipt: { accepted: true, decision: "approve" } });
    const argvOut = process.env["STUB_ARGV_OUT"];
    if (argvOut === undefined) throw new Error("stub argv output path not configured");
    expect(JSON.parse(await readFile(argvOut, "utf8"))).toEqual(["--run", "run-42", "--decision", "approve", "--actor", "rbowen"]);
  });

  it("POST decision maps no-open-card to a typed failure", async () => {
    process.env["STUB_MODE"] = "no-card";
    stubCommands();
    const response = await appTestContext.app.inject({ method: "POST", url: "/api/pipeline-runs/run-42/decision", payload: { decision: "revise", actor: "rbowen-delegated" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, reason: "no-open-card", detail: "" });
  });

  it("POST decision rejects an invalid body without spawning", async () => {
    let spawned = 0;
    appTestContext.pipelineCommands = { status: () => Promise.resolve({ ok: true, view: {} }), decide: () => { spawned += 1; return Promise.resolve({ ok: true, receipt: {} }); }, list: () => Promise.resolve({ ok: true, runs: [] }) };
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
      await expect(client.decide("run-9", "approve", "rbowen")).resolves.toMatchObject({ ok: true, receipt: { accepted: true } });
    } finally {
      if (previousStatus === undefined) delete process.env["PI_WEB_PIPELINE_STATUS"];
      else process.env["PI_WEB_PIPELINE_STATUS"] = previousStatus;
      if (previousDecide === undefined) delete process.env["PI_WEB_PIPELINE_DECIDE"];
      else process.env["PI_WEB_PIPELINE_DECIDE"] = previousDecide;
    }
  });
});

/** Stub list CLI: emits noise, then one JSON line depending on STUB_MODE. */
async function writeListStub(dir: string): Promise<string> {
  const stub = join(dir, "list-runs-stub.mjs");
  await writeFile(stub, [
    "console.log('listing temporal visibility');",
    "if (process.env.STUB_MODE === 'fail') {",
    "  console.log(JSON.stringify({ ok: false, reason: 'LIST_RUNS_FAILED', detail: 'temporal unavailable' }));",
    "  process.exit(1);",
    "}",
    "console.log(JSON.stringify({ ok: true, runs: [",
    "  { runId: 'run-1', goal: 'g', cwd: '/repo', created: '2026-11-24T05:32:33.946Z', status: 'RUNNING' },",
    "  { runId: 'run-legacy', goal: '(recovered)', created: '2026-11-24T05:32:00.000Z', status: 'COMPLETED' },",
    "] }));",
  ].join("\n"), "utf8");
  return stub;
}

describe("buildApp pipeline run-list route", () => {
  let workDir: string;
  let listStub: string;
  let stubMode: string | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pi-web-pipeline-list-test-"));
    listStub = await writeListStub(workDir);
    stubMode = process.env["STUB_MODE"];
  });

  afterEach(async () => {
    process.env["STUB_MODE"] = stubMode;
    await rm(workDir, { recursive: true, force: true });
  });

  it("GET /api/pipeline-runs returns the CLI's runs, cwd-less rows included", async () => {
    appTestContext.pipelineCommands = new ChildPipelineCommandClient({ listScript: listStub, statusScript: listStub, decideScript: listStub });

    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      runs: [
        { runId: "run-1", goal: "g", cwd: "/repo", created: "2026-11-24T05:32:33.946Z", status: "RUNNING" },
        { runId: "run-legacy", goal: "(recovered)", created: "2026-11-24T05:32:00.000Z", status: "COMPLETED" },
      ],
    });
  });

  it("GET /api/pipeline-runs maps a CLI failure JSON to ok:false", async () => {
    process.env["STUB_MODE"] = "fail";
    appTestContext.pipelineCommands = new ChildPipelineCommandClient({ listScript: listStub, statusScript: listStub, decideScript: listStub });

    const response = await appTestContext.app.inject({ method: "GET", url: "/api/pipeline-runs" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, reason: "LIST_RUNS_FAILED", detail: "temporal unavailable" });
  });

  it("resolves the list CLI from PI_WEB_PIPELINE_LIST", async () => {
    const previous = process.env["PI_WEB_PIPELINE_LIST"];
    process.env["PI_WEB_PIPELINE_LIST"] = listStub;
    try {
      const client = new ChildPipelineCommandClient({ statusScript: listStub, decideScript: listStub });
      await expect(client.list()).resolves.toEqual({
        ok: true,
        runs: [
          { runId: "run-1", goal: "g", cwd: "/repo", created: "2026-11-24T05:32:33.946Z", status: "RUNNING" },
          { runId: "run-legacy", goal: "(recovered)", created: "2026-11-24T05:32:00.000Z", status: "COMPLETED" },
        ],
      });
    } finally {
      if (previous === undefined) delete process.env["PI_WEB_PIPELINE_LIST"];
      else process.env["PI_WEB_PIPELINE_LIST"] = previous;
    }
  });
});
