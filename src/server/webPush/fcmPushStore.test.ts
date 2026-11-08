import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileFcmPersistence, FcmPushStore, MAX_FCM_DIAG, MAX_FCM_TOKENS, validateFcmToken } from "./fcmPushStore.js";

const TOKEN = "fPaBcD1234567890abcdefghijklmnopqrstuvwxyz-_";
const TOKEN_B = "dEfGhI0987654321zyxwvutsrqponmlkjihgfedcba-_:";

describe("validateFcmToken", () => {
  it("accepts plausible tokens and rejects the rest", () => {
    expect(validateFcmToken(TOKEN)).toBe(TOKEN);
    expect(() => validateFcmToken("short")).toThrow();
    expect(() => validateFcmToken("x".repeat(4097))).toThrow();
    expect(() => validateFcmToken(42)).toThrow();
    expect(() => validateFcmToken(null)).toThrow();
  });
});

describe("FcmPushStore", () => {
  let persistence: FileFcmPersistence;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "fcm-push-test-"));
    persistence = new FileFcmPersistence(directory);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("starts empty, subscribes idempotently, unsubscribes and prunes", async () => {
    const store = new FcmPushStore(persistence);
    await store.load();
    expect(store.snapshot().tokens).toEqual([]);
    await store.subscribe(TOKEN);
    await store.subscribe(TOKEN); // idempotent repeat registration
    await store.subscribe(TOKEN_B);
    expect(store.snapshot().tokens).toEqual([TOKEN, TOKEN_B]);
    await store.unsubscribe(TOKEN_B);
    await store.prune([TOKEN_B, TOKEN]); // prune of an unknown token is a no-op
    expect(store.snapshot().tokens).toEqual([]);
  });

  it("rejects missing or implausible tokens", async () => {
    const store = new FcmPushStore(persistence);
    await store.load();
    await expect(store.subscribe({ nope: 1 })).rejects.toThrow();
    await expect(store.unsubscribe(42)).rejects.toThrow();
    await expect(store.subscribe("short")).rejects.toThrow();
  });

  it("enforces the token cap and caps the diag ring", async () => {
    const store = new FcmPushStore(persistence);
    await store.load();
    for (let index = 0; index < MAX_FCM_TOKENS; index += 1) {
      await store.subscribe(`token-${String(index)}-abcdefghijklmnop`);
    }
    await expect(store.subscribe("one-token-too-many-abcdef")).rejects.toThrow("limit reached");
    for (let index = 0; index < MAX_FCM_DIAG + 5; index += 1) {
      await store.pushDiag(`event-${String(index)}`, { index });
    }
    const diag = store.snapshot().diag;
    expect(diag).toHaveLength(50);
    expect(diag.at(0)?.event).toBe("event-5");
    expect(diag.at(-1)?.event).toBe(`event-${String(MAX_FCM_DIAG + 4)}`);
  });

  it("round-trips through the file persistence and drops invalid records on load", async () => {
    const first = new FcmPushStore(persistence);
    await first.load();
    await first.subscribe(TOKEN);
    await first.pushDiag("push_sent", { sessionId: "s1" });
    const path = join(directory, "tokens.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);

    expect(await readFile(path, "utf8")).toContain(TOKEN);
    // Corrupt the store on disk: one non-string token, one implausible token, one invalid diag entry.
    await writeFileRaw(path, JSON.stringify({
      version: 1,
      tokens: [TOKEN, 42, "short"],
      diag: [{ at: "2026-01-01T00:00:00.000Z", event: "push_sent", fields: { sessionId: "s1" } }, { at: "not-a-date-but-string", event: "ok", fields: {} }, { garbage: true }],
    }));

    const second = new FcmPushStore(persistence);
    await second.load();
    expect(second.snapshot().tokens).toEqual([TOKEN]);
    expect(second.snapshot().diag).toHaveLength(2); // stored entry + the string-at entry; the garbage entry is dropped
  });

  it("fails startup on corrupt state but creates fresh state when absent", async () => {
    await writeFileRaw(join(directory, "tokens.json"), "{not json");
    const corrupt = new FcmPushStore(persistence);
    await expect(corrupt.load()).rejects.toThrow("Cannot load FCM push state");

    const emptyDirectory = join(directory, "fresh");
    const fresh = new FcmPushStore(new FileFcmPersistence(emptyDirectory));
    await fresh.load();
    expect(fresh.snapshot()).toEqual({ version: 1, tokens: [], diag: [] });
    expect((await stat(join(emptyDirectory, "tokens.json"))).mode & 0o777).toBe(0o600);
  });
});

async function writeFileRaw(path: string, content: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, content);
}
