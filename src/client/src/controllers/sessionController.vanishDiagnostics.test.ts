import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { resetVanishDiagsForTests, setVanishDiagSinkForTests, type VanishDiagEvent } from "../vanishDiagnostics";
import { SessionController } from "./sessionController";
import { emptyTranscriptApi as defaultApi, FakeSocket, oldSession, replacementSession, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

let events: VanishDiagEvent[] = [];

beforeEach(() => {
  events = [];
  setVanishDiagSinkForTests((event) => { events.push(event); });
});

afterEach(() => {
  setVanishDiagSinkForTests(undefined);
  resetVanishDiagsForTests();
});

describe("SessionController vanish diagnostics", () => {
  it("records a vanish-candidate when a refresh drops the selected session", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = { ...defaultApi, sessions: () => Promise.resolve([replacementSession]) };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.refreshCurrentWorkspaceSessions("local", "browser-resume");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "vanish-candidate",
      reason: "browser-resume",
      machineId: "local",
      workspace: "/repo",
      fetched: 1,
      listed: 1,
      // The server listing itself omitted the selected session.
      selInFetched: false,
      selectedId: "old-session",
      selectedName: oldSession.name,
      selectedPersisted: oldSession.persisted,
      selectedMessages: 0,
      lifelines: 0,
      nextId: "new-session",
    });
    // And the vanish itself: selection moved off the session the user was in.
    expect(state.selectedSession?.id).toBe("new-session");
  });

  it("records nothing when the fetched list still contains the selected session", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: oldSession, sessions: [oldSession] };
    const api: typeof defaultApi = { ...defaultApi, sessions: () => Promise.resolve([oldSession]) };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.refreshCurrentWorkspaceSessions("local", "socket-reconnect");

    expect(events).toEqual([]);
    expect(state.selectedSession?.id).toBe("old-session");
  });

  it("records a created-upsert when a session.created lands for the current workspace", () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api: defaultApi, socket: new FakeSocket() },
    );
    const created: SessionInfo = { ...oldSession, id: "brand-new", path: "/tmp/brand-new.jsonl" };

    controller.applyGlobalEvent({ type: "session.created", session: created });

    expect(events).toEqual([expect.objectContaining({ kind: "created-upsert", sessionId: "brand-new", cwd: "/repo", machineId: "local" })]);
    expect(state.sessions.map((session) => session.id)).toEqual(["brand-new", oldSession.id]);
  });

  it("records no upsert event when a session.created lands for another workspace", () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [oldSession] };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api: defaultApi, socket: new FakeSocket() },
    );
    const created: SessionInfo = { ...oldSession, id: "elsewhere", path: "/tmp/elsewhere.jsonl", cwd: "/other-repo" };

    controller.applyGlobalEvent({ type: "session.created", session: created });

    expect(events).toEqual([]);
    expect(state.sessions.map((session) => session.id)).toEqual([oldSession.id]);
  });
});
