import { isPipelineExecutionId, readPipelineApproval, type PipelineApprovalBinding } from "../../shared/pipelineApproval";
import type { ChatLine, ChatPart } from "./components/shared";
import type { SessionInfo } from "./api";
import { createMemoryStorage } from "./cachedNewSessions";

/** Save a submission identity before sending, then replace it with the run
 * acknowledgement. Uncertain submissions and launched runs both survive reloads. */
const storageKey = "pi-web:pipeline-runs:v1";
const defaultMachineId = "local";


export interface PendingPipelineDecision {
  binding: PipelineApprovalBinding;
  decision: "approve" | "revise";
}

export interface CachedPipelineRunInfo {
  runId: string;
  cwd: string;
  goal: string;
  created: string;
  machineId: string;
  requestId?: string;
  executionRunId?: string;
  pendingDecision?: PendingPipelineDecision;
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
  return savePipelineRuns([run, ...runs], storage);
}

/** Save the identity before sending; a reload must not turn an uncertain launch into a new request. */
export function rememberPipelineSubmission(run: CachedPipelineRunInfo, storage: Storage | undefined = browserStorage()): boolean {
  if (storage === undefined || (storageOverride === undefined && storage === memoryStorage)) return false;
  return rememberPipelineRun({ ...run, submissionPending: true }, storage);
}

export function savePipelineExecution(runId: string, machineId: string, executionRunId: string): boolean {
  const storage = browserStorage();
  const runs = loadPipelineRuns(storage);
  return savePipelineRuns(runs.map((run) => run.runId === runId && run.machineId === machineId
    ? { ...run, executionRunId }
    : run), storage);
}

export function savePipelineDecision(runId: string, machineId: string, pending: PendingPipelineDecision | undefined): boolean {
  const storage = browserStorage();
  const runs = loadPipelineRuns(storage);
  if (!runs.some((run) => run.runId === runId && run.machineId === machineId)) return false;
  return savePipelineRuns(runs.map((run) => {
    if (run.runId !== runId || run.machineId !== machineId) return run;
    const next = { ...run };
    if (pending) next.pendingDecision = pending;
    else delete next.pendingDecision;
    return next;
  }), storage);
}

export function forgetPipelineRun(runId: string, machineId = defaultMachineId, storage: Storage | undefined = browserStorage()): void {
  const runs = loadPipelineRuns(storage);
  const run = runs.find(candidate => candidate.runId === runId && candidate.machineId === machineId);
  const history = run?.requestId ?? runId;
  if (run || runId.startsWith("run-")) {
    try { storage?.setItem("pi-web:hidden-pipeline:" + JSON.stringify([machineId, runId]), "1"); } catch { /* The current row can still be removed. */ }
  }
  if (savePipelineRuns(runs.filter(candidate => candidate !== run), storage) && storage) {
    for (const key of transcriptKeys(storage, machineId, history)) storage.removeItem(key);
  }
}

/** Restored rows carry pipelineRunId so the controller can register a live
 * pending start (status / approve / revise routing) for each of them. */
export type RestoredPipelineRunSessionInfo = SessionInfo & { clientPendingStart: true; machineId: string; pipelineRunId: string; pipelineHistoryId: string; pipelineExecutionRunId?: string; pipelinePendingDecision?: PendingPipelineDecision; pipelineSubmission?: { requestId: string; goal: string } };

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

/** The server catalog restores runs even when a device has no browser index. */
export function serverPipelineRows(rows: unknown, cwd: string): SessionInfo[] {
  if (!Array.isArray(rows)) throw new Error("Invalid pipeline chat catalog");
  const storage = browserStorage();
  const local = new Map(loadPipelineRuns(storage).filter(run => run.machineId === "local" && run.cwd === cwd).map(run => [run.runId, run]));
  return rows.flatMap(row => parsePipelineRun(row)).filter(run => run.cwd === cwd &&
    storage?.getItem("pi-web:hidden-pipeline:" + JSON.stringify(["local", run.runId])) !== "1").map(run => {
      const saved = local.get(run.runId);
      return restoredPipelineRunSession({ ...run, ...saved, submissionPending: false });
    });
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
    pipelineHistoryId: run.requestId ?? run.runId,
    ...(run.executionRunId !== undefined ? { pipelineExecutionRunId: run.executionRunId } : {}),
    ...(run.pendingDecision ? { pipelinePendingDecision: run.pendingDecision } : {}),
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
  const execution = value["executionRunId"];
  const stored = value["pendingDecision"];
  const binding = isRecord(stored) ? readPipelineApproval(stored["binding"]) : undefined;
  const decision = isRecord(stored) ? stored["decision"] : undefined;
  const pendingDecision: PendingPipelineDecision | undefined = binding && (decision === "approve" || decision === "revise") ? { binding, decision } : undefined;
  if (submissionPending && (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId))) return [];
  if (typeof runId !== "string" || runId === "" || typeof cwd !== "string" || typeof goal !== "string" || typeof created !== "string") return [];
  return [{ runId, cwd, goal, created, machineId: typeof machineId === "string" ? machineId : defaultMachineId, ...(typeof requestId === "string" ? { requestId } : {}), ...(submissionPending ? { submissionPending: true } : {}), ...(isPipelineExecutionId(execution) ? { executionRunId: execution } : {}), ...(pendingDecision ? { pendingDecision } : {}) }];
}

