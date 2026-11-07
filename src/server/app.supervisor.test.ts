import { describe, expect, it } from "vitest";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";
import type { SupervisorResponse, UnitSupervisorDelegate } from "./machines/unitSupervisorClient.js";

registerAppTestHooks();

class FakeSupervisor implements UnitSupervisorDelegate {
  readonly calls: { method: string; url: string; body?: unknown }[] = [];
  private next: (method: string, url: string, body: unknown) => Promise<SupervisorResponse> =
    (method) => Promise.resolve(
      method === "POST" && this.calls[this.calls.length - 1]?.url === "/create"
        ? { status: 200, body: { unitName: "pi-1", machineId: "local", worktreePath: "/units/pi-1/worktrees/primary" } }
        : { status: 200, body: {} },
    );

  respondWith(handler: (method: string, url: string, body: unknown) => Promise<SupervisorResponse>): void {
    this.next = handler;
  }

  async create(body: unknown): Promise<SupervisorResponse> {
    this.calls.push({ method: "POST", url: "/create", body });
    return this.next("POST", "/create", body);
  }

  async addWorktree(body: unknown): Promise<SupervisorResponse> {
    this.calls.push({ method: "POST", url: "/worktree", body });
    return this.next("POST", "/worktree", body);
  }

  async unitByCwd(cwd: string): Promise<SupervisorResponse> {
    this.calls.push({ method: "GET", url: `/unit?cwd=${cwd}` });
    return this.next("GET", "/unit", cwd);
  }

  async unitStatus(query: Record<string, unknown>): Promise<SupervisorResponse> {
    this.calls.push({ method: "GET", url: `/unit-status?${JSON.stringify(query)}` });
    return this.next("GET", "/unit-status", query);
  }
}

describe("buildApp supervisor proxy routes", () => {
  it("proxies unit create to the injected supervisor and passes the response through", async () => {
    const supervisor = new FakeSupervisor();
    appTestContext.unitSupervisor = supervisor;

    const response = await appTestContext.app.inject({ method: "POST", url: "/api/supervisor/create", payload: { source: "/repos/pi" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ unitName: "pi-1", machineId: "local", worktreePath: "/units/pi-1/worktrees/primary" });
    expect(supervisor.calls[0]).toEqual({ method: "POST", url: "/create", body: { source: "/repos/pi" } });
  });

  it("surfaces supervisor failures as HTTP 502", async () => {
    const supervisor = new FakeSupervisor();
    supervisor.respondWith(() => Promise.reject(new Error("connect ECONNREFUSED")));
    appTestContext.unitSupervisor = supervisor;

    const response = await appTestContext.app.inject({ method: "POST", url: "/api/supervisor/create", payload: {} });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: "connect ECONNREFUSED" });
  });
});
