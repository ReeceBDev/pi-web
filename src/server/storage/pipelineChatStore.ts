import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { piWebDataDir } from "../../config.js";
import { readPipelineApproval } from "../../shared/pipelineApproval.js";

interface Row { pipelineId: string; pipelineOrder: number; pipelineVersion: number; meta: { timestamp: string }; role: "system" | "user"; parts: [Record<string, unknown>] }
function record(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === "object" && !Array.isArray(v); }

function strings(source: Record<string, unknown>, fields: readonly string[]): Record<string, string> {
  const saved: Record<string, string> = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string") saved[field] = value;
  }
  return saved;
}

function savedPart(part: unknown, runId: string, role: Row["role"]): Record<string, unknown> | undefined {
  if (!record(part)) return undefined;
  if (part["type"] === "text") return typeof part["text"] === "string" ? { type: "text", text: part["text"] } : undefined;
  if (part["type"] !== "pipelineCard" || role !== "system" || part["runId"] !== runId || typeof part["phase"] !== "string") return undefined;
  const saved: Record<string, unknown> = { type: "pipelineCard", runId, ...strings(part, ["phase", "detail", "closeStatus"]) };
  const delivery = part["delivery"];
  if (record(delivery)) saved["delivery"] = strings(delivery, ["buildDigest", "reportDigest", "report", "diff"]);
  const card = part["card"];
  if (record(card)) {
    if (typeof card["questionId"] !== "string" || typeof card["artifactSha256"] !== "string" || !Number.isSafeInteger(card["revision"])) return undefined;
    const binding = readPipelineApproval(card["binding"]);
    saved["card"] = { ...strings(card, ["questionId", "artifactSha256", "stage", "artifact"]), revision: card["revision"],
      ...(binding ? { binding } : {}), ...(card["decided"] === true ? { decided: true } : {}),
      ...(card["historical"] === true ? { historical: true } : {}) };
  }
  return saved;
}

function chatRow(value: unknown, runId: string): Row | undefined {
  if (!record(value) || typeof value["pipelineId"] !== "string" || !value["pipelineId"] || value["pipelineId"].length > 900 ||
      !Number.isSafeInteger(value["pipelineOrder"]) || (value["pipelineVersion"] !== undefined && !Number.isSafeInteger(value["pipelineVersion"])) || !record(value["meta"]) ||
      typeof value["meta"]["timestamp"] !== "string" || !Number.isFinite(Date.parse(value["meta"]["timestamp"])) ||
      (value["role"] !== "user" && value["role"] !== "system") || !Array.isArray(value["parts"]) || value["parts"].length !== 1) return undefined;
  const part = savedPart(value["parts"][0], runId, value["role"]);
  if (!part) return undefined;
  return { pipelineId: value["pipelineId"], pipelineOrder: Number(value["pipelineOrder"]), pipelineVersion: Number(value["pipelineVersion"] ?? value["pipelineOrder"]), role: value["role"],
    meta: { timestamp: value["meta"]["timestamp"] }, parts: [part] };
}

/** PI WEB owns this conversation independently of the workflow and its test output. */
export class PipelineChatStore {
  private connection?: DatabaseSync;
  constructor(private readonly file = join(piWebDataDir(process.env, process.cwd()), "pipeline-conversations", "history.sqlite")) {}

  private db(): DatabaseSync {
    if (this.connection) return this.connection;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    try {
      db.exec(`
        PRAGMA busy_timeout=3000;
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS chat(
          run TEXT PRIMARY KEY, request TEXT NOT NULL, cwd TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS message(
          seq INTEGER PRIMARY KEY, run TEXT NOT NULL REFERENCES chat(run), id TEXT NOT NULL,
          ordinal INTEGER NOT NULL, version INTEGER NOT NULL, stamp TEXT NOT NULL,
          body TEXT NOT NULL, UNIQUE(run,id)
        );
        CREATE INDEX IF NOT EXISTS message_run_seq ON message(run,seq);
      `);
      this.connection = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  register(run: string, requestId: string, cwd: string, goal: string): void {
    const db = this.db();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO chat(run,request,cwd) VALUES(?,?,?)").run(run,requestId,cwd);
      const owned = db.prepare("SELECT 1 FROM chat WHERE run=? AND request=? AND cwd=?").get(run,requestId,cwd);
      if (!owned) throw new Error("Chat belongs to a different submission");
      const now = Date.now();
      db.prepare("INSERT OR IGNORE INTO message(run,id,ordinal,version,stamp,body) VALUES(?,?,?,?,?,?)")
        .run(run,"goal",now*1000,0,new Date(now).toISOString(),JSON.stringify({ role:"user",parts:[{type:"text",text:goal}] }));
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  has(run: string): boolean { return Boolean(this.db().prepare("SELECT 1 FROM chat WHERE run=?").get(run)); }

  save(run: string, input: unknown): boolean {
    if (!Array.isArray(input) || input.length > 64) return false;
    const rows = input.map(value => chatRow(value,run));
    if (rows.some(row => row === undefined)) return false;
    const db = this.db();
    const confirmGoal = db.prepare("UPDATE message SET ordinal=?,stamp=?,version=? WHERE run=? AND id='goal' AND version=0 AND body=?");
    const put = db.prepare(`INSERT INTO message(run,id,ordinal,version,stamp,body) VALUES(?,?,?,?,?,?)
      ON CONFLICT(run,id) DO UPDATE SET body=excluded.body,version=excluded.version
      WHERE ? AND excluded.version > message.version AND json_extract(message.body,'$.parts[0].type')='pipelineCard'`);
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (!row) continue;
        const body = JSON.stringify({ role: row.role, parts: row.parts });
        if (row.pipelineId === "goal") confirmGoal.run(row.pipelineOrder, row.meta.timestamp, row.pipelineVersion, run, body);
        put.run(run, row.pipelineId, row.pipelineOrder, row.pipelineVersion, row.meta.timestamp, body, row.parts[0]["type"] === "pipelineCard" ? 1 : 0);
      }
      db.exec("COMMIT");
      return true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  list(cwd: string) {
    return this.db().prepare(`SELECT c.run AS runId, c.request AS requestId, c.cwd, m.stamp AS created,
      json_extract(m.body,'$.parts[0].text') AS goal FROM chat c JOIN message m ON m.run=c.run AND m.id='goal'
      WHERE c.cwd=? ORDER BY m.seq DESC`).all(cwd);
  }

  page(run: string, after: number) {
    const rows = this.db().prepare("SELECT seq,id,ordinal,version,stamp,body FROM message WHERE run=? AND seq>? ORDER BY seq LIMIT 65").all(run,after);
    const page = rows.slice(0,64);
    const lines = page.map(row => {
      const body: unknown = JSON.parse(String(row["body"]));
      if (!record(body)) throw new Error("Saved chat row is invalid");
      return { ...body, pipelineId: row["id"], pipelineOrder: row["ordinal"], pipelineVersion: row["version"], meta: { timestamp: row["stamp"] } };
    });
    return { lines, next: rows.length > page.length ? Number(page.at(-1)?.["seq"]) : null };
  }
  close(): void { this.connection?.close(); delete this.connection; }
}
