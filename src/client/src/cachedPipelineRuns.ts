import type { SessionInfo } from "./api";
import { createMemoryStorage } from "./cachedNewSessions";

/** Save a submission identity before sending, then replace it with the run
 * acknowledgement. Uncertain submissions and launched runs both survive reloads. */
const storageKey = "pi-web:pipeline-runs:v1";
const defaultMachineId = "local";
const maxRuns = 30;

export interface CachedPipelineRunInfo {
  runId: string;
  cwd: string;
  goal: string;
  created: string;
  machineId: string;
  requestId?: string;
  submissionPending?: boolean;
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

export function rememberPipelineRun(run: CachedPipelineRunInfo, storage: Storage | undefined = browserStorage()): boolean {
  const runs = loadPipelineRuns(storage).filter((candidate) => candidate.machineId !== run.machineId || (candidate.runId !== run.runId && (run.requestId === undefined || candidate.requestId !== run.requestId)));
  let completed = 0;
  return savePipelineRuns([run, ...runs].filter((candidate) => candidate.submissionPending === true || ++completed <= maxRuns), storage);
}

/** Save the identity before sending; a reload must not turn an uncertain launch into a new request. */
export function rememberPipelineSubmission(run: CachedPipelineRunInfo, storage: Storage | undefined = browserStorage()): boolean {
  if (storage === undefined || (storageOverride === undefined && storage === memoryStorage)) return false;
  return rememberPipelineRun({ ...run, submissionPending: true }, storage);
}

export function forgetPipelineRun(runId: string, machineId = defaultMachineId, storage: Storage | undefined = browserStorage()): void {
  const runs = loadPipelineRuns(storage).filter((candidate) => candidate.runId !== runId || candidate.machineId !== machineId);
  savePipelineRuns(runs, storage);
}

/** Restored rows carry pipelineRunId so the controller can register a live
 * pending start (status / approve / revise routing) for each of them. */
export type RestoredPipelineRunSessionInfo = SessionInfo & { clientPendingStart: true; machineId: string; pipelineRunId: string; pipelineSubmission?: { requestId: string; goal: string } };

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
    name: run.submissionPending === true ? "Pipeline submission" : "Pipeline run",
    created: run.created,
    modified: run.created,
    messageCount: 1,
    firstMessage: run.goal,
    clientPendingStart: true,
    machineId: run.machineId,
    pipelineRunId: run.runId,
    ...(run.submissionPending === true && run.requestId !== undefined ? { pipelineSubmission: { requestId: run.requestId, goal: run.goal } } : {}),
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

function savePipelineRuns(runs: CachedPipelineRunInfo[], storage: Storage | undefined): boolean {
  try {
    if (storage === undefined) return false;
    if (runs.length === 0) { storage.removeItem(storageKey); return storage.getItem(storageKey) === null; }
    const encoded = JSON.stringify(runs);
    storage.setItem(storageKey, encoded);
    return storage.getItem(storageKey) === encoded;
  } catch {
    return false;
  }
}

function parsePipelineRun(value: unknown): CachedPipelineRunInfo[] {
  if (!isRecord(value)) return [];
  const runId = value["runId"];
  const cwd = value["cwd"];
  const goal = value["goal"];
  const created = value["created"];
  const machineId = value["machineId"];
  const requestId = value["requestId"];
  const submissionPending = value["submissionPending"] === true;
  if (submissionPending && (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId))) return [];
  if (typeof runId !== "string" || runId === "" || typeof cwd !== "string" || typeof goal !== "string" || typeof created !== "string") return [];
  return [{ runId, cwd, goal, created, machineId: typeof machineId === "string" ? machineId : defaultMachineId, ...(typeof requestId === "string" ? { requestId } : {}), ...(submissionPending ? { submissionPending: true } : {}) }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
