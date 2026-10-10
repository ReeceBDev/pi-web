import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import {
  CapturingSessionEventHub,
  emptyArchiveStore,
  fakeRuntime,
  fakeSessionManager,
  sessionGateway,
  sessionRecord,
  sessionRef,
  testModelRuntime,
  type RuntimeCreator,
} from "./piSessionService.testSupport.js";
import { SessionUnreadStore } from "./sessionUnreadStore.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const WAKE_SPOOL_CACHE_TTL_MS = 5_000;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface TestClock {
  nowMs: number;
}

async function tempWakeSpool(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-wake-spool-"));
  tempRoots.push(dir);
  return dir;
}

/** Drop a wake waiter whose JSON `session` field names `sessionId` into the spool's pending dir. */
async function parkSession(spoolDir: string, sessionId: string): Promise<void> {
  const pending = join(spoolDir, "pending");
  await mkdir(pending, { recursive: true });
  await writeFile(join(pending, `repo-ab12cd34-${sessionId.slice(0, 8)}.json`), JSON.stringify({ session: sessionId }), "utf8");
}

/** Global unread-completion events: one per recorded completion — the ding/push trigger. */
function unreadCompletions(hub: CapturingSessionEventHub): { sessionId: string }[] {
  return hub.globalEvents.flatMap((event) =>
    event.type === "sessions.unread" && event.unread !== null ? [{ sessionId: event.sessionId }] : []);
}

function buildService(spoolDir: string, fakes: ReturnType<typeof fakeRuntime>[], clock: TestClock) {
  let runtimeIndex = 0;
  const createAgentRuntime: RuntimeCreator = () => {
    const next = fakes[runtimeIndex];
    runtimeIndex += 1;
    if (next === undefined) throw new Error("no fake runtime for open " + String(runtimeIndex));
    return Promise.resolve(next.runtime);
  };
  const hub = new CapturingSessionEventHub();
  const service = new PiSessionService(hub, {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime,
    sessionManager: sessionGateway(fakes.map((fake) => sessionRecord(fake.session.sessionId))),
    archiveStore: emptyArchiveStore(),
    heartbeatIntervalMs: 60_000,
    unreadStore: new SessionUnreadStore(),
    wakeSpoolDir: spoolDir,
    now: () => new Date(clock.nowMs),
  });
  return { service, hub };
}

/** Session ids with an unacknowledged unread completion — the ding/push driver. */
async function notifiedSessionIds(service: PiSessionService): Promise<string[]> {
  return (await service.unreadCatalog()).sessions.map((summary) => summary.sessionId);
}

/** Drive one normal agent turn: start, work, end. */
function completeRuntimeWork(fake: ReturnType<typeof fakeRuntime>): void {
  fake.session.isStreaming = true;
  fake.emit({ type: "agent_start" });
  fake.session.isStreaming = false;
  fake.emit({ type: "turn_end" });
}

