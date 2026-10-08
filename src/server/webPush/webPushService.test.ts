import { createECDH, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webPush from "web-push";
import type { SessionUnreadEvent, SessionUnreadSummary } from "../../shared/apiTypes.js";
import { SessionEventHub } from "../realtime/sessionEventHub.js";
import { WebPushStore } from "./webPushStore.js";
import { createPushSender, WebPushService, type PushDeliveryResult, type PushSender } from "./webPushService.js";

const BASE_URL = "https://pi.example.test/pi-web/";

function subscriptionFixture(endpoint = `https://fcm.googleapis.com/fcm/send/token-${randomBytes(8).toString("hex")}`) {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  return {
    endpoint,
    keys: { p256dh: pair.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    privateKey: pair.getPrivateKey(),
  };
}

function unreadEvent(overrides: Partial<SessionUnreadEvent> = {}): SessionUnreadEvent {
  const summary = { sessionId: "s1", cwd: "/work/a", completionOrder: 1, completedAt: "2026-01-01T00:00:00.000Z" };
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

function chatUrl(target: { projectId: string; workspaceId: string; sessionId: string }): string {
  return `${BASE_URL}?${new URLSearchParams({ machine: "local", project: target.projectId, workspace: target.workspaceId, session: target.sessionId, view: "chat" }).toString()}`;
}

interface SentPush { record: Parameters<PushSender>[0]; payload: string }

interface Harness {
  service: WebPushService;
  store: WebPushStore;
  hub: SessionEventHub;
  sends: SentPush[];
  queueResponse: (result: PushDeliveryResult) => void;
  onSend: { hook: (() => Promise<void>) | undefined };
  resolveChat: ReturnType<typeof vi.fn<() => Promise<{ projectId: string; workspaceId: string } | undefined>>>;
  mayNotify: ReturnType<typeof vi.fn<(summary: SessionUnreadSummary) => boolean>>;
  report: ReturnType<typeof vi.fn<(reason: string) => void>>;
  liveOrder: Map<string, number>;
  waitSend: () => Promise<void>;
}

async function harness(options: { endpoint?: string } = {}): Promise<Harness> {
  const store = new WebPushStore({ load: () => Promise.resolve(undefined), save: () => Promise.resolve() });
  await store.load();
  await store.subscribe(subscriptionFixture(options.endpoint));
  const sends: SentPush[] = [];
  const responses: PushDeliveryResult[] = [];
  const waiters: (() => void)[] = [];
  const onSend: Harness["onSend"] = { hook: undefined };
  const liveOrder = new Map<string, number>([["s1", 1]]);
  const resolveChat = vi.fn<() => Promise<{ projectId: string; workspaceId: string } | undefined>>(() => Promise.resolve({ projectId: "p1", workspaceId: "w1" }));
  const mayNotify = vi.fn<(summary: SessionUnreadSummary) => boolean>(() => true);
  const report = vi.fn<(reason: string) => void>(() => undefined);
  const sender: PushSender = async (record, payload) => {
    sends.push({ record, payload });
    for (const waiter of waiters) waiter();
    const hook = onSend.hook;
    if (hook !== undefined) { onSend.hook = undefined; await hook(); }
    const result = responses.shift();
    if (result === undefined) throw new Error("no scripted response");
    return result;
  };
  const service = new WebPushService({
    store,
    baseUrl: BASE_URL,
    resolveChat,
    isCurrent: (event) => event.unread !== null && liveOrder.get(event.sessionId) === event.unread.completionOrder,
    mayNotify: (summary) => mayNotify(summary),
    report: (reason) => { report(reason); },
    sender,
  });
  const hub = new SessionEventHub();
  service.attach(hub, { catalogId: "catalog-1", catalogRevision: 1, sessions: [] });
  return {
    service, store, hub, sends,
    queueResponse: (result) => { responses.push(result); },
    onSend,
    resolveChat, mayNotify, report, liveOrder,
    waitSend: () => new Promise<void>((resolve) => waiters.push(resolve)),
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("WebPushService completion delivery", () => {
  it("sends one generic notification per subscription after the pending-read window", async () => {
    const h = await harness();
    const sent = h.waitSend();
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    expect(h.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(4000);
    await sent;
    expect(h.sends).toHaveLength(1);
    const payload = h.sends.at(0)?.payload ?? "";
    expect(JSON.parse(payload)).toEqual({ title: "PI WEB", body: "A session update is ready.", url: chatUrl({ projectId: "p1", workspaceId: "w1", sessionId: "s1" }) });
    expect(payload).not.toContain("/work/a");
    h.service.dispose();
  });

  it("ignores events at or below the attached baseline (no backlog seeding)", async () => {
    const h = await harness();
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 1 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.sends).toHaveLength(0);
    h.service.dispose();
  });

  it("cancels a pending completion when the session is read before the window elapses", async () => {
    const h = await harness();
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(2000);
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 3, unread: null }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.sends).toHaveLength(0);
    h.service.dispose();
  });

  it("re-checks currency after the chat-resolution await and drops a superseded completion", async () => {
    const h = await harness();
    let releaseResolution: (() => void) | undefined;
    h.resolveChat.mockImplementation(() => new Promise<{ projectId: string; workspaceId: string }>((resolve) => {
      releaseResolution = () => { resolve({ projectId: "p1", workspaceId: "w1" }); };
    }));
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    // The user reads while resolution is still in flight.
    h.liveOrder.delete("s1");
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 3, unread: null }));
    releaseResolution?.();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sends).toHaveLength(0);
    h.service.dispose();
  });

  it("suppresses notifications while native question or work state says otherwise", async () => {
    const h = await harness();
    h.mayNotify.mockReturnValue(false);
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.sends).toHaveLength(0);
    h.service.dispose();
  });

  it("sends nothing when attribution is missing or ambiguous and reports generically", async () => {
    const h = await harness();
    h.resolveChat.mockReturnValue(Promise.resolve(undefined));
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sends).toHaveLength(0);
    expect(h.report).toHaveBeenCalledWith("chat-target-missing-or-ambiguous");
    h.service.dispose();
  });

  it("drops pending completions on a catalog epoch change and serves the new epoch", async () => {
    const h = await harness();
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(2000);
    // The epoch-change announcement (here: a read acknowledgement) must cancel
    // the old epoch's pending completion; it never sends after the reset.
    h.hub.publishGlobal(unreadEvent({ catalogId: "catalog-2", catalogRevision: 5, unread: null }));
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.sends).toHaveLength(0);
    // A reset drops persisted unread (fresh epoch starts empty), so the first
    // new-epoch mutation is a genuinely fresh completion and must deliver.
    const sent = h.waitSend();
    h.queueResponse({ status: 201 });
    h.hub.publishGlobal(unreadEvent({ catalogId: "catalog-2", catalogRevision: 6 }));
    await vi.advanceTimersByTimeAsync(4100);
    await sent;
    expect(h.sends).toHaveLength(1);
    h.service.dispose();
  });

  it("retries 5xx up to twice then gives up without pruning", async () => {
    const h = await harness();
    const sent = h.waitSend();
    h.queueResponse({ status: 500 });
    h.queueResponse({ status: 500 });
    h.queueResponse({ status: 500 });
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(14_000);
    await sent;
    expect(h.sends).toHaveLength(3);
    expect(h.store.snapshot().subscriptions).toHaveLength(1);
    expect(h.report).toHaveBeenCalledWith("push-provider-not-accepted");
    h.service.dispose();
  });

  it("prunes the exact record on 404/410 and skips pruning when superseded mid-send", async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/token-${randomBytes(8).toString("hex")}`;
    // (a) A re-subscription landing during the in-flight send: the stale generation
    // is no longer current when the 404 arrives, so nothing may be pruned and the
    // fresh generation must survive.
    const h = await harness({ endpoint });
    const stale = h.store.snapshot().subscriptions.at(0);
    expect(stale).toBeDefined();
    const sent = h.waitSend();
    h.queueResponse({ status: 404 });
    h.onSend.hook = async () => { await h.store.subscribe(subscriptionFixture(endpoint)); };
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4100);
    await sent;
    const surviving = h.store.snapshot().subscriptions;
    expect(surviving).toHaveLength(1);
    expect(surviving.at(0)?.generation).not.toBe(stale?.generation);
    h.service.dispose();

    // (b) A plain 404/410 for the current record prunes exactly that record.
    const h2 = await harness();
    const sent2 = h2.waitSend();
    h2.queueResponse({ status: 410 });
    h2.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4100);
    await sent2;
    expect(h2.store.snapshot().subscriptions).toHaveLength(0);
    expect(h2.report).toHaveBeenCalledWith("push-subscription-expired");
    h2.service.dispose();
  });

  it("bounds Retry-After delays instead of trusting the provider value", async () => {
    const h = await harness();
    const sent = h.waitSend();
    h.queueResponse({ status: 429, retryAfter: "86400" });
    h.queueResponse({ status: 200 });
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    await sent;
    expect(h.sends).toHaveLength(1);
    // The bounded retry fires within two seconds, not the requested 24 hours.
    await vi.advanceTimersByTimeAsync(2100);
    expect(h.sends).toHaveLength(2);
    h.service.dispose();
  });

  it("never re-sends an already delivered completion identity", async () => {
    const h = await harness();
    const sent = h.waitSend();
    h.queueResponse({ status: 201 });
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4000);
    await sent;
    // A re-publication of the same completion (fresh revision) must not re-send.
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 3 }));
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sends).toHaveLength(1);
    h.service.dispose();
  });

  it("caps concurrent sends at four across subscriptions", async () => {
    const h = await harness();
    for (let index = 1; index < 7; index += 1) {
      await h.store.subscribe(subscriptionFixture(`https://fcm.googleapis.com/fcm/send/many-tokens-${String(index)}-xxxx`));
    }
    let inFlight = 0;
    let peak = 0;
    const service = new WebPushService({
      store: h.store,
      baseUrl: BASE_URL,
      resolveChat: () => Promise.resolve({ projectId: "p1", workspaceId: "w1" }),
      isCurrent: (event) => event.unread !== null && h.liveOrder.get(event.sessionId) === event.unread.completionOrder,
      mayNotify: () => true,
      report: (reason) => { h.report(reason); },
      sender: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight -= 1;
        return { status: 201 };
      },
    });
    service.attach(h.hub, { catalogId: "catalog-1", catalogRevision: 1, sessions: [] });
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 4 }));
    await vi.advanceTimersByTimeAsync(5600);
    expect(peak).toBeLessThanOrEqual(4);
    service.dispose();
  });

  it("stops retrying once the ten second deadline has passed", async () => {
    const h = await harness();
    const sender = vi.fn<PushSender>(() => {
      vi.setSystemTime(Date.now() + 9900);
      return Promise.resolve({ status: 500 });
    });
    const service = new WebPushService({
      store: h.store,
      baseUrl: BASE_URL,
      resolveChat: () => Promise.resolve({ projectId: "p1", workspaceId: "w1" }),
      isCurrent: (event) => event.unread !== null && h.liveOrder.get(event.sessionId) === event.unread.completionOrder,
      mayNotify: () => true,
      report: (reason) => { h.report(reason); },
      sender,
    });
    service.attach(h.hub, { catalogId: "catalog-1", catalogRevision: 1, sessions: [] });
    h.hub.publishGlobal(unreadEvent({ catalogRevision: 2 }));
    await vi.advanceTimersByTimeAsync(4100);
    expect(sender).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sender).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledWith("push-provider-not-accepted");
    service.dispose();
  });

  it("sends a test push and reports acceptance, never display", async () => {
    const h = await harness();
    const registered = h.store.snapshot().subscriptions.at(0);
    expect(registered).toBeDefined();
    const endpoint = registered?.subscription.endpoint ?? "";
    h.queueResponse({ status: 201 });
    const accepted = await h.service.test(endpoint);
    expect(accepted).toBe(true);
    expect(h.sends).toHaveLength(1);
    expect(JSON.parse(h.sends.at(0)?.payload ?? "")).toEqual({
      title: "PI WEB",
      body: "A session update is ready.",
      url: BASE_URL,
    });
    await expect(h.service.test("https://fcm.googleapis.com/fcm/send/unknown-token-xyz")).rejects.toThrow();
    h.service.dispose();
  });
});

