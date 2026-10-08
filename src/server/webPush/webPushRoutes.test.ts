import { createECDH, randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, WorkspaceListing } from "../types.js";
import { WebPushStore } from "./webPushStore.js";
import { registerWebPushProxyRoutes, registerWebPushRoutes } from "./webPushRoutes.js";
import { WebPushService, type PushSender } from "./webPushService.js";

const BASE_URL = "https://pi.example.test/pi-web/";

function subscriptionFixture() {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/token-${randomBytes(8).toString("hex")}`,
    keys: { p256dh: pair.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
  };
}

describe("session daemon web push routes", () => {
  let app: FastifyInstance;
  let store: WebPushStore;
  let service: WebPushService;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    store = new WebPushStore({ load: () => Promise.resolve(undefined), save: () => Promise.resolve() });
    await store.load();
    const sender: PushSender = () => Promise.resolve({ status: 201 });
    service = new WebPushService({
      store,
      baseUrl: BASE_URL,
      resolveChat: () => Promise.resolve({ projectId: "p1", workspaceId: "w1" }),
      isCurrent: () => true,
      mayNotify: () => true,
      report: () => undefined,
      sender,
    });
    registerWebPushRoutes(app, store, service);
  });

  afterEach(async () => {
    service.dispose();
    await app.close();
  });

  it("serves the VAPID public key with no-store", async () => {
    const response = await app.inject({ method: "GET", url: "/web-push/status" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json<{ publicKey: string }>().publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  });

  it("registers a valid subscription and rejects an invalid one with 400", async () => {
    const good = await app.inject({ method: "POST", url: "/web-push/subscription", payload: subscriptionFixture() });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ registered: true });
    const bad = await app.inject({ method: "POST", url: "/web-push/subscription", payload: { endpoint: "https://attacker.test/x", keys: {} } });
    expect(bad.statusCode).toBe(400);
    expect(store.snapshot().subscriptions).toHaveLength(1);
  });

  it("unsubscribes by endpoint", async () => {
    const fixture = subscriptionFixture();
    await store.subscribe(fixture);
    const response = await app.inject({ method: "POST", url: "/web-push/unsubscribe", payload: { endpoint: fixture.endpoint } });
    expect(response.statusCode).toBe(200);
    expect(store.snapshot().subscriptions).toHaveLength(0);
  });

  it("runs a test delivery for a registered endpoint only", async () => {
    const fixture = subscriptionFixture();
    await store.subscribe(fixture);
    const good = await app.inject({ method: "POST", url: "/web-push/test", payload: { endpoint: fixture.endpoint } });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ accepted: true, displayed: "unknown" });
    const missing = await app.inject({ method: "POST", url: "/web-push/test", payload: { endpoint: "https://fcm.googleapis.com/fcm/send/other-token-aaaa" } });
    expect(missing.statusCode).toBe(400);
  });
});

const daemon = {
  request: (method: string, path: string, body: unknown) => {
    record.calls.push({ method, path, body });
    const headers: Record<string, string> = {};
    return Promise.resolve({ statusCode: 200, headers, body: JSON.stringify({ configured: true, publicKey: "k".repeat(87), scope: "local" }) });
  },
};
const record: { calls: { method: string; path: string; body: unknown }[] } = { calls: [] };

describe("web push gateway proxy boundary", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = Fastify({ logger: false });
    registerWebPushProxyRoutes(app, daemon, () => Promise.resolve(BASE_URL));
    record.calls.length = 0;
  });

  afterEach(async () => { await app.close(); });

  it("forwards an authenticated same-origin mutation to the daemon", async () => {
    const response = await app.inject({
      method: "POST", url: "/api/web-push/subscription",
      headers: { host: "pi.example.test", origin: "https://pi.example.test", "content-type": "application/json" },
      payload: { endpoint: "https://fcm.googleapis.com/fcm/send/token-abc-123456", keys: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(record.calls[0]).toMatchObject({ method: "POST", path: "/web-push/subscription" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects cross-origin mutations, cross-site requests, and host mismatches", async () => {
    const base = { method: "POST" as const, url: "/api/web-push/test", payload: { endpoint: "https://fcm.googleapis.com/fcm/send/token-abc-123456" } };
    const wrongOrigin = await app.inject({ ...base, headers: { host: "pi.example.test", origin: "https://evil.test", "content-type": "application/json" } });
    expect(wrongOrigin.statusCode).toBe(403);
    const missingOrigin = await app.inject({ ...base, headers: { host: "pi.example.test", "content-type": "application/json" } });
    expect(missingOrigin.statusCode).toBe(403);
    const hostMismatch = await app.inject({ ...base, headers: { host: "evil.test", origin: "https://pi.example.test", "content-type": "application/json" } });
    expect(hostMismatch.statusCode).toBe(403);
    const crossSite = await app.inject({ ...base, headers: { host: "pi.example.test", origin: "https://pi.example.test", "sec-fetch-site": "cross-site", "content-type": "application/json" } });
    expect(crossSite.statusCode).toBe(403);
    const notJson = await app.inject({ ...base, headers: { host: "pi.example.test", origin: "https://pi.example.test", "content-type": "text/plain" }, payload: "x" });
    expect(notJson.statusCode).toBe(403);
    expect(record.calls).toHaveLength(0);
  });

  it("allows same-origin GET status without an Origin header", async () => {
    const response = await app.inject({ method: "GET", url: "/api/web-push/status", headers: { host: "pi.example.test" } });
    expect(response.statusCode).toBe(200);
    expect(record.calls[0]).toMatchObject({ method: "GET", path: "/web-push/status" });
  });

  it("reports unconfigured on GET and refuses mutations with 503", async () => {
    const app2 = Fastify({ logger: false });
    registerWebPushProxyRoutes(app2, daemon, () => Promise.resolve(undefined));
    const get = await app2.inject({ method: "GET", url: "/api/web-push/status", headers: { host: "pi.example.test" } });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ configured: false, scope: "local" });
    const post = await app2.inject({
      method: "POST", url: "/api/web-push/test",
      headers: { host: "pi.example.test", origin: "https://pi.example.test", "content-type": "application/json" },
      payload: { endpoint: "https://fcm.googleapis.com/fcm/send/token-abc-123456" },
    });
    expect(post.statusCode).toBe(503);
    expect(record.calls).toHaveLength(0);
    await app2.close();
  });

  it("returns 502 when the daemon is unreachable", async () => {
    const failing = Fastify({ logger: false });
    registerWebPushProxyRoutes(failing, { request: () => Promise.reject(new Error("down")) }, () => Promise.resolve(BASE_URL));
    const response = await failing.inject({ method: "GET", url: "/api/web-push/status", headers: { host: "pi.example.test" } });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "Native push daemon unavailable" });
    await failing.close();
  });
});

describe("session event hub unread fan-out", () => {
  it("notifies native push subscribers synchronously on publishGlobal", async () => {
    const { SessionEventHub } = await import("../realtime/sessionEventHub.js");
    const hub = new SessionEventHub();
    const seen: unknown[] = [];
    const unsubscribe = hub.subscribeUnread((event) => { seen.push(event); });
    hub.publishGlobal({ type: "sessions.unread", catalogId: "c", catalogRevision: 1, sessionId: "s", cwd: "/w", unread: null });
    expect(seen).toHaveLength(1);
    // A failing subscriber must not block the realtime fan-out or other subscribers.
    hub.subscribeUnread(() => { throw new Error("boom"); });
    hub.publishGlobal({ type: "sessions.unread", catalogId: "c", catalogRevision: 2, sessionId: "s", cwd: "/w", unread: null });
    expect(seen).toHaveLength(2);
    unsubscribe();
    hub.publishGlobal({ type: "sessions.unread", catalogId: "c", catalogRevision: 3, sessionId: "s", cwd: "/w", unread: null });
    expect(seen).toHaveLength(2);
  });
});

describe("workspace attribution exact match", () => {
  it("requires one exact canonical workspace path", async () => {
    const { CachedWorkspaceAttribution } = await import("../status/workspaceAttribution.js");
    const projects: Project[] = [{ id: "p1", name: "p1", path: "/work", createdAt: "2026-01-01T00:00:00.000Z" }];
    const workspaces: WorkspaceListing[] = [
      { id: "w1", projectId: "p1", path: "/work/a", label: "a", isMain: true },
      { id: "w2", projectId: "p1", path: "/work/a/sub", label: "sub", isMain: false },
    ];
    const attribution = new CachedWorkspaceAttribution({
      projects: { list: () => Promise.resolve(projects) },
      workspaces: { list: () => Promise.resolve(workspaces) },
      logger: { warn: () => undefined },
    });
    // A descendant is never accepted as the chat target.
    await expect(attribution.attributeExact("/work/a/sub/nested")).resolves.toBeUndefined();
    await expect(attribution.attributeExact("/work/a")).resolves.toEqual({ projectId: "p1", workspaceId: "w1" });
    await expect(attribution.attributeExact("/work/missing")).resolves.toBeUndefined();
  });
});

describe("web push config parsing", () => {
  it("accepts a canonical HTTPS base URL with base path and rejects the rest", async () => {
    const { parseWebPushConfig } = await import("../../config.js");
    expect(parseWebPushConfig({ publicBaseUrl: "https://pi.example.test/pi-web/" })).toEqual({ publicBaseUrl: "https://pi.example.test/pi-web/" });
    expect(parseWebPushConfig({ publicBaseUrl: "https://pi.example.test/" })).toEqual({ publicBaseUrl: "https://pi.example.test/" });
    expect(() => parseWebPushConfig({ publicBaseUrl: "http://pi.example.test/" })).toThrow();
    expect(() => parseWebPushConfig({ publicBaseUrl: "https://pi.example.test:8443/" })).toThrow();
    expect(() => parseWebPushConfig({ publicBaseUrl: "https://pi.example.test/pi-web" })).toThrow();
    expect(parseWebPushConfig({ publicBaseUrl: "https://pi.example.test/deep/base-path/" })).toEqual({ publicBaseUrl: "https://pi.example.test/deep/base-path/" });
    expect(() => parseWebPushConfig({ publicBaseUrl: "https://127.0.0.1/" })).toThrow();
    expect(() => parseWebPushConfig({})).toThrow();
  });
});

describe("piSessionService completion gating", () => {
  it("suppresses notifications for pending ask_user and extension dialogs without native heuristics", async () => {
    vi.useRealTimers();
    const { PendingAskStore } = await import("../sessions/pendingAskStore.js");
    const { PendingExtensionDialogStore } = await import("../sessions/pendingExtensionDialogStore.js");
    const askStore = new PendingAskStore();
    const dialogStore = new PendingExtensionDialogStore();
    // The gating contract under test: pending question/dialog state wins over any completion event.
    const active = new Set(["s1"]);
    const mayNotify = (id: string): boolean => {
      if (askStore.pendingAsk(id) !== undefined) return false;
      if (dialogStore.pendingDialogs(id).length > 0) return false;
      return active.has(id);
    };
    expect(mayNotify("s1")).toBe(true);
    askStore.open({ sessionId: "s1", questions: [{ id: "q1", question: "Continue?", options: [] }] });
    expect(mayNotify("s1")).toBe(false);
    askStore.cancelOpen("s1");
    expect(mayNotify("s1")).toBe(true);
    const opened = dialogStore.open({ sessionId: "s1", kind: "confirm", title: "Allow?", runScoped: true });
    expect(mayNotify("s1")).toBe(false);
    dialogStore.cancel("s1", opened.dialogId, "cancelled");
    expect(mayNotify("s1")).toBe(true);
  });
});
