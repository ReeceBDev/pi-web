import { afterEach, describe, expect, it, vi } from "vitest";
import { flushVanishDiags, resetVanishDiagsForTests, setVanishDiagSinkForTests, vanishDiag, type VanishDiagEvent } from "./vanishDiagnostics";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  resetVanishDiagsForTests();
  setVanishDiagSinkForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("vanishDiagnostics", () => {
  it("hands each event to the sink with a timestamp and merged fields", () => {
    const events: VanishDiagEvent[] = [];
    setVanishDiagSinkForTests((event) => { events.push(event); });

    vanishDiag("boot", { urlSession: "session-1" });
    vanishDiag("vanish-candidate");

    expect(events.map(withTimestampType)).toEqual([
      { kind: "boot", t: "number", urlSession: "session-1" },
      { kind: "vanish-candidate", t: "number" },
    ]);
  });

  it("never lets a broken sink propagate into the caller", () => {
    setVanishDiagSinkForTests(() => { throw new Error("sink exploded"); });

    expect(() => { vanishDiag("boot", { detail: "anything" }); }).not.toThrow();
  });

  it("debounces queued events into one batched POST after two seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);

    vanishDiag("boot", { navType: "navigate" });
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/client-diagnostics");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    // Pagehide flushes race teardown; keepalive lets the POST outlive the page.
    expect(init?.keepalive).toBe(true);
    expect(sentEvents(init)).toEqual([{ kind: "boot", t: "number", navType: "navigate" }]);
  });

  it("flushes immediately when called directly (pagehide path)", () => {
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);

    vanishDiag("browser-resume");
    flushVanishDiags();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(sentEvents(init)).toEqual([{ kind: "browser-resume", t: "number" }]);

    flushVanishDiags();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends at most 50 events per request", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index < 60; index++) vanishDiag("boot", { index });

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(sentEvents(init)).toEqual(Array.from({ length: 50 }, (_, index) => ({ kind: "boot", t: "number", index })));
  });

  it("keeps only the most recent 100 events when the queue overflows", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);

    for (let index = 0; index < 150; index++) vanishDiag("boot", { index });

    await vi.advanceTimersByTimeAsync(2000);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    // The cap kept the 100 newest (indices 50-149); this flush sends its first half.
    expect(sentEvents(init)).toEqual(Array.from({ length: 50 }, (_, offset) => ({ kind: "boot", t: "number", index: 50 + offset })));
  });

  it("refills the queue and retries after a failed POST", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(() => Promise.reject(new Error("gateway down")));
    vi.stubGlobal("fetch", fetchMock);

    vanishDiag("boot", { attempt: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The failed batch is back in the queue; the next debounce re-sends it ahead of new events.
    vanishDiag("boot", { attempt: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] ?? [];
    expect(sentEvents(init)).toEqual([
      { kind: "boot", t: "number", attempt: 1 },
      { kind: "boot", t: "number", attempt: 2 },
    ]);
  });

  it("drops queued events and cancels the pending flush on reset", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchLike>(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);

    vanishDiag("boot");
    resetVanishDiagsForTests();
    await vi.advanceTimersByTimeAsync(5000);
    flushVanishDiags();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function withTimestampType(event: Record<string, unknown>): Record<string, unknown> {
  return { ...event, t: typeof event["t"] };
}

function sentEvents(init: RequestInit | undefined): Record<string, unknown>[] {
  const body = init?.body;
  if (typeof body !== "string") throw new Error(`expected a string body, got ${typeof body}`);
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || !Array.isArray(parsed["events"])) throw new Error("expected an events array in the POST body");
  return parsed["events"].map((event) => {
    if (!isRecord(event)) throw new Error("expected each event in the batch to be an object");
    return withTimestampType(event);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
