import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { PipelineChatStore } from "../storage/pipelineChatStore.js";
import { registerPipelineRoutes } from "./pipelineRoutes.js";

it("reads the saved conversation and catalog after reopening the store without querying or starting a workflow", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-store-"));
  const file = join(dir, "history.sqlite");
  const id = "run-offline", request = "d17e801d-4fe0-4fe3-860b-23805fa78819";
  const runner = { run: () => { throw new Error("no workflow allowed"); } };
  const first = new PipelineChatStore(file);
  first.register(id, request, "/sample", "Build the parser");
  first.register("run-other", "other", "/elsewhere", "Different project");
  const app = Fastify();
  registerPipelineRoutes(app, runner, undefined, first);
  const message = { role: "user", pipelineId: "status-1", pipelineOrder: 2, pipelineVersion: 2, meta: { timestamp: "2026-11-20T23:00:00Z" }, parts: [{ type: "text", text: "status" }] };
  try {
    for (let index = 0; index < 2; index++) {
      const response = await app.inject({ method: "POST", url: "/api/pipeline-runs/" + id + "/transcript", payload: { lines: [message] } });
      expect(response.statusCode).toBe(200);
    }
    const invalid = await app.inject({ method: "POST", url: "/api/pipeline-runs/" + id + "/transcript",
      payload: { lines: [{ ...message, parts: [{ type: "thinking", text: "private" }] }] } });
    expect(invalid.statusCode).toBe(400);
    const approval = { type: "pipelineCard", runId: id, phase: "SKETCHES", privateTrace: "omitted",
      card: { questionId: "sketch", revision: 1, artifactSha256: "a".repeat(64), artifact: "Draft" } };
    const card = { ...message, role: "system", pipelineId: "card:sketch", parts: [approval] };
    for (const [version, decided] of [[3, false], [8, true], [5, false]] as const) {
      const response = await app.inject({ method: "POST", url: "/api/pipeline-runs/" + id + "/transcript",
        payload: { lines: [{ ...card, pipelineVersion: version, parts: [{ ...approval, card: { ...approval.card, decided } }] }] } });
      expect(response.statusCode).toBe(200);
    }
    await app.close();
    const reopened = Fastify();
    registerPipelineRoutes(reopened, runner, undefined, new PipelineChatStore(file));
    try {
      const content = await reopened.inject({ method: "GET", url: "/api/pipeline-runs/" + id + "/transcript" });
      expect(content.json()).toMatchObject({ next: null, lines: [
        { pipelineId: "goal", parts: [{ text: "Build the parser" }] }, message,
        { pipelineId: "card:sketch", pipelineVersion: 8, parts: [{ card: { decided: true, artifact: "Draft" } }] },
      ] });
      expect(content.payload).not.toContain("privateTrace");
      const catalog = await reopened.inject({ method: "GET", url: "/api/pipeline-chats?cwd=%2Fsample" });
      expect(catalog.json()).toEqual([expect.objectContaining({ runId: id, requestId: request, cwd: "/sample" })]);
      expect((await reopened.inject({ url: "/api/pipeline-runs/missing/transcript" })).statusCode).toBe(404);
    } finally { await reopened.close(); }
  } finally { await app.close(); rmSync(dir, { force: true, recursive: true }); }
});

it("keeps the submitted identity retryable when chat registration cannot persist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-save-"));
  const store = new PipelineChatStore(join(dir, "history.sqlite"));
  const register = store.register.bind(store);
  let unavailable = true;
  store.register = (...args) => {
    if (unavailable) throw new Error("storage temporarily unavailable");
    register(...args);
  };
  const app = Fastify();
  const run = "run-existing";
  const runner = { run: () => Promise.resolve({ ok: true as const, projectRunId: run }) };
  registerPipelineRoutes(app, runner, undefined, store);
  const payload = { requestId: "d17e801d-4fe0-4fe3-860b-23805fa78819", goal: "Build the parser", repoPath: dir };
  try {
    const first = await app.inject({ method: "POST", url: "/api/pipeline-runs", payload });
    expect(first.json()).toMatchObject({ ok: false, reason: "chat_save_pending" });
    unavailable = false;
    const next = await app.inject({ method: "POST", url: "/api/pipeline-runs", payload });
    expect(next.json()).toEqual({ ok: true, projectRunId: run });
    expect(store.list(dir)).toHaveLength(1);
  } finally { await app.close(); rmSync(dir, { force: true, recursive: true }); }
});
