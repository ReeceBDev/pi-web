import { afterEach, describe, expect, it, vi } from "vitest";
import { UnitPromptGate, type GateFetchResponse } from "./unitPromptGate.js";

interface ScriptedResponse {
  status: number;
  body?: unknown;
}

function gateWith(script: (url: string, attempt: number) => ScriptedResponse | { fail: Error }): { gate: UnitPromptGate; calls: string[] } {
  const calls: string[] = [];
  let attempt = 0;
  const fetchImpl = vi.fn((input: string): Promise<GateFetchResponse> => {
    calls.push(input);
    const verdict = script(input, attempt);
    attempt += 1;
    if ("fail" in verdict) return Promise.reject(verdict.fail);
    return Promise.resolve({ status: verdict.status, ok: verdict.status < 400, json: () => Promise.resolve(verdict.body) });
  });
  return { gate: new UnitPromptGate({ baseUrl: "http://127.0.0.1:8765", fetchImpl, lookupTimeoutMs: 50, statusTimeoutMs: 50 }), calls };
}

function unitUnit(url: string): boolean {
  return url.includes("/unit?");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UnitPromptGate", () => {
  it("lets prompts through for directories outside any unit (fail open)", async () => {
    const { gate, calls } = gateWith(() => ({ status: 200, body: {} }));

    await expect(gate.gate("/home/rbowen/pi")).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("http://127.0.0.1:8765/unit?cwd=%2Fhome%2Frbowen%2Fpi");
  });

  it("caches cwd lookups so repeat prompts never refetch the unit", async () => {
    const { gate, calls } = gateWith((url) => (unitUnit(url) ? { status: 200, body: { unit: "/units/pi-1" } } : { status: 200, body: { ready: true } }));

    await gate.gate("/units/pi-1/worktrees/primary");
    await gate.gate("/units/pi-1/worktrees/primary");

    expect(calls.filter((url) => unitUnit(url))).toHaveLength(1);
  });

  it("holds prompts until the unit reports ready, then caches readiness", async () => {
    let statusCalls = 0;
    const { gate, calls } = gateWith((url) => {
      if (unitUnit(url)) return { status: 200, body: { unit: "/units/pi-2" } };
      statusCalls += 1;
      return { status: 200, body: { ready: statusCalls >= 2 } };
    });

    await expect(gate.gate("/units/pi-2/worktrees/primary")).resolves.toBeUndefined();
    expect(statusCalls).toBe(2);

    const before = calls.length;
    await gate.gate("/units/pi-2/worktrees/primary");
    expect(calls.length).toBe(before);
  });

  it("surfaces generation errors instead of delivering the prompt", async () => {
    const { gate } = gateWith((url) => {
      if (unitUnit(url)) return { status: 200, body: { unit: "/units/broken" } };
      return { status: 200, body: { ready: false, error: "worktree generation failed" } };
    });

    await expect(gate.gate("/units/broken/worktrees/primary")).rejects.toThrow("worktree generation failed");
  });

  it("fails open when the supervisor is unreachable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { gate } = gateWith(() => ({ fail: new Error("connect ECONNREFUSED") }));

    await expect(gate.gate("/units/pi-3/worktrees/primary")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("serializes parked prompts per unit in arrival order", async () => {
    let statusCalls = 0;
    const { gate } = gateWith((url) => {
      if (unitUnit(url)) return { status: 200, body: { unit: "/units/pi-4" } };
      statusCalls += 1;
      return { status: 200, body: { ready: statusCalls >= 4 } };
    });

    const order: string[] = [];
    const first = gate.gate("/units/pi-4/worktrees/primary").then(() => {
      order.push("first");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = gate.gate("/units/pi-4/worktrees/primary").then(() => {
      order.push("second");
    });
    await Promise.all([first, second]);

    expect(order).toEqual(["first", "second"]);
  });
});
