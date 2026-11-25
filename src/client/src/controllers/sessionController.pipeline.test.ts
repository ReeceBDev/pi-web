import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import type { AppState } from "../appState";
import type { ChatLine, PipelineDecisionCard } from "../components/shared";
import type { PipelineRunEventStream } from "../pipelineRunEvents";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import { emptyTranscriptApi as defaultApi, FakeSocket, oldSession, status, workspace, emptyPage } from "./sessionController.testSupport";

/** Pipeline starts publish the pending row synchronously; one macrotask lets
 * the launch request and its state updates settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A well-formed artifact digest as the wire contract carries it (64 hex). */
const SKETCH_SHA256 = "664ef46000aabbcc0011223344556677889900aabbccddeeff0011223344559";

/** Test double for the run-event stream (the production default is
 * openPipelineRunEventStream, one EventSource to /api/pipeline-runs/events).
 * push() feeds one frame's data JSON to the controller, the same call the
 * browser makes for every "transition" / "card" SSE event. */
class FakePipelineEventStream implements PipelineRunEventStream {
  constructor(private readonly onFrame: (data: string) => void) {}

  push(frame: unknown): void {
    this.onFrame(JSON.stringify(frame));
  }

  close(): void {
    // The controller stops reading on dispose; the fake holds no resources.
  }
}

/** One wire frame per the events contract served at /api/pipeline-runs/events:
 * data JSON shaped {seq, eventId, ts, aggregate:{type:"projectRun", id}, payload}. */
let frameSeq = 0;

function frame(runId: string, payload: Record<string, unknown>): unknown {
  frameSeq += 1;
  return {
    seq: frameSeq,
    eventId: `evt-${String(frameSeq)}`,
    ts: "2026-11-25T00:00:00.000Z",
    aggregate: { type: "projectRun", id: runId },
    payload,
  };
}

function startedFrame(runId: string, to: string): unknown {
  return frame(runId, { projectRunId: runId, from: "", to, reasonCode: "WorkflowStarted", lifecycle: "started" });
}

function finishedFrame(runId: string, closeStatus: string): unknown {
  return frame(runId, { projectRunId: runId, from: "MODULE_DESIGN", to: "CLOSED", reasonCode: closeStatus, lifecycle: "finished" });
}

function cardFrame(runId: string, state: "open" | "consumed" | "expired", revision = 1): unknown {
  return frame(runId, {
    kind: "card",
    projectRunId: runId,
    questionId: "sketch-approval",
    revision,
    state,
    stage: "sketches",
    ...(state === "open" ? { artifactSha256: SKETCH_SHA256 } : {}),
  });
}

function makeController(api: typeof defaultApi, initialState: AppState, deps: SessionControllerDependencies = {}): { controller: SessionController; streams: FakePipelineEventStream[]; state: AppState } {
  let state = initialState;
  const streams: FakePipelineEventStream[] = [];
  const controller = new SessionController(
    () => state,
    (patch) => { state = { ...state, ...patch }; },
    () => undefined,
    undefined,
    {
      api,
      socket: new FakeSocket(),
      createPipelineEventStream: (onFrame) => {
        const stream = new FakePipelineEventStream(onFrame);
        streams.push(stream);
        return stream;
      },
      ...deps,
    },
  );
  return { controller, streams, get state() { return state; } };
}

function texts(state: AppState): string[] {
  // Only the note lines; the run's card line is a pipelineCard part, not text.
  return state.messages.flatMap((line) => line.parts[0]?.type === "text" ? [line.parts[0].text] : []);
}

function cardLineOf(state: AppState): ChatLine {
  const line = state.messages.find((candidate) => candidate.parts[0]?.type === "pipelineCard");
  if (line === undefined) throw new Error("pipeline card line missing");
  return line;
}

