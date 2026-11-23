export interface VanishDiagEvent {
  kind: string;
  t: number;
  [field: string]: unknown;
}

type VanishDiagSink = (event: VanishDiagEvent) => void;

const ENDPOINT = "/api/client-diagnostics";
const MAX_QUEUE = 100;
const MAX_BATCH = 50;
const FLUSH_DELAY_MS = 2000;

let queue: VanishDiagEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let sink: VanishDiagSink = networkSink;

/**
 * Record one client-side diagnostic event for server-side logging. Events are
 * batched and POSTed to the gateway's client-diagnostics sink, which writes
 * each one as a `vanish-diag` log line (journal → Loki). Used for the
 * session-list state transitions that decide whether an open chat stays
 * visible, so a vanished chat can be reconstructed from the server logs.
 * Never throws: diagnostics must not break the app path they observe.
 */
export function vanishDiag(kind: string, fields: Record<string, unknown> = {}): void {
  try {
    sink({ kind, t: Date.now(), ...fields });
  } catch {
    // A broken sink must never take the app down with it.
  }
}

/** Replace the event sink (tests point this at a capturing array). */
export function setVanishDiagSinkForTests(replacement: VanishDiagSink | undefined): void {
  sink = replacement ?? networkSink;
}

function networkSink(event: VanishDiagEvent): void {
  queue.push(event);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  flushTimer ??= setTimeout(flushVanishDiags, FLUSH_DELAY_MS);
}

/** Send the queued events now; called by the debounce timer and on pagehide. */
export function flushVanishDiags(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (queue.length === 0 || typeof fetch === "undefined") return;
  const batch = queue.splice(0, MAX_BATCH);
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: batch }),
    // Survive page unload — the flush on pagehide races the page teardown.
    keepalive: true,
  }).catch(() => {
    // Server unreachable: put the batch back (bounded) and let the next
    // flush attempt re-send it.
    queue = [...batch, ...queue].slice(-MAX_QUEUE);
  });
}

/** Drop queued events and cancel the pending flush (test isolation). */
export function resetVanishDiagsForTests(): void {
  queue = [];
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
}
