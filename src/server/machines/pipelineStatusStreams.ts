import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

type View = Record<string, unknown>;
interface Listener { view: (view: View) => void; end: () => void }

interface Watch {
  child: ChildProcess;
  listeners: Set<Listener>;
  latest?: View;
}

function isRecord(data: unknown): data is View {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

/** One history reader per watched run. Viewers share its last authoritative snapshot. */
export class PipelineStatusStreams {
  private readonly active = new Map<string, Watch>();

  constructor(private readonly spawnStatus: (runId: string) => ChildProcess) {}

  subscribe(runId: string, listener: Listener): () => void {
    let watch = this.active.get(runId);
    if (watch === undefined) {
      const child = this.spawnStatus(runId);
      const created: Watch = { child, listeners: new Set() };
      this.active.set(runId, created);
      const finish = () => {
        if (this.active.get(runId) !== created) return;
        this.active.delete(runId);
        for (const current of created.listeners) current.end();
        created.listeners.clear();
      };
      if (child.stdout !== null) {
        createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line: string) => {
          if (this.active.get(runId) !== created || line.length > 128 * 1024) return;
          let data: unknown;
          try { data = JSON.parse(line); } catch { return; }
          if (!isRecord(data)) return;
          const view = data;
          if (view["ok"] === true && view["runId"] !== runId) return;
          if (typeof view["ok"] !== "boolean") return;
          if (!view["ok"]) delete view["detail"];
          created.latest = view;
          for (const current of created.listeners) current.view(view);
        });
      }
      child.stderr?.resume();
      child.once("error", finish);
      child.once("close", finish);
      watch = created;
    }
    const current = watch;
    current.listeners.add(listener);
    if (current.latest !== undefined) listener.view(current.latest);
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size !== 0 || this.active.get(runId) !== current) return;
      this.active.delete(runId);
      current.child.kill("SIGTERM");
      const deadline = setTimeout(() => current.child.kill("SIGKILL"), 3000);
      deadline.unref();
      current.child.once("close", () => { clearTimeout(deadline); });
    };
  }
}
