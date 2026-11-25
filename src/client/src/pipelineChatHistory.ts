import { request } from "./api/http";
import { readPipelineApproval } from "../../shared/pipelineApproval";
import type { ChatLine, ChatPart } from "./components/shared";

export interface PipelineChatHistory {
  load(run: string): Promise<ChatLine[]>;
  save(run: string, rows: ChatLine[]): Promise<void>;
}

function parsePage(data: unknown): { lines: ChatLine[]; next: number | null } {
  if (typeof data !== "object" || !data || !("lines" in data) || !Array.isArray(data.lines) ||
    !("next" in data) || !(data.next === null || (typeof data.next === "number" && Number.isSafeInteger(data.next)))) throw new Error("Invalid saved chat page");
  const lines = data.lines.map((item: unknown) => {
    const line = readSavedPipelineLine(item);
    if (!line) throw new Error("Invalid saved chat message");
    return line;
  });
  return { lines, next: data.next };
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
        ...(typeof card["reviewNotes"] === "string" ? { reviewNotes: card["reviewNotes"] } : {}),
        ...(typeof card["artifact"] === "string" ? { artifact: card["artifact"] } : {}) };
    }
  } else return undefined;
  return { pipelineId, pipelineOrder, ...(typeof pipelineVersion === "number" ? { pipelineVersion } : {}),
    meta: { timestamp: meta["timestamp"] }, role, parts: [part] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const serverPipelineHistory: PipelineChatHistory = {
  async load(run) {
    const path = "api/pipeline-runs/" + encodeURIComponent(run) + "/transcript";
    const lines: ChatLine[] = [];
    let cursor = 0;
    for (;;) {
      const page = await request(path + "?" + new URLSearchParams({ after: String(cursor) }).toString(), parsePage);
      lines.push(...page.lines);
      if (page.next === null) return lines;
      if (page.next <= cursor) throw new Error("Saved chat cursor did not advance");
      cursor = page.next;
    }
  },
  async save(run, lines) {
    const path = "api/pipeline-runs/" + encodeURIComponent(run) + "/transcript";
    await request(path, data => {
      if (typeof data !== "object" || !data || !("ok" in data) || data.ok !== true) throw new Error("Chat save was not acknowledged");
    }, { method: "POST", body: JSON.stringify({ lines }) });
  },
};
