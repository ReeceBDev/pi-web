import { resolveAppUrl } from "./appUrl";

/** Client-side decoding of the pipeline run event stream (GET
 * /api/pipeline-runs/events, the Server-Sent Events proxy of the pipeline
 * worker's /events). Frames are routed by data.aggregate.id — the
 * projectRunId — and each frame is one of two kinds:
 *
 * - "transition": the run moved between phases (payload projectRunId/from/to/
 *   reasonCode/detail, with an optional lifecycle "started"|"finished");
 * - "card": the run's approval card opened, changed, or settled (payload
 *   kind "card", questionId/revision/state "open"|"consumed"|"expired", plus
 *   the card's own fields such as artifactSha256).
 */
export type PipelineRunFrame =
  | { kind: "transition"; runId: string; lifecycle: "started" | "finished" | undefined; from: string | undefined; to: string | undefined; reasonCode: string | undefined }
  | { kind: "card"; runId: string; card: PipelineCardFrame };

export interface PipelineCardFrame {
  questionId: string;
  revision: number;
  state: "open" | "consumed" | "expired";
  artifactSha256?: string;
  stage?: string;
}

/** Open the run-event stream; onFrame receives each frame's data JSON. The
 * browser's EventSource reconnects on its own (the server ends the stream
 * when the pipeline worker is unreachable) and the server forwards the
 * Last-Event-ID header, so resume replay is handled upstream. */
export function openPipelineRunEventStream(onFrame: (data: string) => void): PipelineRunEventStream {
  const source = new EventSource(resolveAppUrl("api/pipeline-runs/events"));
  const forward = (event: Event): void => {
    // Named SSE events ("event: transition" / "event: card") arrive as
    // MessageEvents; anything else cannot carry a frame.
    if (!(event instanceof MessageEvent)) return;
    const data: unknown = event.data;
    if (typeof data !== "string" || data === "") return;
    onFrame(data);
  };
  source.addEventListener("transition", forward);
  source.addEventListener("card", forward);
  return { close: () => { source.close(); } };
}

export interface PipelineRunEventStream {
  close(): void;
}

/** Parse one frame's data JSON into a typed PipelineRunFrame, or undefined
 * when the payload is not a frame this client understands. */
export function parsePipelineRunFrame(data: string): PipelineRunFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !isRecord(value["aggregate"]) || value["aggregate"]["type"] !== "projectRun") return undefined;
  const runId = value["aggregate"]["id"];
  if (typeof runId !== "string" || runId === "") return undefined;
  const payload = value["payload"];
  if (!isRecord(payload)) return undefined;
  if (payload["kind"] === "card") return cardFrame(runId, payload);
  return transitionFrame(runId, payload);
}

function transitionFrame(runId: string, payload: Record<string, unknown>): PipelineRunFrame | undefined {
  const lifecycle = payload["lifecycle"];
  if (lifecycle !== "started" && lifecycle !== "finished" && lifecycle !== undefined) return undefined;
  return {
    kind: "transition",
    runId,
    lifecycle,
    from: typeof payload["from"] === "string" ? payload["from"] : undefined,
    to: typeof payload["to"] === "string" ? payload["to"] : undefined,
    reasonCode: typeof payload["reasonCode"] === "string" ? payload["reasonCode"] : undefined,
  };
}

function cardFrame(runId: string, payload: Record<string, unknown>): PipelineRunFrame | undefined {
  const questionId = payload["questionId"];
  const revision = payload["revision"];
  const state = payload["state"];
  if (typeof questionId !== "string" || questionId === "" || typeof revision !== "number") return undefined;
  if (state !== "open" && state !== "consumed" && state !== "expired") return undefined;
  const artifactSha256 = payload["artifactSha256"];
  const stage = payload["stage"];
  return {
    kind: "card",
    runId,
    card: {
      questionId,
      revision,
      state,
      ...(typeof artifactSha256 === "string" && artifactSha256 !== "" ? { artifactSha256 } : {}),
      ...(typeof stage === "string" && stage !== "" ? { stage } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
