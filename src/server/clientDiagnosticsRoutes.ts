import type { FastifyInstance } from "fastify";

/** A single client-reported diagnostic event. Shape is intentionally open: the
 * client controls its own fields, the server only enforces transport bounds. */
export type ClientDiagnosticEvent = Record<string, unknown>;

export interface ClientDiagnosticsRouteOptions {
  /** Maximum events accepted per request; larger batches are rejected so a
   * runaway client cannot flood the log sink in one call. */
  maxEventsPerRequest?: number;
  /** Maximum serialized size per event; oversized events are rejected. */
  maxEventChars?: number;
}

const KIND_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_MAX_EVENT_CHARS = 2000;

/**
 * Client-side diagnostics sink: the browser has no durable log of its own
 * state transitions, so vanish-class failures (a chat disappearing from the
 * session list) were invisible. The client batches its diagnostic events and
 * POSTs them here; each event is written as one `vanish-diag`-tagged line
 * in the pi-web journal (journald — queryable with `journalctl --user -u pi-web`).
 */
export function registerClientDiagnosticsRoutes(app: FastifyInstance, options: ClientDiagnosticsRouteOptions = {}): void {
  const maxEventsPerRequest = options.maxEventsPerRequest ?? DEFAULT_MAX_EVENTS;
  const maxEventChars = options.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;

  app.post("/api/client-diagnostics", async (request, reply) => {
    const body: unknown = request.body;
    const events = isRecord(body) ? body["events"] : undefined;
    if (!Array.isArray(events) || events.length === 0) return reply.code(400).send({ error: "events array required" });
    if (events.length > maxEventsPerRequest) return reply.code(413).send({ error: `too many events (max ${String(maxEventsPerRequest)})` });
    const accepted: ClientDiagnosticEvent[] = [];
    for (const event of events) {
      if (!isRecord(event)) return reply.code(400).send({ error: "each event must be an object" });
      const kind = event["kind"];
      if (typeof kind !== "string" || !KIND_PATTERN.test(kind)) return reply.code(400).send({ error: "invalid event kind" });
      if (JSON.stringify(event).length > maxEventChars) return reply.code(413).send({ error: "event too large" });
      accepted.push(event);
    }
    for (const event of accepted) {
      request.log.info({ tag: "vanish-diag", ...event });
    }
    return reply.code(204).send();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
