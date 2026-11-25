import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerClientDiagnosticsRoutes, type ClientDiagnosticsRouteOptions } from "./clientDiagnosticsRoutes.js";

let lines: string[];

beforeEach(() => {
  lines = [];
});

afterEach(() => {
  lines = [];
});

describe("client diagnostics route", () => {
  it("writes one tagged log line per accepted event", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/client-diagnostics",
      payload: { events: [{ kind: "boot", navType: "navigate" }, { kind: "vanish-candidate", selInFetched: false }] },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    const events = diagEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ tag: "vanish-diag", kind: "boot", navType: "navigate" });
    expect(events[1]).toMatchObject({ tag: "vanish-diag", kind: "vanish-candidate", selInFetched: false });
  });

  it("rejects a missing or empty events array without logging", async () => {
    const app = buildApp();

    const noBody = await app.inject({ method: "POST", url: "/api/client-diagnostics" });
    const noEvents = await app.inject({ method: "POST", url: "/api/client-diagnostics", payload: {} });
    const emptyEvents = await app.inject({ method: "POST", url: "/api/client-diagnostics", payload: { events: [] } });
    const notAnArray = await app.inject({ method: "POST", url: "/api/client-diagnostics", payload: { events: "boot" } });

    for (const response of [noBody, noEvents, emptyEvents, notAnArray]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "events array required" });
    }
    expect(diagEvents()).toEqual([]);
  });

  it("rejects malformed events without logging", async () => {
    const app = buildApp();

    const notAnObject = await app.inject({ method: "POST", url: "/api/client-diagnostics", payload: { events: [{ kind: "boot" }, 42] } });
    expect(notAnObject.statusCode).toBe(400);
    expect(notAnObject.json()).toEqual({ error: "each event must be an object" });

    const missingKind = await app.inject({ method: "POST", url: "/api/client-diagnostics", payload: { events: [{ t: 1 }] } });
    expect(missingKind.statusCode).toBe(400);
    expect(missingKind.json()).toEqual({ error: "invalid event kind" });

    const badKind = await app.inject({ method: "POST", url: "/api/client-diagnostics", payload: { events: [{ kind: "Boot!" }] } });
    expect(badKind.statusCode).toBe(400);
    expect(badKind.json()).toEqual({ error: "invalid event kind" });
    expect(diagEvents()).toEqual([]);
  });

  it("rejects oversized batches and oversized events", async () => {
    const app = buildApp();

    const tooMany = await app.inject({
      method: "POST",
      url: "/api/client-diagnostics",
      payload: { events: Array.from({ length: 51 }, (_, index) => ({ kind: "boot", index })) },
    });
    expect(tooMany.statusCode).toBe(413);
    expect(tooMany.json()).toEqual({ error: "too many events (max 50)" });

    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/client-diagnostics",
      payload: { events: [{ kind: "boot", detail: "x".repeat(2100) }] },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({ error: "event too large" });
    expect(diagEvents()).toEqual([]);
  });

  it("honors custom transport bounds", async () => {
    const app = buildApp({ maxEventsPerRequest: 2, maxEventChars: 100 });

    const tooMany = await app.inject({
      method: "POST",
      url: "/api/client-diagnostics",
      payload: { events: [{ kind: "boot" }, { kind: "browser-resume" }, { kind: "boot" }] },
    });
    expect(tooMany.statusCode).toBe(413);
    expect(tooMany.json()).toEqual({ error: "too many events (max 2)" });

    const tooLarge = await app.inject({
      method: "POST",
      url: "/api/client-diagnostics",
      payload: { events: [{ kind: "boot", detail: "x".repeat(120) }] },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json()).toEqual({ error: "event too large" });

    const accepted = await app.inject({ method: "POST", url: "/api/client-diagnostics", payload: { events: [{ kind: "boot" }] } });
    expect(accepted.statusCode).toBe(204);
    expect(diagEvents()).toHaveLength(1);
  });
});

function buildApp(options?: ClientDiagnosticsRouteOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: "info",
      stream: new Writable({
        write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
          lines.push(chunk.toString());
          callback();
        },
      }),
    },
  });
  registerClientDiagnosticsRoutes(app, options);
  return app;
}

function diagEvents(): Record<string, unknown>[] {
  const parsed: unknown[] = lines.map((line): unknown => JSON.parse(line));
  return parsed.filter(isRecord).filter((event) => event["tag"] === "vanish-diag");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
