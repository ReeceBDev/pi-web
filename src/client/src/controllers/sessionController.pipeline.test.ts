import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { emptyTranscriptApi as defaultApi, emptyPage, FakeSocket, oldSession, status, workspace, type AppState } from "./sessionController.testSupport";

/** Pipeline starts publish the pending row synchronously; one macrotask lets
 * the launch request and its state updates settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeController(api: typeof defaultApi, initialState: AppState): { controller: SessionController; state: AppState } {
  let state = initialState;
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    { api, socket: new FakeSocket() },
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
      "system:Pipeline run started · run-42",
    ]);
    expect(harness.state.clientQueuedSessionMessages[tempId ?? ""]).toBeUndefined();
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
    expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline run started · run-7");
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
});
