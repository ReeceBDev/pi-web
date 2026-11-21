import { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { ChildPipelineCommandClient, ChildPipelineRunClient, registerPipelineRoutes } from "./pipelineRoutes.js";

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


it("requires the reviewed card, pins status, and forwards the exact decision to the CLI", async () => {
  const execution = "01a1f777-e9fe-777d-b157-8cd6e797d35a";
  const card = { rootExecutionId: execution, targetExecutionId: execution, stage: "sketches",
    questionId: "sketch-approval", revision: 2, artifactSha256: "a".repeat(64) };
  const calls: string[][] = [];
  const commands = new ChildPipelineCommandClient({
    statusScript: "/offline/status.js",
    decideScript: "/offline/decide.js",
    spawnImpl: (_command, args) => {
      calls.push(args);
      const child = new ChildProcess();
      const stdout = new PassThrough();
      child.stdout = stdout;
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        stdout.end(JSON.stringify(args[0] === "/offline/status.js"
          ? { ok: true, phase: "CLOSED", finalPhase: "BUILD", status: "blocked", executionRunId: execution, result: { unit: "private" } }
          : { ok: true, receipt: { accepted: true } }));
        child.emit("close", 0);
      });
      return child;
    },
  });
  const app = Fastify();
  registerPipelineRoutes(app, { run: () => Promise.reject(new Error("offline: start forbidden")) }, commands);
  try {
    const reject = await app.inject({ method: "POST", url: "/api/pipeline-runs/run-1/decision", payload: { decision: "approve" } });
    expect(reject.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    const status = await app.inject({ method: "GET", url: "/api/pipeline-runs/run-1/status?execution=" + execution });
    expect(status.json()).toEqual({ ok: true, view: { ok: true, phase: "CLOSED", finalPhase: "BUILD", status: "blocked", executionRunId: execution } });
    const submit = await app.inject({ method: "POST", url: "/api/pipeline-runs/run-1/decision", payload: { decision: "approve", actor: "ignored", card } });
    expect(submit.json()).toEqual({ ok: true, receipt: { accepted: true } });
    expect(calls[0]).toEqual(["/offline/status.js", "--run", "run-1", "--execution", execution]);
    expect(calls[1]).toEqual(["/offline/decide.js", "--run", "run-1", "--decision", "approve", "--actor", "rbowen", "--card", JSON.stringify(card)]);
  } finally {
    await app.close();
  }
});
