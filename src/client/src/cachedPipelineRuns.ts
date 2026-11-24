import type { SessionInfo, PipelineRunListEntry } from "./api";
import { createMemoryStorage } from "./cachedNewSessions";

/** Launched pipeline run rows survive reloads. The live pending start dies
 * with the page (mobile tab discard, refresh), but the run keeps driving in
 * the pipeline — the row is rebuilt from this storage on the next session
 * listing so status / approve / revise keep working in that chat. */
const storageKey = "pi-web:pipeline-runs:v1";
const defaultMachineId = "local";
const maxRuns = 30;

export interface CachedPipelineRunInfo {
  runId: string;
  cwd: string;
  goal: string;
  created: string;
  machineId: string;
}

let memoryStorage: Storage | undefined;
let storageOverride: Storage | undefined;

/** Test hook: pipeline storage follows localStorage in the browser, but node
 * environment tests inject an in-memory Storage here. */
export function setPipelineRunStorageOverrideForTests(storage: Storage | undefined): void {
  storageOverride = storage;
}

function browserStorage(): Storage | undefined {
  if (storageOverride !== undefined) return storageOverride;
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // localStorage blocked (privacy settings) throws on access: keep restored
    // rows alive in memory for this page view. In-memory only — lost on reload.
    return (memoryStorage ??= createMemoryStorage());
  }
}

export function rememberPipelineRun(run: CachedPipelineRunInfo, storage: Storage | undefined = browserStorage()): void {
  const runs = loadPipelineRuns(storage).filter((candidate) => candidate.runId !== run.runId || candidate.machineId !== run.machineId);
  savePipelineRuns([run, ...runs].slice(0, maxRuns), storage);
}

export function forgetPipelineRun(runId: string, machineId = defaultMachineId, storage: Storage | undefined = browserStorage()): void {
  const runs = loadPipelineRuns(storage).filter((candidate) => candidate.runId !== runId || candidate.machineId !== machineId);
  savePipelineRuns(runs, storage);
}

/** Recover the run list from the gateway when the local cache holds no row for
 * this workspace+machine (a fresh browser must not lose its runs). Rows
 * carrying their own cwd seed other workspaces too; cwd-less (memo-less) rows
 * are attributed to the requesting workspace — the CLI never invents values,
 * the merge decides. Returns true when the cache gained rows. */
export async function recoverPipelineRuns(cwd: string, machineId: string, fetchRuns: () => Promise<PipelineRunListEntry[]>, storage: Storage | undefined = browserStorage()): Promise<boolean> {
  if (loadPipelineRuns(storage).some((run) => run.machineId === machineId && run.cwd === cwd)) return false;
  let runs: PipelineRunListEntry[];
  try {
    runs = await fetchRuns();
  } catch {
    return false;
  }
  for (const run of runs) {
    rememberPipelineRun({ runId: run.runId, cwd: run.cwd ?? cwd, goal: run.goal, created: run.created, machineId }, storage);
  }
  return runs.length > 0;
}

/** Restored rows carry pipelineRunId so the controller can register a live
 * pending start (status / approve / revise routing) for each of them. */
export type RestoredPipelineRunSessionInfo = SessionInfo & { clientPendingStart: true; machineId: string; pipelineRunId: string };

export function isRestoredPipelineRunSession(session: SessionInfo | undefined): session is RestoredPipelineRunSessionInfo {
  return isRecord(session)
    && session["clientPendingStart"] === true
    && typeof session["pipelineRunId"] === "string";
}

export function mergePipelineRuns(cwd: string, sessions: SessionInfo[], machineId = defaultMachineId, storage: Storage | undefined = browserStorage()): SessionInfo[] {
  const known = new Set(sessions.map((session) => session.id));
  const restored = loadPipelineRuns(storage)
    .filter((run) => run.machineId === machineId && run.cwd === cwd && !known.has(run.runId))
    .map((run) => restoredPipelineRunSession(run));
  return [...restored, ...sessions];
}

function restoredPipelineRunSession(run: CachedPipelineRunInfo): RestoredPipelineRunSessionInfo {
  return {
    id: run.runId,
    path: `pi-web://pipeline-run/${run.runId}`,
    cwd: run.cwd,
    persisted: false,
    name: "Pipeline run",
    created: run.created,
    modified: run.created,
    messageCount: 1,
    firstMessage: run.goal,
    clientPendingStart: true,
    machineId: run.machineId,
    pipelineRunId: run.runId,
  };
}

export function loadPipelineRuns(storage: Storage | undefined = browserStorage()): CachedPipelineRunInfo[] {
  try {
    const raw = storage?.getItem(storageKey);
    if (raw === undefined || raw === null || raw === "") return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((candidate) => parsePipelineRun(candidate));
  } catch {
    return [];
  }
}

function savePipelineRuns(runs: CachedPipelineRunInfo[], storage: Storage | undefined): void {
  try {
    if (runs.length === 0) storage?.removeItem(storageKey);
    else storage?.setItem(storageKey, JSON.stringify(runs));
  } catch {
    // Ignore localStorage quota/privacy errors.
  }
}

function parsePipelineRun(value: unknown): CachedPipelineRunInfo[] {
  if (!isRecord(value)) return [];
  const runId = value["runId"];
  const cwd = value["cwd"];
  const goal = value["goal"];
  const created = value["created"];
  const machineId = value["machineId"];
  if (typeof runId !== "string" || runId === "" || typeof cwd !== "string" || typeof goal !== "string" || typeof created !== "string") return [];
  return [{ runId, cwd, goal, created, machineId: typeof machineId === "string" ? machineId : defaultMachineId }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
