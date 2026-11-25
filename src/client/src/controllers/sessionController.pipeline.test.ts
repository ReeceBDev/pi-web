import { describe, expect, it, vi } from "vitest";
import { initialAppState } from "../appState";
import type { AppState } from "../appState";
import type { ChatLine } from "../components/shared";
import type { PipelineRunEventStream } from "../pipelineRunEvents";
import { serverPipelineRows } from "../pipelineRunCatalog";
import type { PipelineApprovalBinding } from "../../../shared/pipelineApproval";
import { SessionController, type SessionControllerDependencies } from "./sessionController";
import { emptyTranscriptApi as defaultApi, FakeSocket, oldSession, status, workspace, emptyPage } from "./sessionController.testSupport";

/** Pipeline starts publish the pending row synchronously; one macrotask lets
 * the launch request and its state updates settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A well-formed artifact digest as the wire contract carries it (64 hex). */
const SKETCH_SHA256 = "664ef46000aabbcc0011223344556677889900aabbccddeeff0011223344559";

const execution = "01a1f777-e9fe-777d-b157-8cd6e797d35a";
const binding: PipelineApprovalBinding = {
  rootExecutionId: execution, targetExecutionId: execution, stage: "sketches",
  questionId: "sketch-approval", revision: 1, artifactSha256: "a".repeat(64),
};

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

