import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SessionStatus, type SessionTranscriptSnapshot } from "./api";
import { readChatHistoryCache } from "./chatHistoryCache";
import { prefetchDeepLinkChatHistory } from "./chatDeepLinkPrefetch";

const originalWindow = globalThis.window;
const originalSessionStorage = globalThis.sessionStorage;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: originalSessionStorage, configurable: true });
});

function installBrowser(search: string): void {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { value: { location: { search } }, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
      clear: () => { map.clear(); },
    },
    configurable: true,
  });
}

function snapshot(messages: string[]): SessionTranscriptSnapshot {
  const status: SessionStatus = { sessionId: "s1", isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, queuedMessages: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  return { page: { messages, start: 0, total: messages.length }, status, seq: 0, partial: undefined };
}

describe("prefetchDeepLinkChatHistory", () => {
  it("fetches the transcript with the deep link session ref and caches the page", () => {
    installBrowser("?session=s1&cwd=%2Fwork%2Fdemo&view=chat");
    const fetchSnapshot = vi.spyOn(api, "transcriptSnapshot").mockResolvedValue(snapshot(["a"]));

    prefetchDeepLinkChatHistory();
    void vi.waitFor(() => { expect(readChatHistoryCache("local:s1")).toBeDefined(); });

    expect(fetchSnapshot).toHaveBeenCalledWith({ id: "s1", cwd: "/work/demo" }, { limit: 100 }, "local");
  });

  it("skips when the deep link carries no cwd", () => {
    installBrowser("?session=s1&view=chat");
    const fetchSnapshot = vi.spyOn(api, "transcriptSnapshot").mockResolvedValue(snapshot(["a"]));

    prefetchDeepLinkChatHistory();

    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(readChatHistoryCache("local:s1")).toBeUndefined();
  });

  it("skips when the cache already holds the page", async () => {
    installBrowser("?session=s1&cwd=%2Fwork%2Fdemo&view=chat");
    const fetchSnapshot = vi.spyOn(api, "transcriptSnapshot").mockResolvedValue(snapshot(["a"]));

    prefetchDeepLinkChatHistory();
    await vi.waitFor(() => { expect(readChatHistoryCache("local:s1")).toBeDefined(); });
    prefetchDeepLinkChatHistory();

    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("ignores fetch failures so the normal load path stays untouched", async () => {
    installBrowser("?session=s1&cwd=%2Fwork%2Fdemo&view=chat");
    vi.spyOn(api, "transcriptSnapshot").mockRejectedValue(new Error("offline"));

    expect(() => { prefetchDeepLinkChatHistory(); }).not.toThrow();
    await vi.waitFor(() => { expect(readChatHistoryCache("local:s1")).toBeUndefined(); });
  });
});
