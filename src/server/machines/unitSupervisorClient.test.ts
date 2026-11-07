import { describe, expect, it, vi } from "vitest";
import { UnitSupervisorClient, type SupervisorFetchResponse } from "./unitSupervisorClient.js";

function fakeFetch(status: number, body: unknown): { fetch: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<SupervisorFetchResponse>>> } {
  const fetch = vi.fn((): Promise<SupervisorFetchResponse> => Promise.resolve({
    status,
    json: () => Promise.resolve(body),
  }));
  return { fetch };
}

describe("UnitSupervisorClient", () => {
  it("posts create requests with a JSON body to the supervisor base URL", async () => {
    const { fetch } = fakeFetch(200, { unitName: "pi-1", worktreePath: "/units/pi-1/worktrees/primary" });
    const client = new UnitSupervisorClient({ baseUrl: "http://127.0.0.1:8765", fetchImpl: fetch });

    const response = await client.create({ source: "/home/rbowen/pi" });

    expect(fetch.mock.calls[0]).toEqual([
      "http://127.0.0.1:8765/create",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "/home/rbowen/pi" }) },
    ]);
    expect(response).toEqual({ status: 200, body: { unitName: "pi-1", worktreePath: "/units/pi-1/worktrees/primary" } });
  });

  it("encodes cwd lookups as a query string and posts worktree creation", async () => {
    const { fetch } = fakeFetch(200, {});
    const client = new UnitSupervisorClient({ baseUrl: "http://127.0.0.1:8765", fetchImpl: fetch });

    await client.unitByCwd("/home/rbowen/units/pi-1/worktrees/primary");
    await client.addWorktree({ cwd: "/home/rbowen/units/pi-1/worktrees/primary" });
    await client.unitStatus({ unit: "pi-1" });

    const calls = fetch.mock.calls.map(([url]) => url);
    expect(calls[0]).toBe("http://127.0.0.1:8765/unit?cwd=%2Fhome%2Frbowen%2Funits%2Fpi-1%2Fworktrees%2Fprimary");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(calls[1]).toBe("http://127.0.0.1:8765/worktree");
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(calls[2]).toBe("http://127.0.0.1:8765/unit-status?unit=pi-1");
  });

  it("passes supervisor status codes through and tolerates non-JSON bodies", async () => {
    const fetch = vi.fn((): Promise<SupervisorFetchResponse> => Promise.resolve({
      status: 409,
      json: () => Promise.reject(new Error("not JSON")),
    }));
    const client = new UnitSupervisorClient({ baseUrl: "http://127.0.0.1:8765", fetchImpl: fetch });

    const response = await client.unitByCwd("/somewhere");

    expect(response).toEqual({ status: 409, body: undefined });
  });
});
