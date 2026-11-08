import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { validatePushEndpoint, type WebPushStore } from "./webPushStore.js";
import type { WebPushService } from "./webPushService.js";
import { validateFcmToken, type FcmPushStore } from "./fcmPushStore.js";
import type { FcmPushService } from "./fcmPushService.js";

/** Trusted internal daemon routes. Public access goes through the gateway checks below. */
export function registerWebPushRoutes(app: FastifyInstance, store: WebPushStore, service: WebPushService): void {
  app.get("/web-push/status", (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { configured: true, publicKey: store.snapshot().vapid.publicKey, scope: "local" };
  });
  app.post("/web-push/subscription", { bodyLimit: 4096 }, async (request, reply) => {
    try { await store.subscribe(request.body); return { registered: true }; }
    catch { return reply.code(400).send({ error: "Cannot register push subscription" }); }
  });
  app.post("/web-push/unsubscribe", { bodyLimit: 4096 }, async (request, reply) => {
    try { await store.unsubscribe(endpointBody(request.body)); return { registered: false }; }
    catch { return reply.code(400).send({ error: "Cannot unregister push subscription" }); }
  });
  app.post("/web-push/test", { bodyLimit: 4096 }, async (request, reply) => {
    try { const accepted = await service.test(endpointBody(request.body)); return { accepted, displayed: "unknown" }; }
    catch { return reply.code(400).send({ error: "Cannot test push subscription; enable or retry" }); }
  });
}
function endpointBody(value: unknown): string {
  if (value === null || typeof value !== "object" || !("endpoint" in value)) throw new Error("Endpoint required");
  return validatePushEndpoint(value.endpoint);
}

/** Trusted internal daemon routes for FCM token management. Public access goes through the gateway proxy. */
export function registerFcmRoutes(app: FastifyInstance, store: FcmPushStore, service: FcmPushService): void {
  app.post("/fcm/subscribe", { bodyLimit: 8192 }, async (request, reply) => {
    try { await store.subscribe(fcmTokenBody(request.body)); return { registered: true }; }
    catch { return reply.code(400).send({ error: "Cannot register FCM token" }); }
  });
  app.post("/fcm/unsubscribe", { bodyLimit: 8192 }, async (request, reply) => {
    try { await store.unsubscribe(fcmTokenBody(request.body)); return { registered: false }; }
    catch { return reply.code(400).send({ error: "Cannot unregister FCM token" }); }
  });
  app.get("/fcm/health", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return service.health();
  });
  app.post("/fcm/diag", { bodyLimit: 8192 }, async (request) => {
    const parsed = fcmRecordBody(request.body);
    const event = typeof parsed["event"] === "string" ? parsed["event"].slice(0, 80) : "unknown";
    const fields = fcmRecordBody(parsed["fields"]);
    await store.pushDiag(event, fields);
    return { stored: true };
  });
}
function fcmTokenBody(value: unknown): string {
  if (value === null || typeof value !== "object" || !("token" in value)) throw new Error("Token required");
  return validateFcmToken(value.token);
}

function fcmRecordBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return { ...value };
}

/** CSRF/rebinding guard, NOT authentication. Access/AOP remains the public auth boundary. */
export function pushBrowserRequestAllowed(request: FastifyRequest, baseUrl: string): boolean {
  const canonical = new URL(baseUrl);
  if (request.headers.host !== canonical.host || request.headers["sec-fetch-site"] === "cross-site") return false;
  if (request.method === "GET") return true;
  return request.headers.origin === canonical.origin && request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function registerWebPushProxyRoutes(app: FastifyInstance, daemon: Pick<SessionProxyDaemon, "request">, readBaseUrl: () => Promise<string | undefined>): void {
  for (const [method, path] of [["GET", "status"], ["POST", "subscription"], ["POST", "unsubscribe"], ["POST", "test"]] as const) {
    app.route({ method, url: `/api/web-push/${path}`, bodyLimit: 4096, handler: async (request, reply) => {
      reply.header("cache-control", "no-store");
      const baseUrl = await readBaseUrl();
      if (baseUrl === undefined) return method === "GET" ? { configured: false, scope: "local" } : reply.code(503).send({ error: "Native push is not configured" });
      if (!pushBrowserRequestAllowed(request, baseUrl)) return reply.code(403).send({ error: "Push browser boundary rejected request" });
      try {
        const upstream = await daemon.request(method, `/web-push/${path}`, request.body);
        reply.code(upstream.statusCode);
        const value: unknown = JSON.parse(upstream.body);
        return value;
      } catch { return reply.code(502).send({ error: "Native push daemon unavailable" }); }
    } });
  }
}

/**
 * Public gateway paths consumed by the box-launcher Android app (injected in-page fetch + Dart diag).
 * Exact `/plugins-api/box-push/*` paths match the launcher's F9 registration contract so one injected
 * snippet works on both gui (pi-web-ui plugin) and hephaestus (this proxy). The subscribe/unsubscribe
 * pair keeps the same-origin browser guard; the Dart diag/health callers send no Origin header.
 */
export function registerFcmProxyRoutes(app: FastifyInstance, daemon: Pick<SessionProxyDaemon, "request">, readBaseUrl: () => Promise<string | undefined>): void {
  for (const [method, path, browserGuard] of [["POST", "subscribe", true], ["POST", "unsubscribe", true], ["GET", "health", false], ["POST", "diag", false]] as const) {
    app.route({ method, url: `/plugins-api/box-push/${path}`, bodyLimit: 8192, handler: async (request, reply) => {
      reply.header("cache-control", "no-store");
      const baseUrl = await readBaseUrl();
      if (baseUrl === undefined) return method === "GET" ? { ok: false, tokens: 0, serviceAccountConfigured: false } : reply.code(503).send({ error: "FCM push is not configured" });
      if (browserGuard && !pushBrowserRequestAllowed(request, baseUrl)) return reply.code(403).send({ error: "Push browser boundary rejected request" });
      try {
        const upstream = await daemon.request(method, `/fcm/${path}`, request.body);
        reply.code(upstream.statusCode);
        const value: unknown = JSON.parse(upstream.body);
        return value;
      } catch { return reply.code(502).send({ error: "FCM push daemon unavailable" }); }
    } });
  }
}
