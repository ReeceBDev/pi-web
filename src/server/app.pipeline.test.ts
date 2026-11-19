import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import { ChildPipelineRunClient } from "./machines/pipelineRoutes.js";

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
