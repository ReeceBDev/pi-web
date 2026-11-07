/**
 * Client for the local session supervisor — the service that creates unit
 * directories (root, profile.json, worktrees/primary) and additional unit
 * worktrees for sandboxed unit chats. The supervisor listens on this box's
 * loopback only; the web/API process proxies browser requests to it so the
 * browser never needs a direct route to the supervisor port.
 *
 * The base URL defaults to the supervisor's loopback address and can be
 * overridden with PI_WEB_UNIT_SUPERVISOR_URL for split deployments.
 */
export interface SupervisorResponse {
  status: number;
  body: unknown;
}

export type SupervisorFetchResponse = Pick<Response, "status" | "json">;
type FetchLike = (input: string, init?: RequestInit) => Promise<SupervisorFetchResponse>;

/** The four supervisor operations the web/API surface, as an interface so
 * routes and tests can use fakes without touching HTTP internals. */
export interface UnitSupervisorDelegate {
  create(body: unknown): Promise<SupervisorResponse>;
  addWorktree(body: unknown): Promise<SupervisorResponse>;
  unitByCwd(cwd: string): Promise<SupervisorResponse>;
  unitStatus(query: Record<string, unknown>): Promise<SupervisorResponse>;
}

export class UnitSupervisorClient implements UnitSupervisorDelegate {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: { baseUrl?: string; fetchImpl?: FetchLike } = {}) {
    this.baseUrl = options.baseUrl ?? process.env["PI_WEB_UNIT_SUPERVISOR_URL"] ?? "http://127.0.0.1:8765";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Create a unit for the given source checkout; returns its name and the
   * primary worktree path the new session should use. */
  async create(body: unknown): Promise<SupervisorResponse> {
    return this.request("POST", "/create", JSON.stringify(body ?? {}));
  }

  /** Create an additional worktree inside an existing unit. */
  async addWorktree(body: unknown): Promise<SupervisorResponse> {
    return this.request("POST", "/worktree", JSON.stringify(body ?? {}));
  }

  /** Resolve the unit (if any) that owns a working directory. */
  async unitByCwd(cwd: string): Promise<SupervisorResponse> {
    return this.request("GET", `/unit?${new URLSearchParams({ cwd }).toString()}`);
  }

  /** Long-poll a unit's generation status; query fields pass through unchanged. */
  async unitStatus(query: Record<string, unknown>): Promise<SupervisorResponse> {
    return this.request("GET", `/unit-status?${new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)]),
    ).toString()}`);
  }

  private async request(method: "GET" | "POST", path: string, body?: string): Promise<SupervisorResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body }),
    });
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  }
}
