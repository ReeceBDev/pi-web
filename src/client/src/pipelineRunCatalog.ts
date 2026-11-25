import type { SessionInfo } from "./api";

/** Runs whose rows the user removed during this page session. In-memory only —
 * the approved event-stream design keeps no browser storage — so a forgotten
 * run reappears after a reload until the server catalog stops listing it. */
const forgottenRunIds = new Set<string>();

/** Forget a pipeline run row for this page session. The run's chat history
 * stays on the server; only the row disappears from workspace listings. */
export function forgetPipelineRunRow(runId: string): void {
  forgottenRunIds.add(runId);
}

/** A pipeline run row restored from the server's durable chat catalog (GET
 * /api/pipeline-chats) rather than created by this page's launch. */
export type RestoredPipelineRunSessionInfo = SessionInfo & { clientPendingStart: true; machineId: string; pipelineRunId: string; pipelineHistoryId: string };

export function isRestoredPipelineRunSession(session: SessionInfo | undefined): session is RestoredPipelineRunSessionInfo {
  return isRecord(session)
    && session["clientPendingStart"] === true
    && typeof session["pipelineRunId"] === "string";
}

/** Parse the server's durable chat catalog into restored pipeline run rows
 * for one workspace. The catalog is the server half of durable chat: it
 * restores run rows on every device; the rows' live phase/card state arrives
 * separately on the aggregated run-event stream. */
export function serverPipelineRows(rows: unknown, cwd: string): SessionInfo[] {
  if (!Array.isArray(rows)) throw new Error("Invalid pipeline chat catalog");
  return rows.flatMap((row) => parsePipelineChatRow(row))
    .filter((run) => run.cwd === cwd && !forgottenRunIds.has(run.runId))
    .map(restoredPipelineRunSession);
}

interface PipelineChatRow { runId: string; requestId: string; cwd: string; goal: string; created: string }

function parsePipelineChatRow(value: unknown): PipelineChatRow[] {
  if (!isRecord(value)) return [];
  const runId = value["runId"];
  const requestId = value["requestId"];
  const cwd = value["cwd"];
  const goal = value["goal"];
  const created = value["created"];
  if (typeof runId !== "string" || runId === "" || typeof requestId !== "string" || requestId === "" ||
      typeof cwd !== "string" || typeof goal !== "string" || typeof created !== "string") return [];
  return [{ runId, requestId, cwd, goal, created }];
}

function restoredPipelineRunSession(run: PipelineChatRow): RestoredPipelineRunSessionInfo {
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
    machineId: "local",
    pipelineRunId: run.runId,
    pipelineHistoryId: run.requestId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
