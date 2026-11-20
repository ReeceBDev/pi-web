import { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { ChildPipelineRunClient, registerPipelineRoutes } from "./pipelineRoutes.js";

it("requires an identity and passes it from HTTP to CLI without replacing it on retries", async () => {
  const requestId = "d17e801d-4fe0-4fe3-860b-23805fa78819";
  const received: string[][] = [];
  const runner = new ChildPipelineRunClient({
    scriptPath: "/offline/start-run.js",
    spawnImpl: (_command, args) => {
      received.push(args);
      expect(readFileSync(args[args.indexOf("--goal-file") + 1] ?? "", "utf8")).toBe("Repair the parser");
      const child = new ChildProcess();
      const stdout = new PassThrough();
      child.stdout = stdout;
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        stdout.end(JSON.stringify({ ok: true, projectRunId: `run-${requestId}` }));
        child.emit("close", 0);
      });
      return child;
    },
  });
  const app = Fastify();
  registerPipelineRoutes(app, runner);
  try {
    for (const id of [undefined, "not-a-uuid"]) {
      const result = await app.inject({ method: "POST", url: "/api/pipeline-runs", payload: { requestId: id, repoPath: process.cwd(), goal: "Repair the parser" } });
      expect(result.statusCode).toBe(400);
    }
    expect(received).toHaveLength(0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await app.inject({ method: "POST", url: "/api/pipeline-runs", payload: { requestId, repoPath: process.cwd(), goal: "Repair the parser" } });
      expect(result.json()).toEqual({ ok: true, projectRunId: `run-${requestId}` });
    }
    expect(received).toHaveLength(2);
    for (const args of received) expect(args.slice(0, 5)).toEqual(["/offline/start-run.js", "--request-id", requestId, "--repo", process.cwd()]);
  } finally {
    await app.close();
  }
});
