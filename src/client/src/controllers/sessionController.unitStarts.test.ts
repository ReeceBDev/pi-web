import { describe, expect, it } from "vitest";
import { initialAppState } from "../appState";
import { SessionController } from "./sessionController";
import { emptyTranscriptApi as defaultApi, deferred, FakeSocket, workspace, type AppState, type SessionInfo } from "./sessionController.testSupport";

function controllerWith(
  getState: () => AppState,
  setState: (patch: Partial<AppState>) => void,
  overrides: {
    api?: Partial<typeof defaultApi>;
  } = {},
): SessionController {
  return new SessionController(
    getState,
    setState,
    () => undefined,
    undefined,
    {
      api: { ...defaultApi, ...overrides.api },
      socket: new FakeSocket(),
    },
  );
}

describe("SessionController unit starts", () => {
  it("creates a unit for a non-unit local workspace and starts in the primary worktree", async () => {
    const unitPath = "/home/rbowen/units/pi-1/worktrees/primary";
    const started: SessionInfo = { ...workspace, ...oldSessionShape(), id: "started-session", cwd: unitPath, path: "/tmp/started.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const supervisorCalls: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        supervisorUnit: (cwd) => {
          supervisorCalls.push(`unit:${cwd}`);
          return Promise.resolve({});
        },
        supervisorCreateUnit: (source) => {
          supervisorCalls.push(`create:${source}`);
          return Promise.resolve({ unitName: "pi-1", worktreePath: unitPath });
        },
        startSession: () => startRequest.promise,
      },
    });

    const start = controller.startSession();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const temporarySession = state.selectedSession;

    expect(temporarySession?.cwd).toBe(unitPath);
    expect(supervisorCalls).toEqual([`unit:/repo`, `create:/repo`]);

    startRequest.resolve(started);
    await start;

    expect(state.selectedSession?.id).toBe("started-session");
  });

  it("plain start skips the supervisor entirely and starts in the workspace path", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const started: SessionInfo = { ...workspace, ...oldSessionShape(), id: "started-session", cwd: "/repo", path: "/tmp/started-plain.jsonl" };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        supervisorUnit: () => Promise.reject(new Error("supervisor must not be called for a plain start")),
        supervisorCreateUnit: () => Promise.reject(new Error("supervisor must not be called for a plain start")),
        startSession: () => Promise.resolve(started),
      },
    });

    await controller.startSession({ updateUrl: false, plain: true });

    expect(state.selectedSession?.id).toBe("started-session");
    expect(state.selectedSession?.cwd).toBe("/repo");
  });

  it("resolves a unit session immediately without any workspace-listing dependency", async () => {
    const unitPath = "/home/rbowen/units/pi-2/worktrees/primary";
    const started: SessionInfo = { ...oldSessionShape(), id: "started-session", cwd: unitPath, path: "/tmp/started-2.jsonl" };
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        supervisorUnit: () => Promise.resolve({ unit: "/units/pi-2" }),
        startSession: () => Promise.resolve(started),
      },
    });

    await controller.startSession({ updateUrl: false });

    expect(state.selectedSession?.id).toBe("started-session");
  });

  it("delivers a prompt sent during a unit start to the new session without waiting on anything", async () => {
    const unitPath = "/home/rbowen/units/pi-2/worktrees/primary";
    const started: SessionInfo = { ...oldSessionShape(), id: "started-session", cwd: unitPath, path: "/tmp/started-2b.jsonl" };
    const startRequest = deferred<SessionInfo>();
    const prompts: string[] = [];
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        supervisorUnit: () => Promise.resolve({ unit: "/units/pi-2" }),
        startSession: () => startRequest.promise,
        prompt: (_session, text) => {
          prompts.push(text);
          return Promise.resolve({ accepted: true });
        },
      },
    });

    const start = controller.startSession({ updateUrl: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The composer targets the pending temp row while the start is in flight.
    await controller.send("Hey");
    startRequest.resolve(started);
    await start;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prompts).toEqual(["Hey"]);
    expect(state.selectedSession?.id).toBe("started-session");
  });

  it("falls back to the plain local session when the supervisor is unreachable", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const started: SessionInfo = { ...oldSessionShape(), id: "started-session", cwd: "/repo", path: "/tmp/started-3.jsonl" };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        supervisorUnit: () => Promise.reject(new Error("connect ECONNREFUSED")),
        startSession: () => Promise.resolve(started),
      },
    });

    await controller.startSession({ updateUrl: false });

    expect(state.selectedSession?.id).toBe("started-session");
    expect(state.selectedSession?.cwd).toBe("/repo");
  });

  it("starts directly in an existing unit worktree via startSessionAt", async () => {
    const unitPath = "/home/rbowen/units/pi-3/worktrees/second";
    let state: AppState = {
      ...initialAppState(),
      selectedWorkspace: workspace,
      selectedProject: { id: "project-1", name: "repo", path: "/repo", createdAt: "2026-05-15T00:00:00.000Z" },
      workspacesByProjectId: { "project-1": [{ ...workspace, id: "unit-ws", path: unitPath, label: "pi-3/second", isMain: false }] },
      sessions: [],
    };
    const started: SessionInfo = { ...oldSessionShape(), id: "started-at", cwd: unitPath, path: "/tmp/started-4.jsonl" };
    const startedWith: string[] = [];
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        supervisorUnit: () => Promise.resolve({ unit: "/units/pi-3" }),
        startSession: (startedCwd) => {
          startedWith.push(startedCwd);
          return Promise.resolve(started);
        },
      },
    });

    await controller.startSessionAt(unitPath);

    expect(startedWith).toEqual([unitPath]);
    void state;
  });

  it("adds a unit worktree and opens a new chat in it", async () => {
    const unitPath = "/home/rbowen/units/pi-4/worktrees/second";
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const session: SessionInfo = { ...oldSessionShape(), id: "unit-chat", cwd: "/home/rbowen/units/pi-4/worktrees/primary", path: "/tmp/unit.jsonl" };
    const startedWith: string[] = [];
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        supervisorAddWorktree: (cwd) => {
          expect(cwd).toBe(session.cwd);
          return Promise.resolve({ worktreePath: unitPath });
        },
        supervisorUnit: () => Promise.resolve({ unit: "/units/pi-4" }),
        startSession: (cwd) => {
          startedWith.push(cwd);
          return Promise.resolve({ ...session, id: "added-worktree-chat", cwd });
        },
      },
    });

    await controller.addWorktree(session);

    expect(startedWith).toEqual([unitPath]);
  });

  it("reports the worktree failure instead of throwing past the menu", async () => {
    let state: AppState = { ...initialAppState(), selectedWorkspace: workspace, sessions: [] };
    const controller = controllerWith(() => state, (patch) => { state = { ...state, ...patch }; }, {
      api: {
        supervisorAddWorktree: () => Promise.reject(new Error("HTTP 502")),
      },
    });

    await controller.addWorktree({ ...oldSessionShape(), id: "unit-chat", cwd: "/units/pi-5/worktrees/primary", path: "/tmp/u5.jsonl" });

    expect(state.error).toContain("HTTP 502");
  });
});

function oldSessionShape(): SessionInfo {
  return {
    id: "seed",
    path: "/tmp/seed.jsonl",
    cwd: "/repo",
    created: "2026-05-15T00:00:00.000Z",
    modified: "2026-05-15T00:00:00.000Z",
    persisted: true,
    name: "seed",
    messageCount: 1,
    firstMessage: "seed",
  };
}
