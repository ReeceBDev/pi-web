import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import { createMemoryStorage } from "../cachedNewSessions";
import { setPipelineRunStorageOverrideForTests } from "../cachedPipelineRuns";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import { emptyTranscriptApi as defaultApi, emptyPage, FakeSocket, oldSession, status, workspace, type AppState } from "./sessionController.testSupport";

/** Pipeline starts publish the pending row synchronously; one macrotask lets
 * the launch request and its state updates settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeController(api: typeof defaultApi, initialState: AppState, deps: SessionControllerDependencies = {}): { controller: SessionController; state: AppState } {
  let state = initialState;
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket(), ...deps },
  );
  return { controller, get state() { return state; } };
}

describe("SessionController pipeline launches (+ New Work)", () => {
  it("opens the chat row instantly on the repo workspace without supervisor or backend session calls", async () => {
    const calls = { supervisorUnit: 0, supervisorCreateUnit: 0, startSession: 0, pipelineRun: 0 };
    const api: typeof defaultApi = {
      ...defaultApi,
      supervisorUnit: () => { calls.supervisorUnit += 1; return Promise.resolve({}); },
      supervisorCreateUnit: () => { calls.supervisorCreateUnit += 1; return Promise.resolve({ unitName: "pi-1", worktreePath: "/units/pi-1/worktrees/primary" }); },
      startSession: () => { calls.startSession += 1; return Promise.resolve(oldSession); },
      pipelineRun: () => { calls.pipelineRun += 1; return Promise.resolve({ ok: true, projectRunId: "run-1" }); },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    const row = harness.state.selectedSession;

    expect(row?.id).toMatch(/^creating:[0-9a-f]{32}$/);
    expect(row?.cwd).toBe("/repo");
    expect(harness.state.activity).toMatchObject({ sessionId: row?.id, phase: "active" });
    // the row must not claim a backend session is booting — nothing starts
    // until the first message is sent
    expect(harness.state.activity).toMatchObject({ label: "Pipeline launch pending" });
    expect(JSON.stringify(harness.state.activity)).not.toContain("backend session");
    expect(calls).toEqual({ supervisorUnit: 0, supervisorCreateUnit: 0, startSession: 0, pipelineRun: 0 });
  });

  it("sends the first message to the pipeline route and renders the ack as a system note", async () => {
    const promptCalls: string[] = [];
    let pipelineRunCalls = 0;
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: (session) => { promptCalls.push(session.id); return Promise.resolve({ accepted: true }); },
      pipelineRun: (repoPath, goal) => {
        pipelineRunCalls += 1;
        expect(repoPath).toBe("/repo");
        expect(goal).toBe("Build the flinger fix");
        return Promise.resolve({ ok: true, projectRunId: "run-42" });
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    const tempId = harness.state.selectedSession?.id;
    await harness.controller.send("Build the flinger fix");
    await flush();

    expect(pipelineRunCalls).toBe(1);
    expect(promptCalls).toEqual([]);
    expect(harness.state.messages.map((line) => `${line.role}:${line.parts[0]?.type === "text" ? line.parts[0].text : "?"}`)).toEqual([
      "user:Build the flinger fix",
      "system:Pipeline run started · run-42 · decision cards post here",
    ]);
    expect(harness.state.clientQueuedSessionMessages[tempId ?? ""]).toBeUndefined();
  });

  it("keeps the launched chat when the user tabs away and back to the row", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    const row = harness.state.selectedSession;
    if (row === undefined) throw new Error("pending pipeline row missing");
    await harness.controller.send("Build the flinger fix");
    await flush();

    await harness.controller.selectSession(oldSession);
    await flush();
    await harness.controller.selectSession(row);
    await flush();

    expect(harness.state.selectedSession?.id).toBe(row.id);
    expect(harness.state.messages.map((line) => `${line.role}:${line.parts[0]?.type === "text" ? line.parts[0].text : "?"}`)).toEqual([
      "user:Build the flinger fix",
      "system:Pipeline run started · run-42 · decision cards post here",
    ]);
  });

  it("answers a status command against the launched run without queueing", async () => {
    const statusCalls: string[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
      pipelineRunStatus: (runId) => {
        statusCalls.push(runId);
        return Promise.resolve({ ok: true, view: { phase: "AWAITING_SKETCH_APPROVAL", card: { revision: 2 } } });
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    await harness.controller.send("Build the flinger fix");
    await flush();
    await harness.controller.send("status");
    await flush();

    expect(statusCalls).toEqual(["run-42", "run-42"]); // immediate poll + the typed status
    expect(harness.state.messages.map((line) => `${line.role}:${line.parts[0]?.type === "text" ? line.parts[0].text : "?"}`)).toEqual([
      "user:Build the flinger fix",
      "system:Pipeline run started · run-42 · decision cards post here",
      "system:?", // the live decision-card line (card fields incomplete → idle card)
      "user:status",
      "system:Pipeline status · run-42 · AWAITING_SKETCH_APPROVAL · card rev 2",
    ]);
    expect(harness.state.clientQueuedSessionMessages[harness.state.selectedSession?.id ?? ""]).toBeUndefined();
  });

  it("submits an approve decision and renders the receipt", async () => {
    const decisions: [string, string][] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
      pipelineRunDecision: (runId, decision) => {
        decisions.push([runId, decision]);
        return Promise.resolve({ ok: true, receipt: { accepted: true, decision, decisionId: "dec-approve-1-x" } });
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    await harness.controller.send("Build the flinger fix");
    await flush();
    await harness.controller.send("approve");
    await flush();

    expect(decisions).toEqual([["run-42", "approve"]]);
    const lastNote = harness.state.messages.at(-1)?.parts[0];
    expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline decision accepted · approve · dec-approve-1-x");
  });

  it("renders a typed decision failure (no open card)", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
      pipelineRunDecision: () => Promise.resolve({ ok: false, reason: "no-open-card", detail: "" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    await harness.controller.send("Build the flinger fix");
    await flush();
    await harness.controller.send("revise");
    await flush();

    const lastNote = harness.state.messages.at(-1)?.parts[0];
    expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline decision failed · no-open-card");
  });

  it("renders a failed launch and lets the next send retry", async () => {
    let pipelineRunCalls = 0;
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => {
        pipelineRunCalls += 1;
        return pipelineRunCalls === 1
          ? Promise.resolve({ ok: false, reason: "temporal_unreachable", detail: "connect ECONNREFUSED 127.0.0.1:7233" })
          : Promise.resolve({ ok: true, projectRunId: "run-7" });
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    await harness.controller.send("First attempt");
    await flush();

    const firstNote = harness.state.messages.at(-1)?.parts[0];
    expect(firstNote?.type === "text" && firstNote.text).toBe("Pipeline run failed · temporal_unreachable · connect ECONNREFUSED 127.0.0.1:7233");

    await harness.controller.send("Second attempt");
    await flush();

    expect(pipelineRunCalls).toBe(2);
    const lastNote = harness.state.messages.at(-1)?.parts[0];
    expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline run started · run-7 · decision cards post here");
  });

  it("keeps the plain (+ Non-Sandboxed) flow on the backend session path", async () => {
    const calls = { supervisorUnit: 0, startSession: 0, pipelineRun: 0 };
    const started = { ...oldSession, id: "started-session" };
    const api: typeof defaultApi = {
      ...defaultApi,
      supervisorUnit: () => { calls.supervisorUnit += 1; return Promise.resolve({}); },
      startSession: () => { calls.startSession += 1; return Promise.resolve(started); },
      pipelineRun: () => { calls.pipelineRun += 1; return Promise.resolve({ ok: true, projectRunId: "run-1" }); },
      transcriptSnapshot: (session) => Promise.resolve({ page: emptyPage, status: status(session.id), seq: 0, partial: null }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ plain: true });
    await flush();

    expect(calls).toEqual({ supervisorUnit: 0, startSession: 1, pipelineRun: 0 });
    expect(harness.state.selectedSession?.id).toBe("started-session");
  });

  it("keeps the default (unit) start flow untouched when the pipeline flag is absent", async () => {
    const calls = { supervisorUnit: 0, supervisorCreateUnit: 0, startSession: 0 };
    const started = { ...oldSession, id: "unit-session", cwd: "/units/pi-1/worktrees/primary" };
    const api: typeof defaultApi = {
      ...defaultApi,
      supervisorUnit: () => { calls.supervisorUnit += 1; return Promise.resolve({}); },
      supervisorCreateUnit: () => { calls.supervisorCreateUnit += 1; return Promise.resolve({ unitName: "pi-1", worktreePath: "/units/pi-1/worktrees/primary" }); },
      startSession: (_cwd, _machineId, startupToken) => { calls.startSession += 1; expect(startupToken).toBeDefined(); return Promise.resolve(started); },
      transcriptSnapshot: (session) => Promise.resolve({ page: emptyPage, status: status(session.id), seq: 0, partial: null }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession();
    await flush();

    expect(calls).toEqual({ supervisorUnit: 1, supervisorCreateUnit: 1, startSession: 1 });
    expect(harness.state.selectedSession?.id).toBe("unit-session");
  });

  it("restores a launched pipeline run row after a reload and keeps status working", async () => {
    const storage = createMemoryStorage();
    setPipelineRunStorageOverrideForTests(storage);
    const statusCalls: string[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve([]),
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-77" }),
      pipelineRunStatus: (runId) => { statusCalls.push(runId); return Promise.resolve({ ok: true, view: { phase: "INTAKE" } }); },
    };
    try {
      const first = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
      await first.controller.startSession({ pipeline: true });
      await flush();
      await first.controller.send("Build the flinger");
      await flush();
      expect(first.state.activity?.detail).toContain("run-77");
      first.controller.dispose(); // stop the launcher's poller before the reload leg

      // Reload: fresh controller (page state gone), same storage.
      const second = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
      await second.controller.refreshCurrentWorkspaceSessions();
      const restored = second.state.sessions.find((session) => session.id === "run-77");
      if (restored === undefined) throw new Error("restored pipeline row missing");
      expect(restored.firstMessage).toBe("Build the flinger");
      expect(restored.cwd).toBe("/repo");

      await second.controller.selectSession(restored);
      const seededCard = second.state.messages.find((line) => line.parts[0]?.type === "pipelineCard");
      expect(seededCard).toBeDefined(); // the live status card replaces the old reconnect note

      await second.controller.send("status");
      await flush();
      expect(statusCalls).toEqual(["run-77", "run-77", "run-77"]); // launch poll, restore poll, typed status
    } finally {
      setPipelineRunStorageOverrideForTests(undefined);
    }
  });

  it("renders the live decision card from the status poll and approves from the card, not typed text", async () => {
    const decisions: [string, string][] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-9" }),
      pipelineRunStatus: () => Promise.resolve({
        ok: true,
        view: { phase: "AWAITING_SKETCH_APPROVAL", card: { questionId: "sketch-approval", artifactSha256: "664e", revision: 1, stage: "sketches", artifact: "{\"goal\":\"hello world\"}" } },
      }),
      pipelineRunDecision: (runId, decision) => {
        decisions.push([runId, decision]);
        return Promise.resolve({ ok: true, receipt: { accepted: true, decision, decisionId: "dec-approve-1-x" } });
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await harness.controller.startSession({ pipeline: true });
      await flush();
      await harness.controller.send("Create a simple hello world C# console application");
      await new Promise((resolve) => setTimeout(resolve, 30));

      const cardLine = harness.state.messages.find((line) => line.parts[0]?.type === "pipelineCard");
      if (cardLine === undefined) throw new Error("decision card line missing");
      const part = cardLine.parts[0];
      if (part?.type !== "pipelineCard" || part.card === undefined) throw new Error("card part missing");
      expect(part.card.questionId).toBe("sketch-approval");
      expect(part.card.artifact).toContain("hello world");

      await harness.controller.submitPipelineDecision("approve");
      await flush();

      expect(decisions).toEqual([["run-9", "approve"]]);
      const lastNote = harness.state.messages.at(-1)?.parts[0];
      expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline decision accepted · approve · dec-approve-1-x");
      const decidedPart = harness.state.messages.find((line) => line.parts[0]?.type === "pipelineCard")?.parts[0];
      if (decidedPart?.type !== "pipelineCard" || decidedPart.card === undefined) throw new Error("card part missing after decide");
      expect(decidedPart.card.decided).toBe(true);
    } finally {
      harness.controller.dispose();
    }
  });

  it("renders pushed phases once and unsubscribes on closure", async () => {
    type Notify = Parameters<typeof defaultApi.pipelineRunEvents>[1];
    const push: { notify?: Notify } = {};
    const close = vi.fn();
    const read = vi.fn<typeof defaultApi.pipelineRunStatus>();
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-11" }),
      pipelineRunStatus: read,
      pipelineRunEvents: (_runId, notify) => { push.notify = notify; return close; },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await harness.controller.startSession({ pipeline: true });
      await harness.controller.send("Build the flinger fix");
      await flush();
      if (!push.notify) throw new Error("status stream was not opened");
      push.notify({ ok: true, view: { phase: "SKETCH", executionRunId: "current" } });
      push.notify({ ok: true, view: { phase: "MODULE_DESIGN", executionRunId: "current" } });
      push.notify({ ok: true, view: { phase: "MODULE_DESIGN", executionRunId: "current" } });
      push.notify({ ok: true, view: { phase: "CLOSED", closeStatus: "COMPLETED", executionRunId: "current" } });
      push.notify({ ok: true, view: { phase: "MODULE_DESIGN", executionRunId: "current" } });
      const texts = harness.state.messages.map((line) => line.parts[0]?.type === "text" ? line.parts[0].text : "");
      expect(texts.filter((line) => line === "Pipeline phase · MODULE_DESIGN")).toHaveLength(1);
      expect(texts).toContain("Pipeline run closed · COMPLETED");
      expect(close).toHaveBeenCalledOnce();
      expect(read).not.toHaveBeenCalled();
    } finally { harness.controller.dispose(); }
  });

  it("reports a missing workflow after a one-shot read", async () => {
    const statusCalls: string[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-12" }),
      pipelineRunStatus: (runId) => {
        statusCalls.push(runId);
        return Promise.resolve({ ok: false, reason: "RUN_STATUS_FAILED", detail: "workflow not found for ID: run-12" });
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await harness.controller.startSession({ pipeline: true });
      await harness.controller.send("Build the thing");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await flush();

      const texts = harness.state.messages.map((line) => line.parts[0]?.type === "text" ? line.parts[0].text : "");
      expect(texts).toContain("Pipeline run not found");
      const callsAtStop = statusCalls.length;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(statusCalls.length).toBe(callsAtStop); // no retries against a deleted workflow
    } finally {
      harness.controller.dispose();
    }
  });

  it("reads once when no event transport is available", async () => {
    const read = vi.fn<typeof defaultApi.pipelineRunStatus>()
      .mockResolvedValue({ ok: false, reason: "STATUS_READ_TIMEOUT", detail: "" });
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-13" }),
      pipelineRunStatus: read,
      pipelineRunEvents: () => undefined,
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await harness.controller.startSession({ pipeline: true });
      await harness.controller.send("Build the thing");
      await flush();
      expect(read).toHaveBeenCalledExactlyOnceWith("run-13");
    } finally { harness.controller.dispose(); }
  });
});
