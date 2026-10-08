import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionProxyDaemon } from "../sessiond/sessionProxyRoutes.js";
import { validatePushEndpoint, type WebPushStore } from "./webPushStore.js";
import type { WebPushService } from "./webPushService.js";

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
