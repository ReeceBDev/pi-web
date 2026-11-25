import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLine } from "../components/shared";
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

const execution = "01a1f777-e9fe-777d-b157-8cd6e797d35a";
const binding = {
  rootExecutionId: execution, targetExecutionId: execution, stage: "sketches" as const,
  questionId: "sketch-approval", revision: 1, artifactSha256: "a".repeat(64),
};
const openView = { phase: "AWAITING_SKETCH_APPROVAL", executionRunId: execution, card: { ...binding, artifact: "hello world" } };

describe("SessionController pipeline launches (+ New Work)", () => {
  beforeEach(() => { setPipelineRunStorageOverrideForTests(createMemoryStorage()); });
  afterEach(() => { setPipelineRunStorageOverrideForTests(undefined); });
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
      pipelineRunStatus: () => Promise.resolve({ ok: true, view: openView }),
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
      "system:?",
    ]);
    expect(harness.state.clientQueuedSessionMessages[tempId ?? ""]).toBeUndefined();
  });

  it("keeps the launched chat when the user tabs away and back to the row", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRunStatus: () => Promise.resolve({ ok: true, view: openView }),
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
      "system:?",
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

    expect(statusCalls).toEqual(["run-42"]); // status reuses the current observation
    expect(harness.state.messages.map((line) => `${line.role}:${line.parts[0]?.type === "text" ? line.parts[0].text : "?"}`)).toEqual([
      "user:Build the flinger fix",
      "system:Pipeline run started · run-42 · decision cards post here",
      "system:?", // the live decision-card line (card fields incomplete → idle card)
      "user:status",
      "system:Pipeline status · run-42 · AWAITING_SKETCH_APPROVAL · card rev 2",
    ]);
    expect(harness.state.clientQueuedSessionMessages[harness.state.selectedSession?.id ?? ""]).toBeUndefined();
  });

  it("shows the original queue wait in the live card and in a typed status reply", async () => {
    const detail = "Waiting for the first workflow task. Temporal reports no recent workflow poller on queue-a.";
    const harness = makeController({
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
      pipelineRunStatus: () => Promise.resolve({ ok: true, view: { phase: "WAITING_FOR_WORKER", detail } }),
    }, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await harness.controller.startSession({ pipeline: true });
      await harness.controller.send("Build the sample");
      await flush();
      await harness.controller.send("status");
      await flush();
      const parts = harness.state.messages.flatMap(message => message.parts);
      expect(parts).toContainEqual(expect.objectContaining({ type: "pipelineCard", phase: "WAITING_FOR_WORKER", detail }));
      expect(parts).toContainEqual(expect.objectContaining({ type: "text", text: "Pipeline status · run-42 · WAITING_FOR_WORKER · " + detail }));
    } finally {
      harness.controller.dispose();
    }
  });

  it("submits an approve decision and renders the receipt", async () => {
    const decisions: [string, string][] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
      pipelineRunStatus: () => Promise.resolve({ ok: true, view: openView }),
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
    expect(lastNote?.type === "text" && lastNote.text).toBe("Open and review the current decision card before deciding.");
  });

  it("retries a failed launch with the same persisted identity and original goal", async () => {
    const requestIds: string[] = [];
    let pipelineRunCalls = 0;
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: (_repoPath, goal, requestId) => {
        requestIds.push(requestId);
        expect(goal).toBe("First attempt");
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

    await harness.controller.send("First attempt");
    await flush();

    expect(pipelineRunCalls).toBe(2);
    expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(harness.state.messages.some((line) => line.parts[0]?.type === "text" && line.parts[0].text === "Pipeline run started · run-7 · decision cards post here")).toBe(true);
  });

  it("restores an uncertain submission after reload without sending, then retries the same identity", async () => {
    const ids: string[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve([]),
      pipelineRun: (_repoPath, goal, requestId) => {
        expect(goal).toBe("Repair the parser");
        ids.push(requestId);
        if (ids.length === 1) return Promise.reject(new Error("response lost"));
        return Promise.resolve({ ok: true, projectRunId: `run-${requestId}` });
      },
    };
    const first = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    await first.controller.startSession({ pipeline: true });
    await first.controller.send("Repair the parser");
    await flush();

    const second = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    await second.controller.refreshCurrentWorkspaceSessions();
    const restored = second.state.sessions.find((row) => row.id === `run-${ids[0] ?? ""}`);
    if (restored === undefined) throw new Error("uncertain submission was lost on reload");
    await second.controller.selectSession(restored);
    expect(ids).toHaveLength(1);
    await second.controller.send("A different task");
    await flush();
    expect(ids).toHaveLength(1);
    await second.controller.send("Repair the parser");
    await flush();
    expect(ids).toEqual([ids[0], ids[0]]);
    expect(second.state.activity?.detail).toContain(`run-${ids[0] ?? ""}`);
  });

  it("does not send when the submission identity cannot be saved", async () => {
    const storage = createMemoryStorage();
    storage.setItem = () => { throw new Error("storage full"); };
    setPipelineRunStorageOverrideForTests(storage);
    let calls = 0;
    const harness = makeController({ ...defaultApi, pipelineRun: () => { calls++; return Promise.resolve({ ok: true, projectRunId: "unreachable" }); } }, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    await harness.controller.startSession({ pipeline: true });
    await harness.controller.send("Repair the parser");
    await flush();
    expect(calls).toBe(0);
    const note = harness.state.messages.at(-1)?.parts[0];
    expect(note?.type === "text" && note.text).toContain("Could not save this submission");
    expect(harness.state.clientQueuedSessionMessages[harness.state.selectedSession?.id ?? ""] ?? []).toHaveLength(0);
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
      expect(statusCalls).toEqual(["run-77", "run-77"]); // launch and restore polls
    } finally {
      setPipelineRunStorageOverrideForTests(undefined);
    }
  });

  it("reopens the saved conversation while status is offline and keeps each question and edit once", async () => {
    const activity = { id: "pair/entry/0", role: "worker", timestamp: "2026-11-20T12:34:56Z", summary: "Editing src/main.ts" };
    let module = false;
    const api: typeof defaultApi = { ...defaultApi, sessions: () => Promise.resolve([]),
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-history", executionRunId: execution }),
      pipelineRunStatus: () => Promise.resolve({ ok: true, view: { ...openView, agentActivity: [activity],
        card: module ? { ...openView.card, stage: "modules", revision: 2, questionId: "module-split", artifact: "Two modules" } : openView.card } }),
    };
    const state = () => ({ ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] });
    let push: (() => void) | undefined;
    const first = makeController({ ...api, pipelineRunEvents: (run, pinned, receive) => {
      push = () => { void api.pipelineRunStatus(run, pinned).then(receive); };
      push();
      return () => { push = undefined; };
    } }, state());
    const second = makeController({ ...api, pipelineRunStatus: () => Promise.reject(new Error("status offline")) }, state());
    try {
      await first.controller.startSession({ pipeline: true });
      await first.controller.send("Build the parser");
      await vi.waitFor(() => { expect(first.state.messages.some(row => row.parts[0]?.type === "pipelineCard")).toBe(true); });
      await first.controller.send("status");
      module = true;
      push?.();
      await vi.waitFor(() => { expect(first.state.messages.filter(row => row.parts[0]?.type === "pipelineCard")).toHaveLength(2); });
      const saved = first.state.messages.map(row => [row.pipelineId, row.meta?.timestamp]);
      expect(saved.every(([id, time]) => typeof id === "string" && typeof time === "string")).toBe(true);
      expect(saved.filter(([id]) => id === "activity:" + activity.id)).toEqual([["activity:" + activity.id, activity.timestamp]]);
      first.controller.dispose();
      await second.controller.refreshCurrentWorkspaceSessions();
      const restored = second.state.sessions.find(row => row.id === "run-history");
      if (!restored) throw new Error("saved run missing");
      await second.controller.selectSession(restored);
      await second.controller.selectSession(oldSession);
      await second.controller.selectSession(restored);
      expect(second.state.messages.map(row => [row.pipelineId, row.meta?.timestamp])).toEqual(saved);
      const cards = second.state.messages.flatMap(row => row.parts).filter(part => part.type === "pipelineCard");
      expect(cards.map(part => part.card?.artifact)).toEqual(["hello world", "Two modules"]);
      expect(cards.every(part => part.card?.historical === true)).toBe(true);
    } finally { first.controller.dispose(); second.controller.dispose(); }
  });

  it("restores server messages when the browser chat cache is empty and status cannot respond", async () => {
    const { serverPipelineRows } = await import("../cachedPipelineRuns");
    const run = "run-reopen", timestamp = "2026-11-20T16:00:00Z";
    const saved = { role: "system" as const, pipelineId: "event-7", pipelineOrder: 7, meta: { timestamp }, parts: [{ type: "text" as const, text: "Worker finished writing src/main.ts" }] };
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve(serverPipelineRows([{ runId: run, requestId: "request-1", cwd: workspace.path, goal: "Write the app", created: timestamp }], workspace.path)),
      pipelineRunStatus: () => new Promise(() => { /* simulate a status request that never completes */ }),
    };
    const loaded: string[] = [];
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] }, {
      pipelineHistory: { load: id => { loaded.push(id); return Promise.resolve([saved]); }, save: () => Promise.resolve() },
    });
    try {
      await harness.controller.refreshCurrentWorkspaceSessions();
      const row = harness.state.sessions.find(candidate => candidate.id === run);
      if (!row) throw new Error("persisted chat missing from catalog");
      await harness.controller.selectSession(row);
      await vi.waitFor(() => { expect(harness.state.messages.some(line => line.pipelineId === saved.pipelineId && line.meta?.timestamp === timestamp)).toBe(true); });
      expect(loaded).toEqual([run]);
    } finally { harness.controller.dispose(); }
  });

  it("preserves the saved card timestamp when live status arrives before its history page", async () => {
    const { serverPipelineRows } = await import("../cachedPipelineRuns");
    const run = "run-card-time", timestamp = "2026-11-19T14:33:22Z";
    let finish: (rows: ChatLine[]) => void = () => { throw new Error("history was not requested"); };
    const history = new Promise<ChatLine[]>(resolve => { finish = resolve; });
    const api: typeof defaultApi = { ...defaultApi,
      sessions: () => Promise.resolve(serverPipelineRows([{ runId: run, cwd: workspace.path, goal: "Write the app", created: timestamp }], workspace.path)),
      pipelineRunStatus: () => Promise.resolve({ ok: true, view: openView }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] }, {
      pipelineHistory: { load: () => history, save: () => Promise.resolve() },
    });
    try {
      await harness.controller.refreshCurrentWorkspaceSessions();
      const session = harness.state.sessions.find(candidate => candidate.id === run);
      if (!session) throw new Error("saved chat missing");
      await harness.controller.selectSession(session);
      await vi.waitFor(() => { expect(harness.state.messages.some(row => row.parts[0]?.type === "pipelineCard")).toBe(true); });
      const shown = harness.state.messages.find(row => row.parts[0]?.type === "pipelineCard");
      if (!shown) throw new Error("live card missing");
      finish([{ ...shown, meta: { timestamp }, pipelineOrder: Date.parse(timestamp) * 1000, pipelineVersion: 1 }]);
      await vi.waitFor(() => {
        const cards = harness.state.messages.filter(row => row.parts[0]?.type === "pipelineCard");
        expect(cards).toHaveLength(1);
        expect(cards[0]?.meta?.timestamp).toBe(timestamp);
        expect(cards[0]?.parts[0]).toMatchObject({ card: { binding }, stale: false });
      });
    } finally { harness.controller.dispose(); }
  });

  it("renders the live decision card from the status response and approves from the card, not typed text", async () => {
    const decisions: [string, string][] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-9" }),
      pipelineRunStatus: () => Promise.resolve({
        ok: true,
        view: openView,
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

      await harness.controller.submitPipelineDecision("approve", "run-9", binding);
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

  it("retries the exact saved approval after a lost response, reload, and terminal status", async () => {
    const seen: unknown[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve([]),
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-approval", executionRunId: execution }),
      pipelineRunStatus: (_run, pinned) => {
        expect(pinned).toBe(execution);
        return Promise.resolve({ ok: true, view: seen.length === 0 ? openView : {
          phase: "CLOSED", closeStatus: "COMPLETED", status: "completed",
          finalPhase: "SUBMITTED", executionRunId: execution, delivery: { buildDigest: "commit", reportDigest: "report", diff: "+hello" },
        } });
      },
      pipelineRunDecision: (run, decision, card) => {
        seen.push([run, decision, card]);
        return seen.length === 1
          ? Promise.reject(new Error("response lost"))
          : Promise.resolve({ ok: true, receipt: { accepted: true, decision, decisionId: "durable" } });
      },
    };
    const first = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    const second = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await first.controller.startSession({ pipeline: true });
      await first.controller.send("Repair the parser");
      await flush();
      expect(first.state.selectedSession?.id).toBe("run-approval");
      await first.controller.submitPipelineDecision("approve", "run-approval", { ...binding, revision: 9 });
      expect(seen).toEqual([]);
      await first.controller.submitPipelineDecision("approve", "run-approval", binding);
      await second.controller.refreshCurrentWorkspaceSessions();
      const row = second.state.sessions.find((entry) => entry.id === "run-approval");
      if (!row) throw new Error("saved pipeline row not restored");
      await second.controller.selectSession(row);
      await flush();
      const cards = second.state.messages.flatMap(line => line.parts).filter(part => part.type === "pipelineCard");
      expect(cards[0]).toMatchObject({ card: { binding, historical: true } });
      expect(cards.find(part => part.phase === "CLOSED"))
        .toMatchObject({ delivery: { diff: "+hello" }, retry: { decision: "approve", binding } });
      await second.controller.submitPipelineDecision("approve", "run-approval", binding);
      expect(seen).toEqual([["run-approval", "approve", binding], ["run-approval", "approve", binding]]);
    } finally {
      first.controller.dispose();
      second.controller.dispose();
    }
  });

  it("notes phase transitions and stops polling once the run closes", async () => {
    const views: Record<string, unknown>[] = [
      { phase: "INTAKE" },
      { phase: "MODULE_DESIGN" },
      { phase: "CLOSED", closeStatus: "COMPLETED" },
    ];
    let closed = false;
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-11" }),
      pipelineRunEvents: (_run, _execution, receive) => {
        queueMicrotask(() => { for (const view of views) receive({ ok: true, view }); });
        return () => { closed = true; };
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await harness.controller.startSession({ pipeline: true });
      await harness.controller.send("Build the flinger fix");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await flush();

      const texts = harness.state.messages.map((line) => line.parts[0]?.type === "text" ? line.parts[0].text : "");
      expect(texts).toContain("Pipeline phase · MODULE_DESIGN");
      expect(texts).toContain("Pipeline run closed · COMPLETED");
      expect(closed).toBe(true);
    } finally {
      harness.controller.dispose();
    }
  });
});;