describe("PiSessionService notification suppression", () => {
  describe("wake-parked turns stay silent", () => {
    it("keeps a parked turn silent", async () => {
      const spoolDir = await tempWakeSpool();
      await parkSession(spoolDir, "session-1");
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        completeRuntimeWork(fake);
        expect(await notifiedSessionIds(service)).toEqual([]);
      } finally {
        await service.dispose();
      }
    });

    it("notifies once the wake resolves and the real turn finishes", async () => {
      const spoolDir = await tempWakeSpool();
      const waiter = join(spoolDir, "pending", `repo-ab12cd34-session-.json`);
      await parkSession(spoolDir, "session-1");
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        completeRuntimeWork(fake);
        expect(await notifiedSessionIds(service)).toEqual([]);

        await rm(waiter, { force: true });
        clock.nowMs += WAKE_SPOOL_CACHE_TTL_MS + 1;
        completeRuntimeWork(fake);
        expect(await notifiedSessionIds(service)).toEqual(["session-1"]);
      } finally {
        await service.dispose();
      }
    });

    it("notifies on expiry after the wall cap deletes the waiter", async () => {
      const spoolDir = await tempWakeSpool();
      const waiter = join(spoolDir, "pending", `repo-ab12cd34-session-.json`);
      await parkSession(spoolDir, "session-1");
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        completeRuntimeWork(fake);
        expect(await notifiedSessionIds(service)).toEqual([]);

        // The extension's expiry timer deletes the waiter, then the turn ends.
        await rm(waiter, { force: true });
        clock.nowMs += WAKE_SPOOL_CACHE_TTL_MS + 1;
        completeRuntimeWork(fake);
        expect(await notifiedSessionIds(service)).toEqual(["session-1"]);
      } finally {
        await service.dispose();
      }
    });

    it("suppresses only the session whose waiter is pending", async () => {
      // Ids must differ within the first 8 chars: that prefix is the matcher.
      const spoolDir = await tempWakeSpool();
      await parkSession(spoolDir, "parked-aaaa1111");
      const clock: TestClock = { nowMs: Date.now() };
      const first = fakeRuntime("parked-aaaa1111");
      const second = fakeRuntime("worker-bbbb2222");
      const { service } = buildService(spoolDir, [first, second], clock);
      try {
        await service.status(sessionRef("parked-aaaa1111"));
        await service.status(sessionRef("worker-bbbb2222"));
        completeRuntimeWork(first);
        completeRuntimeWork(second);
        expect(await notifiedSessionIds(service)).toEqual(["worker-bbbb2222"]);
      } finally {
        await service.dispose();
      }
    });

    it("keeps replies to a parked session silent until the wake resolves", async () => {
      // Open question resolved 2026-10-08: replies to a parked session stay
      // silent too — no per-turn state to track; the wake's own completion
      // pings when the waiter is consumed.
      const spoolDir = await tempWakeSpool();
      await parkSession(spoolDir, "session-1");
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        completeRuntimeWork(fake);
        completeRuntimeWork(fake);
        expect(await notifiedSessionIds(service)).toEqual([]);
      } finally {
        await service.dispose();
      }
    });

    it("never lets a stale waiter leak onto a different session", async () => {
      const spoolDir = await tempWakeSpool();
      const pending = join(spoolDir, "pending");
      await mkdir(pending, { recursive: true });
      await writeFile(join(pending, "repo-ab12cd34-deadbeef.json"), "{}", "utf8");
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        completeRuntimeWork(fake);
        expect(await notifiedSessionIds(service)).toEqual(["session-1"]);
      } finally {
        await service.dispose();
      }
    });

    it("matches the waiter's full session id, so same-prefix sessions do not suppress each other", async () => {
      // Both ids share the 8-char filename suffix; only the JSON `session` field decides.
      const spoolDir = await tempWakeSpool();
      await parkSession(spoolDir, "dup1234-alpha");
      const clock: TestClock = { nowMs: Date.now() };
      const alpha = fakeRuntime("dup1234-alpha");
      const beta = fakeRuntime("dup1234-beta");
      const { service } = buildService(spoolDir, [alpha, beta], clock);
      try {
        await service.status(sessionRef("dup1234-alpha"));
        await service.status(sessionRef("dup1234-beta"));
        completeRuntimeWork(alpha);
        completeRuntimeWork(beta);
        expect(await notifiedSessionIds(service)).toEqual(["dup1234-beta"]);
      } finally {
        await service.dispose();
      }
    });

    it("sees a waiter parked after the previous scan because agent_start invalidates the cache", async () => {
      const spoolDir = await tempWakeSpool();
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service, hub } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        completeRuntimeWork(fake); // caches a negative scan result
        expect(await notifiedSessionIds(service)).toEqual(["session-1"]);

        await parkSession(spoolDir, "session-1"); // parked between turns
        completeRuntimeWork(fake); // agent_start drops the stale negative; turn end stays silent
        expect(unreadCompletions(hub)).toEqual([{ sessionId: "session-1" }]);
      } finally {
        await service.dispose();
      }
    });
  });

  describe("parent with working tracked children stays silent", () => {
    function buildSubsessionService(spoolDir: string, clock: TestClock) {
      const parent = fakeRuntime("parent-1");
      const childA = fakeRuntime("child-a-1", { sessionManager: fakeSessionManager("/workspace") });
      const childB = fakeRuntime("child-b-2", { sessionManager: fakeSessionManager("/workspace") });
      const bystander = fakeRuntime("bystander-1");
      // Children stay streaming after their spawn prompt: still WORKING.
      for (const child of [childA, childB]) {
        child.session.prompt = () => {
          child.session.isStreaming = true;
          child.emit({ type: "agent_start" });
          return Promise.resolve();
        };
      }
      const runtimes = [parent.runtime, childA.runtime, childB.runtime, bystander.runtime];
      let index = 0;
      const createAgentRuntime: RuntimeCreator = () => Promise.resolve(runtimes[index++] ?? bystander.runtime);
      const hub = new CapturingSessionEventHub();
      const service = new PiSessionService(hub, {
        agentDir: TEST_AGENT_DIR,
        modelRuntime: testModelRuntime,
        createAgentRuntime,
        sessionManager: sessionGateway([sessionRecord("bystander-1")]),
        archiveStore: emptyArchiveStore(),
        spawnTargets: { resolveSpawnTarget: () => Promise.resolve({ allowed: true, cwd: "/workspace" }) },
        heartbeatIntervalMs: 60_000,
        unreadStore: new SessionUnreadStore(),
        wakeSpoolDir: spoolDir,
        now: () => new Date(clock.nowMs),
      });
      return { service, hub, parent, childA, childB, bystander };
    }

    it("silences the parent while any child works and notifies once after the last child resolves", async () => {
      const spoolDir = await tempWakeSpool();
      const clock: TestClock = { nowMs: Date.now() };
      const { service, hub, parent, childA, childB, bystander } = buildSubsessionService(spoolDir, clock);
      try {
        await service.start("/workspace");
        const spawn = { spawningCwd: "/workspace", parentSessionId: "parent-1", parentSessionFile: "/tmp/parent-1.jsonl", prompt: "work" };
        await service.spawnSubsession(spawn);
        await service.spawnSubsession(spawn);
        await service.status(sessionRef("bystander-1"));

        completeRuntimeWork(bystander); // unrelated session notifies normally
        completeRuntimeWork(parent); // both children WORKING → parent silent
        expect(await notifiedSessionIds(service)).toEqual(["bystander-1"]);

        childA.session.isStreaming = false;
        childA.emit({ type: "turn_end" }); // one child resolves; the other still WORKING
        completeRuntimeWork(parent);
        expect(await notifiedSessionIds(service)).toEqual(["bystander-1"]);

        childB.session.isStreaming = false;
        childB.emit({ type: "turn_end" }); // last child resolves
        await new Promise((resolve) => setTimeout(resolve, 0)); // delivery observes the parent
        expect(unreadCompletions(hub).filter((completion) => completion.sessionId === "parent-1")).toHaveLength(1);
        expect((await notifiedSessionIds(service)).sort()).toEqual(["bystander-1", "parent-1"]);
      } finally {
        await service.dispose();
      }
    });
  });

  describe("user-cancelled turns stay silent", () => {
    it("keeps a Stop-button abort silent", async () => {
      const spoolDir = await tempWakeSpool();
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service, hub } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        fake.session.isStreaming = true;
        fake.emit({ type: "agent_start" });

        await service.abort(sessionRef("session-1"));
        fake.session.isStreaming = false;
        fake.emit({ type: "agent_end" });

        expect(await notifiedSessionIds(service)).toEqual([]);
        expect(hub.globalEvents.some((event) => event.type === "sessions.unread" && event.unread !== null)).toBe(false);
      } finally {
        await service.dispose();
      }
    });

    it("notifies again once the session works after a cancel", async () => {
      const spoolDir = await tempWakeSpool();
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        fake.session.isStreaming = true;
        fake.emit({ type: "agent_start" });
        await service.abort(sessionRef("session-1"));

        completeRuntimeWork(fake);
        expect(await notifiedSessionIds(service)).toEqual(["session-1"]);
      } finally {
        await service.dispose();
      }
    });

    it("cancels only the session the user cancelled", async () => {
      const spoolDir = await tempWakeSpool();
      const clock: TestClock = { nowMs: Date.now() };
      // Same first 8 characters prove cancel suppression uses full session ids.
      const first = fakeRuntime("samepref-first");
      const second = fakeRuntime("samepref-other");
      const { service } = buildService(spoolDir, [first, second], clock);
      try {
        await service.status(sessionRef("samepref-first"));
        await service.status(sessionRef("samepref-other"));
        for (const fake of [first, second]) {
          fake.session.isStreaming = true;
          fake.emit({ type: "agent_start" });
        }
        await service.abort(sessionRef("samepref-first"));

        for (const fake of [first, second]) {
          fake.session.isStreaming = false;
          fake.emit({ type: "agent_end" });
        }
        expect(await notifiedSessionIds(service)).toEqual(["samepref-other"]);
      } finally {
        await service.dispose();
      }
    });

    it("still notifies when a turn fails without a user abort", async () => {
      const spoolDir = await tempWakeSpool();
      const clock: TestClock = { nowMs: Date.now() };
      const fake = fakeRuntime("session-1");
      const { service } = buildService(spoolDir, [fake], clock);
      try {
        await service.status(sessionRef("session-1"));
        fake.session.isStreaming = true;
        fake.emit({ type: "agent_start" });
        fake.emit({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "example", result: {}, isError: true });
        fake.session.isStreaming = false;
        fake.emit({ type: "agent_end" });

        expect(await notifiedSessionIds(service)).toEqual(["session-1"]);
      } finally {
        await service.dispose();
      }
    });
  });
});
