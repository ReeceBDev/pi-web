import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FcmDiagEntry { at: string; event: string; fields: Record<string, unknown> }
export interface FcmPushState { version: 1; tokens: string[]; diag: FcmDiagEntry[] }
export interface FcmPersistence { load(): Promise<unknown>; save(state: FcmPushState): Promise<void> }

/** One user, a couple of devices; mirrors the box-push launcher plugin cap. */
export const MAX_FCM_TOKENS = 16;
export const MAX_FCM_DIAG = 50;

/** Length plausibility only, mirroring the launcher plugin; Google owns the token alphabet. */
export function validateFcmToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 4096) throw new Error("Invalid FCM token");
  return value;
}

function isDiagEntry(value: unknown): value is FcmDiagEntry {
  return isRecord(value) && typeof value["at"] === "string" && typeof value["event"] === "string" && isRecord(value["fields"]);
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Serialized read-modify-write token store; publication follows durable writes only. */
export class FcmPushStore {
  private state: FcmPushState | undefined;
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private readonly persistence: FcmPersistence) {}

  async load(): Promise<void> {
    const value = await this.persistence.load();
    if (value === undefined) {
      this.state = { version: 1, tokens: [], diag: [] };
      await this.persistence.save(this.state);
      return;
    }
    // Invalid JSON fails startup; invalid token or diag records are dropped instead.
    if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["tokens"]) || value["tokens"].length > MAX_FCM_TOKENS || !Array.isArray(value["diag"])) throw new Error("Corrupt FCM push state");
    const tokens = [...new Set(value["tokens"].flatMap((token: unknown) => {
      try { return [validateFcmToken(token)]; } catch { return []; }
    }))];
    this.state = { version: 1, tokens, diag: value["diag"].filter(isDiagEntry).slice(-MAX_FCM_DIAG) };
  }

  snapshot(): FcmPushState {
    if (this.state === undefined) throw new Error("FCM push store is not loaded");
    return structuredClone(this.state);
  }

  async subscribe(value: unknown): Promise<void> {
    const token = validateFcmToken(value);
    return this.mutate((state) => {
      if (state.tokens.includes(token)) return;
      if (state.tokens.length >= MAX_FCM_TOKENS) throw new Error("FCM token limit reached");
      state.tokens = [...state.tokens, token];
    });
  }

  async unsubscribe(value: unknown): Promise<void> {
    const token = validateFcmToken(value);
    return this.mutate((state) => { state.tokens = state.tokens.filter((entry) => entry !== token); });
  }

  /** Drop tokens Google no longer knows (404/410/UNREGISTERED send results). */
  prune(tokens: readonly string[]): Promise<void> {
    return this.mutate((state) => { state.tokens = state.tokens.filter((entry) => !tokens.includes(entry)); });
  }

  pushDiag(event: string, fields: Record<string, unknown>): Promise<void> {
    return this.mutate((state) => { state.diag = [...state.diag, { at: new Date().toISOString(), event, fields }].slice(-MAX_FCM_DIAG); });
  }

  private mutate<T>(change: (state: FcmPushState) => T): Promise<T> {
    const operation = this.mutations.then(async () => {
      const next = this.snapshot();
      const result = change(next);
      await this.persistence.save(next);
      this.state = next;
      return result;
    });
    this.mutations = operation.catch(() => undefined);
    return operation;
  }
}

export class FileFcmPersistence implements FcmPersistence {
  constructor(private readonly directory: string) {}
  async load(): Promise<unknown> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error("Invalid FCM push state directory");
    await chmod(this.directory, 0o700);
    const path = join(this.directory, "tokens.json");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 100_000) throw new Error("Invalid FCM push state file");
      await chmod(path, 0o600);
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new Error("Cannot load FCM push state", { cause: error });
    }
  }
  async save(state: FcmPushState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    // Failed temporary files are private and retained for diagnosis, not deleted.
    await rename(temporary, join(this.directory, "tokens.json"));
  }
}
