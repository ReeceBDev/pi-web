import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { BrowserReaper } from "./browserReaper.js";

interface LaunchedBrowser {
  isConnected(): boolean;
  on(event: "disconnected", listener: () => void): unknown;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: { launch(): Promise<LaunchedBrowser> };
}

type PlaywrightRequire = (request: string) => unknown;

function isPlaywrightModule(value: unknown): value is PlaywrightModule {
  if (typeof value !== "object" || value === null || !("chromium" in value)) return false;
  const chromium: unknown = value.chromium;
  if (typeof chromium !== "object" || chromium === null || !("launch" in chromium)) return false;
  return typeof chromium.launch === "function";
}

/**
 * Playwright is not a devDependency of this repo; it arrives with the
 * pi-browser extension. Resolve it from there so the test runs wherever the
 * extension is installed, and skip cleanly elsewhere.
 */
function loadPlaywright(): PlaywrightModule | undefined {
  const requireFromHere: PlaywrightRequire = createRequire(import.meta.url);
  for (const request of ["playwright", "/home/rbowen/.pi/agent/extensions/pi-browser/node_modules/playwright"]) {
    let module: unknown;
    try {
      module = requireFromHere(request);
    } catch {
      continue;
    }
    if (isPlaywrightModule(module)) return module;
  }
  return undefined;
}

const HOUR_MS = 60 * 60 * 1000;

describe("BrowserReaper against a real Playwright browser", () => {
  const playwright = loadPlaywright();
  if (playwright === undefined) {
    it.skip("needs the pi-browser extension's playwright installation", () => { /* skipped */ });
    return;
  }
  const pw = playwright;

  it("spares a fresh browser in one real pass, then reaps it once it counts as stale", { timeout: 120_000 }, async () => {
    const browser = await pw.chromium.launch();
    const disconnected = new Promise<void>((resolve) => { browser.on("disconnected", resolve); });
    // Real SIGTERM, observed: the sweep must find the browser through the real
    // /proc listing, and the terminated main must take its helpers with it.
    const signaled: number[] = [];
    const killForReal = (pid: number) => {
      signaled.push(pid);
      process.kill(pid, "SIGTERM");
    };
    try {
      // With the production default age (six hours) a just-launched browser is
      // never a candidate: the real listing must find nothing to reap forked
      // by this test process and the browser must stay connected.
      const freshSweep = new BrowserReaper({ maxAgeMs: 6 * HOUR_MS, killProcess: killForReal });
      await expect(freshSweep.sweepOnce()).resolves.toBe(0);
      expect(browser.isConnected()).toBe(true);
      expect(signaled).toEqual([]);

      // Zero the age gate: the same real listing now reaps the one browser
      // this process forked, and the browser goes down as a result.
      const staleSweep = new BrowserReaper({ maxAgeMs: 0, killProcess: killForReal });
      await expect(staleSweep.sweepOnce()).resolves.toBe(1);
      await disconnected;
      expect(browser.isConnected()).toBe(false);
      expect(signaled).toHaveLength(1);
    } finally {
      await browser.close().catch(() => undefined);
    }
  });
});
