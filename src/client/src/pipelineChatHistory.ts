import { request } from "./api/http";
import { readSavedPipelineLine } from "./cachedPipelineRuns";
import type { ChatLine } from "./components/shared";

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
