import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUnreadEvent, SessionUnreadSummary } from "../../shared/apiTypes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { FcmPushStore } from "./fcmPushStore.js";
import { FcmPushService, type FcmDeliveryResult, type FcmSender } from "./fcmPushService.js";

const BASE_URL = "https://hephaestus.example.test/";
const TOKEN = "fPaBcD1234567890abcdefghijklmnopqrstuvwxyz-_";

function unreadEvent(overrides: Partial<SessionUnreadEvent> = {}): SessionUnreadEvent {
  const summary = { sessionId: "s1", cwd: "/work/demo", completionOrder: 1, completedAt: "2026-01-01T00:00:00.000Z" };
  return {
    type: "sessions.unread",
    catalogId: "catalog-1",
    catalogRevision: 1,
    sessionId: summary.sessionId,
    cwd: summary.cwd,
    unread: summary,
    ...overrides,
  };
}

interface Harness {
  service: FcmPushService;
  store: FcmPushStore;
  hub: SessionEventHub;
  sends: { token: string; data: Record<string, string> }[];
  queueResponse: (result: FcmDeliveryResult) => void;
  mayNotify: ReturnType<typeof vi.fn<(summary: SessionUnreadSummary) => boolean>>;
  report: ReturnType<typeof vi.fn<(reason: string) => void>>;
  liveOrder: Map<string, number>;
}

async function harness(): Promise<Harness> {
  const store = new FcmPushStore({ load: () => Promise.resolve(undefined), save: () => Promise.resolve() });
  await store.load();
  await store.subscribe(TOKEN);
  const sends: { token: string; data: Record<string, string> }[] = [];
  const responses: FcmDeliveryResult[] = [];
  const mayNotify = vi.fn<(summary: SessionUnreadSummary) => boolean>(() => true);
  const report = vi.fn<(reason: string) => void>(() => undefined);
  const liveOrder = new Map<string, number>([["s1", 1]]);
  const sender: FcmSender = (token, data) => {
    sends.push({ token, data });
    const result = responses.shift();
    if (result === undefined) return Promise.resolve({ ok: true, status: 200 });
    return Promise.resolve(result);
  };
  const service = new FcmPushService({
    store,
    baseUrl: BASE_URL,
    isCurrent: (event) => event.unread !== null && liveOrder.get(event.sessionId) === event.unread.completionOrder,
    mayNotify: (summary) => mayNotify(summary),
    report: (reason) => { report(reason); },
    sender,
  });
  const hub = new SessionEventHub();
  service.attach(hub, { catalogId: "catalog-1", catalogRevision: 1, sessions: [] });
  return { service, store, hub, sends, queueResponse: (result) => { responses.push(result); }, mayNotify, report, liveOrder };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("FcmPushService completion delivery", () => {
  it("sends one data message with the session deep link after the 4 s watching window", async () => {
    const { service, hub, sends } = await harness();
    hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    expect(sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3999);
    expect(sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sends).toHaveLength(1);
    expect(sends.at(0)?.token).toBe(TOKEN);
    expect(sends.at(0)?.data).toEqual({
      conversationId: "s1",
      title: "Task finished",
      body: "demo",
      completedAt: "2026-01-01T00:00:00.000Z",
      url: `${BASE_URL}?session=s1&view=chat`,
    });
    expect(service).toBeDefined();
  });

  it("carries the session title and omits the field when the summary has none", async () => {
    const { hub, sends } = await harness();
    hub.publishGlobal(unreadEvent({
      catalogRevision: 2,
      unread: { sessionId: "s1", cwd: "/work/demo", completionOrder: 1, completedAt: "2026-01-01T00:00:00.000Z", title: "Fix the login bug" },
    }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends.at(0)?.data).toEqual({
      conversationId: "s1",
      title: "Task finished",
      body: "demo",
      sessionTitle: "Fix the login bug",
      completedAt: "2026-01-01T00:00:00.000Z",
      url: `${BASE_URL}?session=s1&view=chat`,
    });

    const { hub: bareHub, sends: bareSends } = await harness();
    bareHub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(bareSends.at(0)?.data["sessionTitle"]).toBeUndefined();
  });

  it("cancels a pending completion when the session is read before the window elapses", async () => {
    const { service, hub, sends } = await harness();
    hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(1000);
    hub.publishGlobal(unreadEvent({ catalogRevision: 3, unread: null }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends).toHaveLength(0);
    expect(service).toBeDefined();
  });

  it("skips the send when the finished session is no longer current at fire time", async () => {
    const { service, hub, sends, liveOrder } = await harness();
    hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    liveOrder.set("s1", 2); // a newer completion superseded this one during the window
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends).toHaveLength(0);
    expect(service).toBeDefined();
  });

  it("suppresses when mayNotify refuses and reports send rejections", async () => {
    const { hub, sends, mayNotify } = await harness();
    mayNotify.mockReturnValue(false);
    hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends).toHaveLength(0);

    const { hub: failingHub, sends: failingSends, queueResponse, report: failingReport } = await harness();
    queueResponse({ ok: false, status: 500, bodyText: "backend error" });
    failingHub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(failingSends).toHaveLength(1);
    expect(failingReport).toHaveBeenCalledWith("fcm-send-rejected-500");
  });

  it("prunes tokens Google reports as unregistered", async () => {
    const { service, hub, sends, store, queueResponse } = await harness();
    await store.subscribe("second-token-abcdefghijklmnopqrst");
    queueResponse({ ok: false, status: 404, bodyText: "Requested entity was not found." });
    hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends).toHaveLength(2);
    expect(store.snapshot().tokens).toEqual(["second-token-abcdefghijklmnopqrst"]);
    expect(service).toBeDefined();
  });

  it("ignores events at or below the attached baseline and stops after dispose", async () => {
    const { service, hub, sends } = await harness();
    hub.publishGlobal(unreadEvent({ catalogRevision: 1 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends).toHaveLength(0);
    service.dispose();
    hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends).toHaveLength(0);
  });

  it("sends nothing when no tokens are registered", async () => {
    const { service, hub, sends, store } = await harness();
    await store.unsubscribe(TOKEN);
    hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(sends).toHaveLength(0);
    expect(service).toBeDefined();
  });
});