function historyPrefix(machine: string, history: string): string {
  return "pi-web:pipeline-line:v1:" + JSON.stringify([machine, history]) + ":";
}

function transcriptKeys(storage: Storage, machine: string, history: string): string[] {
  const prefix = historyPrefix(machine, history);
  try {
    return Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key?.startsWith(prefix) === true);
  } catch { return []; }
}

/** Each message has its own key so polling and other tabs cannot overwrite the conversation. */
export function savePipelineLine(machine: string, history: string, line: ChatLine): boolean {
  const storage = browserStorage();
  if (!storage || line.pipelineId === undefined || line.pipelineId === "") return false;
  try {
    const key = historyPrefix(machine, history) + line.pipelineId;
    storage.setItem(key, JSON.stringify(line));
    return true;
  } catch {
    return false;
  }
}

export function loadPipelineLines(machine: string, history: string): ChatLine[] {
  const storage = browserStorage();
  if (!storage) return [];
  const lines: SavedPipelineLine[] = [];
  for (const key of transcriptKeys(storage, machine, history)) {
    try {
      const line = readSavedPipelineLine(JSON.parse(storage.getItem(key) ?? "null"));
      if (line) lines.push(line);
    } catch { /* One incomplete record should not hide other messages. */ }
  }
  return lines.sort((a, b) => (a.pipelineOrder - b.pipelineOrder) || a.pipelineId.localeCompare(b.pipelineId));
}

type SavedPipelineLine = ChatLine & { pipelineOrder: number; pipelineId: string };

export function readSavedPipelineLine(value: unknown): SavedPipelineLine | undefined {
  if (!isRecord(value)) return undefined;
  const { pipelineId, pipelineOrder, pipelineVersion, role, meta, parts } = value;
  if (typeof pipelineId !== "string" || typeof pipelineOrder !== "number" || !Number.isSafeInteger(pipelineOrder) ||
      (role !== "user" && role !== "system") || !isRecord(meta) || typeof meta["timestamp"] !== "string" ||
      !Number.isFinite(Date.parse(meta["timestamp"])) || !Array.isArray(parts) || parts.length !== 1) return undefined;
  const first: unknown = parts[0];
  if (!isRecord(first)) return undefined;
  let part: ChatPart;
  if (first["type"] === "text" && typeof first["text"] === "string") {
    part = { type: "text", text: first["text"] };
  } else if (role === "system" && first["type"] === "pipelineCard" && typeof first["runId"] === "string" && typeof first["phase"] === "string") {
    part = { type: "pipelineCard", runId: first["runId"], phase: first["phase"], stale: true };
    if (typeof first["detail"] === "string") part.detail = first["detail"];
    if (typeof first["closeStatus"] === "string") part.closeStatus = first["closeStatus"];
    const delivery = first["delivery"];
    if (isRecord(delivery) && typeof delivery["buildDigest"] === "string" && typeof delivery["reportDigest"] === "string") {
      part.delivery = { buildDigest: delivery["buildDigest"], reportDigest: delivery["reportDigest"],
        ...(typeof delivery["report"] === "string" ? { report: delivery["report"] } : {}),
        ...(typeof delivery["diff"] === "string" ? { diff: delivery["diff"] } : {}) };
    }
    const card = first["card"];
    if (isRecord(card) && typeof card["questionId"] === "string" && typeof card["artifactSha256"] === "string" && typeof card["revision"] === "number") {
      const binding = readPipelineApproval(card["binding"]);
      part.card = { historical: true, questionId: card["questionId"], artifactSha256: card["artifactSha256"], revision: card["revision"],
        ...(card["decided"] === true ? { decided: true } : {}), ...(binding ? { binding } : {}),
        ...(typeof card["stage"] === "string" ? { stage: card["stage"] } : {}),
        ...(typeof card["artifact"] === "string" ? { artifact: card["artifact"] } : {}) };
    }
  } else return undefined;
  return { pipelineId, pipelineOrder, ...(typeof pipelineVersion === "number" ? { pipelineVersion } : {}),
    meta: { timestamp: meta["timestamp"] }, role, parts: [part] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