function cardPartOf(state: AppState): { type: "pipelineCard"; runId: string; phase: string; closeStatus?: string; card?: PipelineDecisionCard } {
  const part = cardLineOf(state).parts[0];
  if (part?.type !== "pipelineCard") throw new Error("pipeline card part missing");
  return part;
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

  it("seeds the run's card row on the launch ack, before any event frame arrives", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await harness.controller.send("Build the flinger fix");
    await flush();

    // The ack alone plants the card row; no frame has been pushed yet.
    const part = cardPartOf(harness.state);
    expect(part.runId).toBe("run-42");
    expect(part.card).toBeUndefined();
    expect(part.phase).toBe("");
    // One subscription total: the stream opened once for the launched run.
    expect(harness.streams).toHaveLength(1);
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
    expect(texts(harness.state)).toEqual([
      "Build the flinger fix",
      "Pipeline run started · run-42 · decision cards post here",
    ]);
    expect(harness.state.clientQueuedSessionMessages[tempId ?? ""]).toBeUndefined();
  });

  it("makes the run appear on a started transition frame", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await harness.controller.send("Build the flinger fix");
    await flush();
    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");

    stream.push(startedFrame("run-42", "INTAKE"));

    expect(texts(harness.state)).toContain("Pipeline phase · INTAKE");
    expect(cardPartOf(harness.state).phase).toBe("INTAKE");
  });

  it("opens the decision card on a card frame", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await harness.controller.send("Build the flinger fix");
    await flush();
    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");

    stream.push(cardFrame("run-42", "open"));

    const part = cardPartOf(harness.state);
    expect(part.card?.questionId).toBe("sketch-approval");
    expect(part.card?.revision).toBe(1);
    expect(part.card?.stage).toBe("sketches");
    expect(part.card?.artifactSha256).toBe(SKETCH_SHA256);
  });

  it("clears the decision card when a consumed card frame settles the question", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await harness.controller.send("Build the flinger fix");
    await flush();
    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");

    stream.push(cardFrame("run-42", "open"));
    expect(cardPartOf(harness.state).card).toBeDefined();

    stream.push(cardFrame("run-42", "consumed"));
    expect(cardPartOf(harness.state).card).toBeUndefined();
  });

  it("closes the run on a finished transition frame", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await harness.controller.send("Build the flinger fix");
    await flush();
    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");

    stream.push(startedFrame("run-42", "INTAKE"));
    stream.push(cardFrame("run-42", "open"));
    stream.push(finishedFrame("run-42", "COMPLETED"));

    expect(texts(harness.state)).toContain("Pipeline run closed · COMPLETED");
    const part = cardPartOf(harness.state);
    // The finished frame carries the terminal status; the phase keeps the
    // last working phase (CLOSED is the closeStatus's business, not a phase).
    expect(part.phase).toBe("INTAKE");
    expect(part.closeStatus).toBe("COMPLETED");
    expect(part.card).toBeUndefined();
  });

  it("approves from the card buttons after a card frame and marks the card decided", async () => {
    const decisions: [string, string][] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-9" }),
      pipelineRunDecision: (runId, decision) => {
        decisions.push([runId, decision]);
        return Promise.resolve({ ok: true, receipt: { accepted: true, decision, decisionId: "dec-approve-1-x" } });
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await harness.controller.send("Create a simple hello world C# console application");
    await flush();
    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");
    stream.push(cardFrame("run-9", "open"));

    await harness.controller.submitPipelineDecision("approve");
    await flush();

    expect(decisions).toEqual([["run-9", "approve"]]);
    const lastNote = harness.state.messages.at(-1)?.parts[0];
    expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline decision accepted · approve · dec-approve-1-x");
    expect(cardPartOf(harness.state).card?.decided).toBe(true);
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
    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");
    stream.push(cardFrame("run-42", "open"));

    await harness.controller.selectSession(oldSession);
    await flush();
    await harness.controller.selectSession(row);
    await flush();

    expect(harness.state.selectedSession?.id).toBe(row.id);
    expect(texts(harness.state)).toEqual([
      "Build the flinger fix",
      "Pipeline run started · run-42 · decision cards post here",
    ]);
    // the card line survives the round trip from the in-memory run state
    expect(cardPartOf(harness.state).card?.questionId).toBe("sketch-approval");
  });

  it("answers a typed status send with the drives note instead of a status poll", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    await harness.controller.send("Build the flinger fix");
    await flush();
    await harness.controller.send("status");
    await flush();

    // The status command is gone with the polling path; free text gets the
    // honest note pointing at the run's decision cards.
    expect(texts(harness.state)).toContain("This chat drives the pipeline run · decide on the run's cards");
    expect(harness.state.clientQueuedSessionMessages[harness.state.selectedSession?.id ?? ""]).toBeUndefined();
  });

  it("submits a typed approve decision and renders the receipt", async () => {
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
    const lastNote = texts(harness.state).at(-1);
    expect(lastNote).toBe("Pipeline run started · run-7 · decision cards post here");
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
