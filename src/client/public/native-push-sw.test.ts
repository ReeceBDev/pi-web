import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const SW_PATH = new URL("./native-push-sw.js", import.meta.url).pathname;

interface Harness { chatUrl: (value: string) => string | null; listeners: Record<string, unknown> }

async function loadServiceWorker(scope: string): Promise<Harness> {
  const source = await readFile(SW_PATH, "utf8");
  const listeners: Record<string, unknown> = {};
  const context: Record<string, unknown> = {
    self: {
      addEventListener: (name: string, handler: unknown) => { listeners[name] = handler; },
      registration: { scope },
    },
    URL,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "native-push-sw.js" });
  const chatUrl = (value: string): string | null => {
    context["__input"] = value;
    const result: unknown = vm.runInContext("typeof chatUrl === 'function' ? chatUrl(__input) : null", context);
    return typeof result === "string" || result === null ? result : null;
  };
  return { chatUrl, listeners };
}

const SCOPE = "https://pi.example.test/pi-web/";

describe("native push service worker", () => {
  let harness: Harness;
  beforeAll(async () => { harness = await loadServiceWorker(SCOPE); });

  it("registers exactly push and notificationclick handlers and never a fetch handler", () => {
    expect(harness.listeners["push"]).toBeDefined();
    expect(harness.listeners["notificationclick"]).toBeDefined();
    expect(harness.listeners["fetch"]).toBeUndefined();
    expect(harness.listeners["install"]).toBeDefined();
    expect(harness.listeners["activate"]).toBeDefined();
  });

  it("accepts a well-formed chat deep link inside the registration scope", () => {
    const url = `${SCOPE}?machine=local&project=p1&workspace=w1&session=s1&view=chat`;
    expect(harness.chatUrl(url)).toBe(url);
  });

  it.each([
    ["cross-origin", "https://evil.test/pi-web/?machine=local&project=p1&workspace=w1&session=s1&view=chat"],
    ["path outside the scope", "https://pi.example.test/other/?machine=local&project=p1&workspace=w1&session=s1&view=chat"],
    ["nested path", "https://pi.example.test/pi-web/deep?machine=local&project=p1&workspace=w1&session=s1&view=chat"],
    ["credentials", "https://user:pass@pi.example.test/pi-web/?machine=local&project=p1&workspace=w1&session=s1&view=chat"],
    ["fragment", `${SCOPE}?machine=local&project=p1&workspace=w1&session=s1&view=chat#x`],
    ["missing parameter", `${SCOPE}?machine=local&project=p1&workspace=w1&view=chat`],
    ["extra parameter", `${SCOPE}?machine=local&project=p1&workspace=w1&session=s1&view=chat&x=1`],
    ["duplicated parameter", `${SCOPE}?machine=local&machine=local&project=p1&workspace=w1&session=s1&view=chat`],
    ["wrong machine", `${SCOPE}?machine=remote&project=p1&workspace=w1&session=s1&view=chat`],
    ["wrong view", `${SCOPE}?machine=local&project=p1&workspace=w1&session=s1&view=home`],
    ["empty session", `${SCOPE}?machine=local&project=p1&workspace=w1&session=&view=chat`],
    ["control characters", `${SCOPE}?machine=local&project=p1&workspace=w1&session=%0As1&view=chat`],
    ["oversized parameter", `${SCOPE}?machine=local&project=p1&workspace=w1&session=${"s".repeat(600)}&view=chat`],
    ["non-string input", "42"],
    ["empty value", ""],
  ])("rejects %s", (_label, value) => {
    expect(harness.chatUrl(value)).toBeNull();
  });
});
