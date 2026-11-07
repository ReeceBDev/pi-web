/**
 * First-message gate for sandbox units (behaviour ported from the hephaestus
 * dist patch series, 2026-11-07).
 *
 * A session whose cwd sits inside a unit (a directory holding profile.json and
 * worktrees/, created by the session supervisor) has its prompts held until
 * that unit's worktree generation is done: generating units long-poll
 * /unit-status and the prompt either proceeds once {"ready":true} arrives or
 * throws the generation error so the prompt route surfaces it. Sessions
 * outside any unit, and any supervisor unreachability or timeout with no
 * verdict, fail open. Per-unit promise chains keep parked prompts strictly in
 * arrival order; ready units and resolved cwds are cached so later prompts
 * never fetch again.
 */
export type GateFetchResponse = Pick<Response, "ok" | "status" | "json">;
type GateFetch = (input: string, init?: RequestInit) => Promise<GateFetchResponse>;

export class UnitPromptGate {
  private readonly baseUrl: string;
  private readonly fetchImpl: GateFetch;
  private readonly lookupTimeoutMs: number;
  private readonly statusTimeoutMs: number;
  private readonly unitOfCwd = new Map<string, string | undefined>();
  private readonly unitReady = new Map<string, true>();
  private readonly gateChain = new Map<string, Promise<void>>();
  private readonly warnedCwds = new Set<string>();

  constructor(options: { baseUrl?: string; fetchImpl?: GateFetch; lookupTimeoutMs?: number; statusTimeoutMs?: number } = {}) {
    this.baseUrl = options.baseUrl ?? process.env["PI_WEB_UNIT_SUPERVISOR_URL"] ?? "http://127.0.0.1:8765";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? 2_000;
    this.statusTimeoutMs = options.statusTimeoutMs ?? 15_000;
  }

  /** Hold the current prompt until the unit that owns `cwd` is ready. */
  async gate(cwd: string): Promise<void> {
    const unit = await this.unitFor(cwd);
    if (unit === undefined || this.unitReady.get(unit) === true) return;
    const previous = this.gateChain.get(unit) ?? Promise.resolve();
    const gate = previous.catch(() => undefined).then(() => this.parkUntilReady(unit));
    this.gateChain.set(unit, gate);
    await gate;
  }

  private async unitFor(cwd: string): Promise<string | undefined> {
    if (this.unitOfCwd.has(cwd)) return this.unitOfCwd.get(cwd);
    let unit: string | undefined;
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/unit?${new URLSearchParams({ cwd }).toString()}`,
        { signal: AbortSignal.timeout(this.lookupTimeoutMs) },
      );
      unit = response.ok ? parseUnit(await response.json()) : undefined;
    } catch {
      unit = undefined;
    }
    this.unitOfCwd.set(cwd, unit);
    if (unit === undefined) this.warnNoUnit(cwd);
    return unit;
  }

  private async parkUntilReady(unit: string): Promise<void> {
    for (;;) {
      let verdict: UnitStatus | undefined;
      try {
        verdict = await this.unitStatus(unit);
      } catch (error) {
        this.warn(`unit-status unreachable for ${unit}: ${describe(error)}; failing open`);
        return;
      }
  if (verdict?.ready === true) {
    this.unitReady.set(unit, true);
    return;
  }
  if (verdict?.ready === false && typeof verdict.error === "string") {
    throw new Error(verdict.error);
  }
      // Still generating (or an inconclusive answer): keep polling —
      // worktree generation is milliseconds; an unreachable supervisor
      // times out per poll and lands in the catch above (fail-open).
    }
  }

  private async unitStatus(unit: string): Promise<UnitStatus | undefined> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/unit-status?${new URLSearchParams({ unit }).toString()}`,
      { signal: AbortSignal.timeout(this.statusTimeoutMs) },
    );
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return isUnitStatus(body) ? body : undefined;
  }

  private warnNoUnit(cwd: string): void {
    if (this.warnedCwds.has(cwd)) return;
    this.warnedCwds.add(cwd);
    this.warn(`no unit for ${cwd}; prompt gate off for this path`);
  }

  private warn(message: string): void {
    console.warn(`[unit-prompt-gate] ${message}`);
  }
}

interface UnitStatus {
  ready?: boolean;
  error?: unknown;
}

function parseUnit(body: unknown): string | undefined {
  return isRecord(body) && typeof body["unit"] === "string" ? body["unit"] : undefined;
}

function isRecord(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null;
}

function isUnitStatus(body: unknown): body is UnitStatus {
  return isRecord(body);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Process-wide gate: prompt submission is serialized per session service. */
export const unitPromptGate = new UnitPromptGate();
