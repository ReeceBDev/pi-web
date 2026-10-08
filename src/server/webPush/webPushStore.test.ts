import { createECDH, randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileWebPushPersistence, validatePushEndpoint, validatePushSubscription, WebPushStore, type PushPersistence, type PushState } from "./webPushStore.js";

function endpoint(path = "/fcm/send/AAAA_valid_token_1234567890"): string {
  return `https://fcm.googleapis.com${path}`;
}

export function subscriptionFixture(endpointValue = endpoint()) {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  return {
    endpoint: endpointValue,
    keys: { p256dh: pair.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    privateKey: pair.getPrivateKey(),
  };
}

function nullPersistence(): PushPersistence {
  return { load: () => Promise.resolve(undefined), save: () => Promise.resolve() };
}

describe("validatePushEndpoint", () => {
  it("accepts the allowlisted FCM and Mozilla endpoint shapes", () => {
    expect(validatePushEndpoint(endpoint())).toBe(endpoint());
    expect(validatePushEndpoint(endpoint("/wp/tok_1234567890abcdef"))).toBe(endpoint("/wp/tok_1234567890abcdef"));
    expect(validatePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/AAAABBBBCCCCDDDD")).toBeTruthy();
  });

  it.each([
    ["http scheme", "http://fcm.googleapis.com/fcm/send/AAAABBBBCCCCDDDD"],
    ["explicit port", "https://fcm.googleapis.com:443/fcm/send/AAAABBBBCCCCDDDD"],
    ["non-standard port", "https://fcm.googleapis.com:8443/fcm/send/AAAABBBBCCCCDDDD"],
    ["query string", "https://fcm.googleapis.com/fcm/send/AAAABBBBCCCCDDDD?x=1"],
    ["fragment", "https://fcm.googleapis.com/fcm/send/AAAABBBBCCCCDDDD#f"],
    ["credentials", "https://user:pass@fcm.googleapis.com/fcm/send/AAAABBBBCCCCDDDD"],
    ["IP host", "https://142.250.4.1/fcm/send/AAAABBBBCCCCDDDD"],
    ["suffix-match host", "https://evil-fcm.googleapis.com/fcm/send/AAAABBBBCCCCDDDD"],
    ["subdomain host", "https://fcm.googleapis.com.evil.test/fcm/send/AAAABBBBCCCCDDDD"],
    ["unknown host", "https://push.example.test/fcm/send/AAAABBBBCCCCDDDD"],
    ["wrong FCM path", "https://fcm.googleapis.com/other/AAAABBBBCCCCDDDD"],
    ["wrong Mozilla host path", "https://updates.push.services.mozilla.com/fcm/send/AAAABBBBCCCCDDDD"],
    ["empty token", "https://fcm.googleapis.com/fcm/send/"],
    ["not a string", 42],
    ["missing", undefined],
  ])("rejects %s", (_label, value) => {
    expect(() => validatePushEndpoint(value)).toThrow();
  });
});

describe("validatePushSubscription", () => {
  it("accepts a well-formed P-256 subscription with a 16-byte auth secret", () => {
    const fixture = subscriptionFixture();
    const parsed = validatePushSubscription({ endpoint: fixture.endpoint, keys: { p256dh: fixture.keys.p256dh, auth: fixture.keys.auth } });
    expect(parsed.endpoint).toBe(fixture.endpoint);
    expect(parsed.keys.p256dh).toBe(fixture.keys.p256dh);
  });

  it.each([
    ["non-object", "nope"],
    ["missing keys", { endpoint: endpoint() }],
    ["non-65-byte key", { endpoint: endpoint(), keys: { p256dh: randomBytes(32).toString("base64url"), auth: randomBytes(16).toString("base64url") } }],
    ["non-P-256 point", { endpoint: endpoint(), keys: { p256dh: Buffer.concat([Buffer.from([2]), randomBytes(64)]).toString("base64url"), auth: randomBytes(16).toString("base64url") } }],
    ["15-byte auth", { endpoint: endpoint(), keys: { p256dh: subscriptionFixture().keys.p256dh, auth: randomBytes(15).toString("base64url") } }],
    ["padded base64", { endpoint: endpoint(), keys: { p256dh: `${subscriptionFixture().keys.p256dh}=`, auth: randomBytes(16).toString("base64url") } }],
  ])("rejects %s", (_label, value) => {
    expect(() => validatePushSubscription(value)).toThrow();
  });

  it("rejects oversized bodies", () => {
    const fixture = subscriptionFixture();
    expect(() => validatePushSubscription({ endpoint: fixture.endpoint, keys: fixture.keys, padding: "x".repeat(5000) })).toThrow();
  });
});

describe("WebPushStore", () => {
  it("subscribes, re-subscribes the same endpoint, and reports generations", async () => {
    const store = new WebPushStore(nullPersistence());
    await store.load();
    const first = await store.subscribe(subscriptionFixture());
    const replaced = await store.subscribe(subscriptionFixture());
    expect(store.snapshot().subscriptions).toHaveLength(1);
    expect(store.current(first)).toBe(false);
    expect(store.current(replaced)).toBe(true);
  });

  it("unsubscribes by endpoint and prunes only the captured generation", async () => {
    const store = new WebPushStore(nullPersistence());
    await store.load();
    await store.subscribe(subscriptionFixture());
    await store.subscribe(subscriptionFixture("https://fcm.googleapis.com/fcm/send/token-other-padding"));
    await store.unsubscribe(endpoint());
    expect(store.snapshot().subscriptions).toHaveLength(1);
    // Same endpoint, new generation: pruning the stale generation must keep the fresh one.
    const stale = await store.subscribe(subscriptionFixture("https://fcm.googleapis.com/fcm/send/token-other-padding"));
    await store.subscribe(subscriptionFixture("https://fcm.googleapis.com/fcm/send/token-other-padding"));
    await store.unsubscribe(stale.subscription.endpoint, stale.generation);
    const remaining = store.snapshot().subscriptions;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.generation).not.toBe(stale.generation);
  });

  it("rejects a 21st subscription", async () => {
    const store = new WebPushStore(nullPersistence());
    await store.load();
    for (let index = 0; index < 20; index += 1) {
      await store.subscribe(subscriptionFixture(`https://fcm.googleapis.com/fcm/send/token-${String(index).padStart(2, "0")}-padding`));
    }
    await expect(store.subscribe(subscriptionFixture("https://fcm.googleapis.com/fcm/send/token-21-extra-pad"))).rejects.toThrow("limit");
  });

  it("serializes mutations so in-flight writes never resurrect or drop records", async () => {
    const releases: (() => void)[] = [];
    const writes: PushState[] = [];
    let blockSaves = false;
    const store = new WebPushStore({
      load: () => Promise.resolve(undefined),
      save(state) {
        writes.push(state);
        if (!blockSaves) return Promise.resolve();
        return new Promise<void>((resolve) => { releases.push(resolve); });
      },
    });
    await store.load();
    blockSaves = true;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const firstPromise = store.subscribe(subscriptionFixture());
    await tick();
    // Publication follows the durable write: nothing is visible while save is in flight.
    expect(store.snapshot().subscriptions).toHaveLength(0);
    const secondPromise = store.subscribe(subscriptionFixture("https://fcm.googleapis.com/fcm/send/token-second-pad"));
    await tick();
    releases[0]?.();
    const first = await firstPromise;
    expect(store.current(first)).toBe(true);
    expect(store.snapshot().subscriptions).toHaveLength(1);
    await tick(); // The chained second save has started and is now the blocked write.
    releases[1]?.();
    const second = await secondPromise;
    expect(store.snapshot().subscriptions.map((entry) => entry.generation)).toEqual([first.generation, second.generation]);
    // The second read-modify-write saw the first commit: nothing was dropped.
    expect(writes[2]?.subscriptions).toHaveLength(2);
  });

  it("surfaces corrupt state instead of discarding it", async () => {
    const invalidJson = new WebPushStore({ load: () => Promise.resolve("not json"), save: () => Promise.resolve() });
    await expect(invalidJson.load()).rejects.toThrow();
    const wrongVersion = new WebPushStore({ load: () => Promise.resolve({ version: 2, vapid: {}, subscriptions: [] }), save: () => Promise.resolve() });
    await expect(wrongVersion.load()).rejects.toThrow("Corrupt");
  });

  it("surfaces duplicate endpoints and bad generations as corruption", async () => {
    const fixture = subscriptionFixture();
    const pair = createECDH("prime256v1");
    pair.generateKeys();
    const vapid = { publicKey: pair.getPublicKey().toString("base64url"), privateKey: pair.getPrivateKey().toString("base64url") };
    const record = { subscription: { endpoint: fixture.endpoint, keys: fixture.keys }, generation: "00000000-0000-4000-8000-000000000000" };
    const duplicates = new WebPushStore({ load: () => Promise.resolve({ version: 1, vapid, subscriptions: [record, record] }), save: () => Promise.resolve() });
    await expect(duplicates.load()).rejects.toThrow("Corrupt");
    const badGeneration = new WebPushStore({ load: () => Promise.resolve({ version: 1, vapid, subscriptions: [{ ...record, generation: "not-a-uuid" }] }), save: () => Promise.resolve() });
    await expect(badGeneration.load()).rejects.toThrow("Corrupt");
  });

  it("rejects a VAPID keypair that does not match", async () => {
    const good = createECDH("prime256v1");
    good.generateKeys();
    const bad = createECDH("prime256v1");
    bad.generateKeys();
    const store = new WebPushStore({
      load: () => Promise.resolve({ version: 1, vapid: { publicKey: good.getPublicKey().toString("base64url"), privateKey: bad.getPrivateKey().toString("base64url") }, subscriptions: [] }),
      save: () => Promise.resolve(),
    });
    await expect(store.load()).rejects.toThrow("Corrupt");
  });

  it("surfaces invalid subscriptions persisted in state", async () => {
    const pair = createECDH("prime256v1");
    pair.generateKeys();
    const store = new WebPushStore({
      load: () => Promise.resolve({
        version: 1,
        vapid: { publicKey: pair.getPublicKey().toString("base64url"), privateKey: pair.getPrivateKey().toString("base64url") },
        subscriptions: [{ subscription: { endpoint: "https://attacker.test/x", keys: { p256dh: "AA", auth: "AA" } }, generation: "00000000-0000-4000-8000-000000000000" }],
      }),
      save: () => Promise.resolve(),
    });
    await expect(store.load()).rejects.toThrow();
  });
});

describe("FileWebPushPersistence", () => {
  it("creates a private directory and returns undefined when no state exists", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "web-push-test-")), "web-push");
    const persistence = new FileWebPushPersistence(directory);
    await expect(persistence.load()).resolves.toBeUndefined();
    await rm(directory, { recursive: true, force: true });
  });

  it("saves atomically with 0700/0600 permissions and reloads state", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "web-push-test-")), "web-push");
    const persistence = new FileWebPushPersistence(directory);
    const pair = createECDH("prime256v1");
    pair.generateKeys();
    const state: PushState = { version: 1, vapid: { publicKey: pair.getPublicKey().toString("base64url"), privateKey: pair.getPrivateKey().toString("base64url") }, subscriptions: [] };
    await persistence.save(state);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, "state.json")).mode & 0o777).toBe(0o600);
    await expect(persistence.load()).resolves.toEqual(state);
    const entries = await readdir(directory);
    expect(entries).toContain("state.json");
    await expect(readFile(join(directory, "state.json"), "utf8")).resolves.toContain("version");
    await rm(directory, { recursive: true, force: true });
  });

  it("surfaces corrupt files as load errors, never as empty state", async () => {
    const directory = join(await mkdtemp(join(tmpdir(), "web-push-test-")), "web-push");
    const persistence = new FileWebPushPersistence(directory);
    await persistence.load();
    await writeFile(join(directory, "state.json"), "{ truncated", { mode: 0o600 });
    await expect(persistence.load()).rejects.toThrow("Cannot load web push state");
    await rm(directory, { recursive: true, force: true });
  });
});
