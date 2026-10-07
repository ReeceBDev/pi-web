import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { isCachedNewSessionInfo, loadCachedNewSessions, markCachedNewSessionInfo, rememberCachedNewSession } from "../cachedNewSessions";
import { loadDraft, saveDraft } from "../promptDraftStorage";
import { clearStagedAttachments, loadStagedAttachments, saveStagedAttachments, type PendingAttachment } from "../promptAttachmentStaging";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, emptyPage, FakeSocket, MemoryStorage, oldSession, replacementSession, sessionKey, sessionLookupId, status, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

describe("SessionController cached-new sessions", () => {
  it("keeps live message count updates when a cached new session becomes persisted", async () => {
    const cachedSession = markCachedNewSessionInfo(oldSession);
    let resolvePrompt: (() => void) | undefined;
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, selectedSession: cachedSession, sessions: [cachedSession] };
    const api: typeof defaultApi = {
      ...defaultApi,
      prompt: () => new Promise<{ accepted: true }>((resolve) => { resolvePrompt = () => { resolve({ accepted: true }); }; }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const send = controller.send("hello");
    controller.applyGlobalEvent({ type: "status.update", status: { ...status(oldSession.id), messageCount: 1 } });
    controller.flushPendingUpdates();
    resolvePrompt?.();
    await send;

    expect(state.sessions[0]?.messageCount).toBe(1);
    expect(isCachedNewSessionInfo(state.sessions[0])).toBe(false);
    expect(state.selectedSession?.messageCount).toBe(1);
  });

  it("deletes transient server-reported new sessions and clears local state", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const transientSession = { ...oldSession, persisted: false };
    const nextSession = { ...oldSession, id: "next-session", path: "/tmp/next-session.jsonl", persisted: true };
    const stoppedIds: string[] = [];
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: transientSession,
      sessions: [transientSession, nextSession],
      sessionStatuses: { [transientSession.id]: { ...status(transientSession.id), persisted: false } },
      sessionActivities: { [transientSession.id]: { sessionId: transientSession.id, phase: "active", label: "Starting", at: "2026-05-20T00:00:00.000Z" } },
      sendingPrompts: { [transientSession.id]: true },
    };
    const api: typeof defaultApi = {
      ...defaultApi,
      stop: (session) => { stoppedIds.push(sessionLookupId(session)); return Promise.resolve({ stopped: true }); },
      transcriptSnapshot: (session) => Promise.resolve({ page: emptyPage, status: status(sessionLookupId(session)), seq: 0, partial: null }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );
    saveDraft(sessionKey(transientSession.id), "discard me");
    const discardedAttachment: PendingAttachment = { id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 };
    saveStagedAttachments(sessionKey(transientSession.id), [discardedAttachment]);

    await controller.deleteCachedNewSession(transientSession);

    expect(stoppedIds).toEqual([transientSession.id]);
    expect(state.sessions.map((session) => session.id)).toEqual([nextSession.id]);
    expect(state.sessionStatuses[transientSession.id]).toBeUndefined();
    expect(state.sessionActivities[transientSession.id]).toBeUndefined();
    expect(state.sendingPrompts[transientSession.id]).toBeUndefined();
    expect(loadDraft(sessionKey(transientSession.id))).toBe("");
    expect(loadStagedAttachments(sessionKey(transientSession.id))).toEqual([]);
    expect(state.selectedSession?.id).toBe(nextSession.id);
  });

  it("recreates missing browser-cached new sessions and moves their draft", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    rememberCachedNewSession(oldSession);
    saveDraft(sessionKey(oldSession.id), "draft text");
    const carriedAttachment: PendingAttachment = { id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 };
    saveStagedAttachments(sessionKey(oldSession.id), [carriedAttachment]);

    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [markCachedNewSessionInfo(oldSession)] };
    const urlUpdates: ({ replace?: boolean | undefined } | undefined)[] = [];
    const socket = new FakeSocket();
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => Promise.resolve(replacementSession),
      transcriptSnapshot: (session) => {
        if (sessionLookupId(session) === oldSession.id) return Promise.reject(new Error("Session not found"));
        return Promise.resolve({ page: emptyPage, status: status(sessionLookupId(session)), seq: 0, partial: null });
      },
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      (options) => { urlUpdates.push(options); },
      undefined,
      { api, socket },
    );

    await controller.selectSession(markCachedNewSessionInfo(oldSession), { updateUrl: false });

    expect(state.selectedSession?.id).toBe(replacementSession.id);
    expect(state.sessions.map((session) => session.id)).toEqual([replacementSession.id]);
    expect(socket.connectedSessionIds).toEqual([oldSession.id, replacementSession.id]);
    expect(loadDraft(sessionKey(oldSession.id))).toBe("");
    expect(loadDraft(sessionKey(replacementSession.id))).toBe("draft text");
    expect(loadStagedAttachments(sessionKey(oldSession.id))).toEqual([]);
    expect(loadStagedAttachments(sessionKey(replacementSession.id))).toEqual([carriedAttachment]);
    expect(loadCachedNewSessions().map((session) => session.id)).toEqual([replacementSession.id]);
    expect(urlUpdates).toEqual([{ replace: true }]);

    // `oldSession`/`replacementSession` are shared fixture ids reused by other
    // tests in this file; the staged-attachment store is an in-memory module
    // singleton (unlike localStorage-backed drafts, which each test resets by
    // swapping in a fresh MemoryStorage), so clear explicitly to avoid leaking
    // this attachment into a later test that reuses the same id.
    clearStagedAttachments(sessionKey(replacementSession.id));
  });

  it.each([false, true])("reconciles rejected cached-session navigation without replacing newer selection (newer: %s)", async (selectNewer) => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    rememberCachedNewSession(oldSession);
    saveDraft(sessionKey(oldSession.id), "keep this draft");
    const cachedSession = markCachedNewSessionInfo(oldSession);
    const newerSession = { ...oldSession, id: "newer-session" };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [cachedSession, newerSession] };
    const urlUpdates: unknown[] = [];
    const socket = new FakeSocket();
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => Promise.resolve(replacementSession),
      transcriptSnapshot: (session) => sessionLookupId(session) === oldSession.id
        ? Promise.reject(new Error("Session not found"))
        : Promise.resolve({ page: emptyPage, status: status(sessionLookupId(session)), seq: 0, partial: null }),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      (options) => { urlUpdates.push(options); },
      undefined,
      {
        api,
        socket,
        navigateToSession: async (session, options) => {
          expect(session?.id).toBe(replacementSession.id);
          expect(options?.expected?.sessionId).toBe(oldSession.id);
          expect(state.selectedSession?.id).toBe(oldSession.id);
          if (selectNewer) await controller.selectSession(newerSession, { updateUrl: false });
          return false;
        },
      },
    );

    await controller.selectSession(cachedSession, { updateUrl: false });

    expect(state.selectedSession?.id).toBe(selectNewer ? newerSession.id : undefined);
    expect(state.sessions.map((session) => session.id)).toEqual([replacementSession.id, newerSession.id]);
    expect(loadCachedNewSessions().map((session) => session.id)).toEqual([replacementSession.id]);
    expect(loadDraft(sessionKey(oldSession.id))).toBe("");
    expect(loadDraft(sessionKey(replacementSession.id))).toBe("keep this draft");
    expect(urlUpdates).toEqual([]);
    controller.dispose();
  });

  it("publishes a command-result replacement before selecting its session", async () => {
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
    };
    const selectedAtNavigation: string[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      runCommand: () => Promise.resolve({ type: "done", message: "Session forked", session: replacementSession, promptDraft: "fork me" }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      {
        api,
        socket: new FakeSocket(),
        navigateToSession: (session, options) => {
          selectedAtNavigation.push(state.selectedSession?.id ?? "missing");
          expect(options?.expected?.sessionId).toBe(oldSession.id);
          state = { ...state, selectedSession: session };
          return Promise.resolve(true);
        },
      },
    );

    await controller.send("/fork");

    expect(selectedAtNavigation).toEqual([oldSession.id]);
    expect(state.selectedSession?.id).toBe(replacementSession.id);
    expect(state.sessions[0]?.id).toBe(replacementSession.id);
  });

  it("stores command prompt drafts for replacement sessions before selecting them", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });

    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedSession: oldSession,
      sessions: [oldSession],
      commandDialog: { type: "select", requestId: "r1", title: "Fork from message", options: [{ value: "m1", label: "fork me" }] },
    };
    const urlUpdates: unknown[] = [];
    const api: typeof defaultApi = {
      ...defaultApi,
      respondToCommand: () => Promise.resolve({ type: "done", message: "Session forked", session: replacementSession, promptDraft: "fork me" }),
      transcriptSnapshot: (session) => Promise.resolve({ page: emptyPage, status: status(sessionLookupId(session)), seq: 0, partial: null }),
      messages: () => Promise.resolve(emptyPage),
      status: (session) => Promise.resolve(status(sessionLookupId(session))),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      (options) => { urlUpdates.push(options); },
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.respondToCommand("r1", "m1");

    expect(state.commandDialog).toBeUndefined();
    expect(loadDraft(sessionKey(replacementSession.id))).toBe("fork me");
  });

  it("keeps the cached-new session when a refresh lands after the workspace changed", async () => {
    // Regression: mergeCachedNewSessions drops storage entries contained in the
    // fetched listing. If that side effect ran before the machine/workspace
    // guards discarded the fetched list, a stale catalog snapshot reused on
    // return lost the new session entirely (it disappears from the workspace).
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const otherWorkspace = { ...workspace, id: "workspace-2", path: "/other" };
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const fetchedGate = deferred<SessionInfo[]>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: (cwd) => (cwd === workspace.path ? fetchedGate.promise : Promise.resolve([])),
      startSession: () => Promise.resolve(started),
      transcriptSnapshot: (session) => Promise.resolve({ page: emptyPage, status: status(sessionLookupId(session)), seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.startSession();
    expect(loadCachedNewSessions(storage).map((session) => session.id)).toEqual(["started-session"]);

    // The session gained a message, so the server now lists it. The refresh
    // starts, then the user switches workspace before the response lands.
    const refreshing = controller.refreshCurrentWorkspaceSessions();
    state = { ...state, selectedWorkspace: otherWorkspace };
    fetchedGate.resolve([{ ...oldSession }, { ...started, messageCount: 1, firstMessage: "hi" }]);
    await refreshing;

    // The guard discarded the fetched list, so the storage entry must survive.
    expect(loadCachedNewSessions(storage).map((session) => session.id)).toEqual(["started-session"]);
  });

  it("persists the pending start row so a reload mid-start can restore it", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl" };
    const startRequest = deferred<SessionInfo>();
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve([oldSession]),
      startSession: () => startRequest.promise,
      transcriptSnapshot: (session) => Promise.resolve({ page: emptyPage, status: status(sessionLookupId(session)), seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    const start = controller.startSession();
    const tempId = state.selectedSession?.id;
    expect(tempId).toMatch(/^creating:/);
    // The row is durable before the backend answers, so a discarded mobile tab
    // cannot lose the session (and its draft) without a trace.
    expect(loadCachedNewSessions(storage).map((session) => session.id)).toEqual([tempId]);

    // Reload mid-start: fresh controller and state, same storage.
    let reloadedState: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const reloaded = new SessionController(
      () => reloadedState,
      (patch) => { reloadedState = { ...reloadedState, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );
    await reloaded.refreshCurrentWorkspaceSessions();
    expect(reloadedState.sessions.map((session) => session.id)).toContain(tempId);
    expect(reloaded.preferredSession(workspace.path, reloadedState.sessions, tempId)?.id).toBe(tempId);

    // Once the original start settles, only the real session stays cached.
    startRequest.resolve(started);
    await start;
    expect(loadCachedNewSessions(storage).map((session) => session.id)).toEqual(["started-session"]);
  });

  it("remembers the created session even when the create response reports a placeholder messageCount", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    // The engine may pre-allocate the transcript path and report a nonzero
    // messageCount in the create response; the client authored the session
    // empty, so the lifeline must still record it.
    const started: SessionInfo = { ...oldSession, id: "started-session", path: "/tmp/started-session.jsonl", messageCount: 1, firstMessage: "..." };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      sessions: () => Promise.resolve([]),
      startSession: () => Promise.resolve(started),
      transcriptSnapshot: (session) => Promise.resolve({ page: emptyPage, status: status(sessionLookupId(session)), seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.startSession();

    expect(loadCachedNewSessions(storage).map((session) => session.id)).toEqual(["started-session"]);
  });

  it("forgets the pending start row when the start fails", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const api: typeof defaultApi = {
      ...defaultApi,
      startSession: () => Promise.reject(new Error("daemon unreachable")),
      transcriptSnapshot: (session) => Promise.resolve({ page: emptyPage, status: status(sessionLookupId(session)), seq: 0, partial: null }),
    };
    const controller = new SessionController(
      () => state,
      (patch) => { state = { ...state, ...patch }; },
      () => undefined,
      undefined,
      { api, socket: new FakeSocket() },
    );

    await controller.startSession();

    expect(loadCachedNewSessions(storage)).toEqual([]);
  });
});