function startedFrame(runId: string, to: string, detail?: string): unknown {
  return frame(runId, { projectRunId: runId, from: "", to, reasonCode: "WorkflowStarted", lifecycle: "started", ...(detail === undefined ? {} : { detail }) });
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

function cardPartOf(state: AppState) {
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
    // One subscription total: the stream opened once, on the controller boot.
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

  it("keeps the launched chat when the user tabs away and back to the row", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    await harness.controller.send("Build the flinger fix");
    await flush();
    // Capture the row AFTER the launch ack promoted it to its run id.
    const row = harness.state.selectedSession;
    if (row === undefined) throw new Error("pending pipeline row missing");
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

  it("answers a typed status send from the replayed event memory, and free text with the drives note", async () => {
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });

    await harness.controller.startSession({ pipeline: true });
    await flush();
    await harness.controller.send("Build the flinger fix");
    await flush();
    // No frames yet: the memory only knows the run exists.
    await harness.controller.send("status");
    await flush();
    expect(texts(harness.state)).toContain("Pipeline status · run-42 · UNKNOWN");

    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");
    stream.push(startedFrame("run-42", "AWAITING_SKETCH_APPROVAL"));
    stream.push(cardFrame("run-42", "open"));
    await harness.controller.send("status");
    await flush();
    // The status reply renders from the event memory; no status poll happens.
    expect(texts(harness.state)).toContain("Pipeline status · run-42 · AWAITING_SKETCH_APPROVAL");

    // Free text is not a pipeline command: it gets the honest drives note.
    await harness.controller.send("what about the build?");
    await flush();
    expect(texts(harness.state)).toContain("This chat drives the pipeline run · decide on the run's cards");
    expect(harness.state.clientQueuedSessionMessages[harness.state.selectedSession?.id ?? ""]).toBeUndefined();
  });

  it("shows the original queue wait in the live card and in a typed status reply", async () => {
    const detail = "Waiting for the first workflow task. Temporal reports no recent workflow poller on queue-a.";
    const harness = makeController({
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-42" }),
    }, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await harness.controller.startSession({ pipeline: true });
      await harness.controller.send("Build the sample");
      await flush();
      const stream = harness.streams[0];
      if (stream === undefined) throw new Error("pipeline event stream missing");
      stream.push(startedFrame("run-42", "WAITING_FOR_WORKER", detail));
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
    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");
    // A typed decide needs the open card memory the frames built.
    stream.push(cardFrame("run-42", "open"));
    await harness.controller.send("approve");
    await flush();

    expect(decisions).toEqual([["run-42", "approve"]]);
    const lastNote = harness.state.messages.at(-1)?.parts[0];
    expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline decision accepted · approve · dec-approve-1-x");
  });

  it("renders a typed decision failure when the server rejects the decision", async () => {
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
    const stream = harness.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");
    stream.push(cardFrame("run-42", "open"));
    await harness.controller.send("approve");
    await flush();

    const lastNote = harness.state.messages.at(-1)?.parts[0];
    expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline decision could not be confirmed · no-open-card");
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

    await harness.controller.submitPipelineDecision("approve", "run-9");
    await flush();

    expect(decisions).toEqual([["run-9", "approve"]]);
    const lastNote = harness.state.messages.at(-1)?.parts[0];
    expect(lastNote?.type === "text" && lastNote.text).toBe("Pipeline decision accepted · approve · dec-approve-1-x");
    expect(cardPartOf(harness.state).card?.decided).toBe(true);
  });

  it("retries an unconfirmed decision from the card's retry state in memory", async () => {
    const seen: unknown[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-approval" }),
      pipelineRunDecision: (run, decision, card) => {
        seen.push([run, decision, card]);
        return seen.length === 1
          ? Promise.reject(new Error("response lost"))
          : Promise.resolve({ ok: true, receipt: { accepted: true, decision, decisionId: "durable" } });
      },
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    try {
      await harness.controller.startSession({ pipeline: true });
      await harness.controller.send("Repair the parser");
      await flush();
      const stream = harness.streams[0];
      if (stream === undefined) throw new Error("pipeline event stream missing");
      stream.push(cardFrame("run-approval", "open"));

      // First decision is posted but its response is lost: the exact decision
      // stays on the card as the retry payload.
      await harness.controller.submitPipelineDecision("approve", "run-approval", binding);
      await flush();
      const lostNote = harness.state.messages.at(-1)?.parts[0];
      expect(lostNote?.type === "text" && lostNote.text).toBe("Pipeline decision acknowledgement pending · response lost");
      expect(cardPartOf(harness.state).retry).toMatchObject({ decision: "approve" });

      // Retrying posts the same decision-ONLY submission again.
      await harness.controller.submitPipelineDecision("approve", "run-approval", binding);
      await flush();
      expect(seen).toEqual([["run-approval", "approve", binding], ["run-approval", "approve", binding]]);
      const receiptNote = harness.state.messages.at(-1)?.parts[0];
      expect(receiptNote?.type === "text" && receiptNote.text).toBe("Pipeline decision accepted · approve · durable");
      expect(cardPartOf(harness.state).retry).toBeUndefined();
    } finally {
      harness.controller.dispose();
    }
  });

  it("retries a failed launch with the same submission identity and original goal", async () => {
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

  it("restores a launched pipeline run row after a reload from the server catalog", async () => {
    const created = "2026-11-20T10:00:00.000Z";
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve(serverPipelineRows([{ runId: "run-77", requestId: "req-77", cwd: workspace.path, goal: "Build the flinger", created }], workspace.path)),
      pipelineRun: () => Promise.resolve({ ok: true, projectRunId: "run-77" }),
    };
    const first = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    await first.controller.startSession({ pipeline: true });
    await flush();
    await first.controller.send("Build the flinger");
    await flush();
    expect(first.state.activity?.detail).toContain("run-77");
    first.controller.dispose(); // stop the launcher's poller before the reload leg

    // Reload: fresh controller (page state gone), run rows come back from the
    // server's durable chat catalog.
    const second = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] });
    await second.controller.refreshCurrentWorkspaceSessions();
    const restored = second.state.sessions.find((session) => session.id === "run-77");
    if (restored === undefined) throw new Error("restored pipeline row missing");
    expect(restored.firstMessage).toBe("Build the flinger");
    expect(restored.cwd).toBe("/repo");

    await second.controller.selectSession(restored);
    const stream = second.streams[0];
    if (stream === undefined) throw new Error("pipeline event stream missing");
    stream.push(startedFrame("run-77", "INTAKE"));
    await flush();
    await second.controller.send("status");
    await flush();
    expect(texts(second.state)).toContain("Pipeline status · run-77 · INTAKE");
    second.controller.dispose();
  });

  it("restores server messages when the browser chat cache is empty", async () => {
    const run = "run-reopen", timestamp = "2026-11-20T16:00:00Z";
    const saved = { role: "system" as const, pipelineId: "event-7", pipelineOrder: 7, meta: { timestamp }, parts: [{ type: "text" as const, text: "Worker finished writing src/main.ts" }] };
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve(serverPipelineRows([{ runId: run, requestId: "request-1", cwd: workspace.path, goal: "Write the app", created: timestamp }], workspace.path)),
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

  it("notes when the server chat history is unavailable on reopen", async () => {
    const run = "run-offline", timestamp = "2026-11-20T16:00:00Z";
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve(serverPipelineRows([{ runId: run, requestId: "request-1", cwd: workspace.path, goal: "Write the app", created: timestamp }], workspace.path)),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] }, {
      pipelineHistory: { load: () => Promise.reject(new Error("server unreachable")), save: () => Promise.resolve() },
    });
    try {
      await harness.controller.refreshCurrentWorkspaceSessions();
      const row = harness.state.sessions.find(candidate => candidate.id === run);
      if (!row) throw new Error("persisted chat missing from catalog");
      await harness.controller.selectSession(row);
      await vi.waitFor(() => { expect(harness.state.error).toContain("Server chat history is unavailable"); });
    } finally { harness.controller.dispose(); }
  });

  it("preserves the saved card timestamp when a live card arrives before its history page", async () => {
    const run = "run-card-time", timestamp = "2026-11-19T14:33:22Z";
    let finish: (rows: ChatLine[]) => void = () => { throw new Error("history was not requested"); };
    const history = new Promise<ChatLine[]>(resolve => { finish = resolve; });
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve(serverPipelineRows([{ runId: run, requestId: "request-1", cwd: workspace.path, goal: "Write the app", created: timestamp }], workspace.path)),
    };
    const harness = makeController(api, { ...initialAppState(), selectedWorkspace: workspace, sessions: [] }, {
      pipelineHistory: { load: () => history, save: () => Promise.resolve() },
    });
    try {
      await harness.controller.refreshCurrentWorkspaceSessions();
      const session = harness.state.sessions.find(candidate => candidate.id === run);
      if (!session) throw new Error("saved chat missing");
      await harness.controller.selectSession(session);
      const shown = harness.state.messages.find(row => row.parts[0]?.type === "pipelineCard");
      if (!shown) throw new Error("live card missing");
      // The server's stored copy of the same card line lands late: the live
      // card keeps its controls but takes the saved time and position.
      finish([{ ...shown, meta: { timestamp }, pipelineOrder: Date.parse(timestamp) * 1000, pipelineVersion: 1 }]);
      await vi.waitFor(() => {
        const cards = harness.state.messages.filter(row => row.parts[0]?.type === "pipelineCard");
        expect(cards).toHaveLength(1);
        expect(cards[0]?.meta?.timestamp).toBe(timestamp);
      });
    } finally { harness.controller.dispose(); }
  });
});
