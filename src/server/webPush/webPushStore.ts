import { createECDH, ECDH, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PushSubscription } from "web-push";

export interface PushRecord { subscription: PushSubscription; generation: string }
export interface PushState {
  version: 1;
  vapid: { publicKey: string; privateKey: string };
  subscriptions: PushRecord[];
}
export interface PushPersistence { load(): Promise<unknown>; save(state: PushState): Promise<void> }

/** Only these providers are allowed. Validate again at the network boundary. */
export function validatePushEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2300) throw new Error("Invalid push endpoint");
  const url = new URL(value);
  const path = url.hostname === "fcm.googleapis.com" ? /^\/(?:fcm\/send|wp)\/([A-Za-z0-9_-]{16,2048})$/
    : url.hostname === "updates.push.services.mozilla.com" ? /^\/wpush\/v2\/([A-Za-z0-9_-]{16,2048})$/ : undefined;
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || path?.test(url.pathname) !== true || value !== url.href || /:443(?:\/|$)/.test(value)) {
    throw new Error("Invalid push endpoint");
  }
  return value;
}

function decodeKey(value: unknown, length: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 100) throw new Error("Invalid push key");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== length || bytes.toString("base64url") !== value) throw new Error("Invalid push key");
  return bytes;
}

export function validatePushSubscription(value: unknown): PushSubscription {
  if (!isRecord(value) || !isRecord(value["keys"]) || JSON.stringify(value).length > 4096) throw new Error("Invalid push subscription");
  const endpoint = validatePushEndpoint(value["endpoint"]);
  const publicKey = decodeKey(value["keys"]["p256dh"], 65);
  if (publicKey[0] !== 4) throw new Error("Invalid push key");
  try { ECDH.convertKey(publicKey, "prime256v1"); } catch { throw new Error("Invalid push key"); }
  const auth = decodeKey(value["keys"]["auth"], 16);
  return { endpoint, keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") } };
}

/** Serialized read-modify-write transactions; publication follows durable writes only. */
export class WebPushStore {
  private state: PushState | undefined;
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private readonly persistence: PushPersistence) {}

  async load(): Promise<void> {
    const value = await this.persistence.load();
    if (value === undefined) {
      const pair = createECDH("prime256v1"); pair.generateKeys();
      const state: PushState = { version: 1, vapid: { publicKey: pair.getPublicKey().toString("base64url"), privateKey: pair.getPrivateKey().toString("base64url") }, subscriptions: [] };
      await this.persistence.save(state);
      this.state = state;
    } else {
      // Invalid JSON or VAPID keys fail startup; invalid subscription records are dropped instead.
      if (!isRecord(value) || value["version"] !== 1 || !isRecord(value["vapid"]) || !Array.isArray(value["subscriptions"]) || value["subscriptions"].length > 20) throw new Error("Corrupt web push state");
      const publicKey = decodeKey(value["vapid"]["publicKey"], 65);
      const privateKey = decodeKey(value["vapid"]["privateKey"], 32);
      const pair = createECDH("prime256v1"); pair.setPrivateKey(privateKey);
      if (!pair.getPublicKey().equals(publicKey)) throw new Error("Corrupt web push state");
      // Stale or invalid subscriptions are dropped at load: they must never fail startup.
      const subscriptions = value["subscriptions"].flatMap((record: unknown): PushRecord[] => {
        try {
          if (!isRecord(record) || typeof record["generation"] !== "string" || !/^[a-f0-9-]{36}$/.test(record["generation"])) return [];
          return [{ subscription: validatePushSubscription(record["subscription"]), generation: record["generation"] }];
        } catch { return []; }
      });
      if (new Set(subscriptions.map(({ subscription }) => subscription.endpoint)).size !== subscriptions.length) throw new Error("Corrupt web push state");
      this.state = { version: 1, vapid: { publicKey: publicKey.toString("base64url"), privateKey: privateKey.toString("base64url") }, subscriptions };
    }
  }

  snapshot(): PushState {
    if (this.state === undefined) throw new Error("Web push store is not loaded");
    return structuredClone(this.state);
  }
  current(record: PushRecord): boolean {
    return this.snapshot().subscriptions.some((entry) => entry.subscription.endpoint === record.subscription.endpoint && entry.generation === record.generation);
  }
  subscribe(value: unknown): Promise<PushRecord> {
    const subscription = validatePushSubscription(value);
    return this.mutate((state) => {
      const records = state.subscriptions.filter((entry) => entry.subscription.endpoint !== subscription.endpoint);
      if (records.length >= 20) throw new Error("Push subscription limit reached");
      const record = { subscription, generation: randomUUID() };
      state.subscriptions = [...records, record];
      return record;
    });
  }
  unsubscribe(endpoint: string, generation?: string): Promise<void> {
    validatePushEndpoint(endpoint);
    return this.mutate((state) => {
      state.subscriptions = state.subscriptions.filter((record) => record.subscription.endpoint !== endpoint || (generation !== undefined && record.generation !== generation));
    });
  }
  private mutate<T>(change: (state: PushState) => T): Promise<T> {
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

export class FileWebPushPersistence implements PushPersistence {
  constructor(private readonly directory: string) {}
  async load(): Promise<unknown> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory()) throw new Error("Invalid web push state directory");
    await chmod(this.directory, 0o700);
    const path = join(this.directory, "state.json");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 100_000) throw new Error("Invalid web push state file");
      await chmod(path, 0o600);
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      return value;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw new Error("Cannot load web push state", { cause: error });
    }
  }
  async save(state: PushState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    // Failed temporary files are private and retained for diagnosis, not deleted.
    await rename(temporary, join(this.directory, "state.json"));
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