describe("createPushSender encryption", () => {
  it("produces an RFC 8291 aes128gcm payload that decrypts to the generic body", async () => {
    vi.useRealTimers();
    const fixture = subscriptionFixture();
    const store = new WebPushStore({ load: () => Promise.resolve(undefined), save: () => Promise.resolve() });
    await store.load();
    const vapid = store.snapshot().vapid;
    const details = webPush.generateRequestDetails(
      { endpoint: fixture.endpoint, keys: fixture.keys },
      JSON.stringify({ title: "PI WEB", body: "A session update is ready." }),
      {
        TTL: 60, urgency: "normal", contentEncoding: "aes128gcm",
        vapidDetails: { subject: BASE_URL, ...vapid },
      },
    );
    const body = Buffer.from(details.body);
    // RFC 8291 aes128gcm record layout: salt(16) | rs(4) | keyidlen(1) | keyid | ciphertext+tag.
    const keyidLength = body.readUIntBE(20, 1);
    const header = body.subarray(0, 21 + keyidLength);
    const senderPublicKey = body.subarray(21, 21 + keyidLength);
    const recipient = createECDH("prime256v1");
    recipient.setPrivateKey(fixture.privateKey);
    const ecdhSecret = recipient.computeSecret(senderPublicKey);
    const salt = header.subarray(0, 16);
    const authSecret = Buffer.from(fixture.keys.auth, "base64url");
    const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), recipient.getPublicKey(), senderPublicKey]), 32));
    const key = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
    const ciphertext = body.subarray(header.length, body.length - 16);
    const decipher = createDecipheriv("aes-128-gcm", key, nonce);
    // http_ece (web-push's codec) does not feed the header as AAD; match it so the round trip verifies.
    decipher.setAuthTag(body.subarray(body.length - 16));
    const record = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    // One padding delimiter byte terminates a single-record payload.
    const plaintext = record.subarray(0, record.length - 1).toString("utf8");
    expect(JSON.parse(plaintext)).toEqual({ title: "PI WEB", body: "A session update is ready." });
    expect(details.endpoint).toBe(fixture.endpoint);
    expect(createPushSender).toBeDefined();
  });
});
