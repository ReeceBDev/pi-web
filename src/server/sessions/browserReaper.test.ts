import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserReaper, looksLikePlaywrightBrowserMain, type BrowserCandidate } from "./browserReaper.js";

function createLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return { logger: { info, warn, error }, info, warn, error };
}

function candidate(pid: number, ageHours: number): BrowserCandidate {
  return { pid, parentPid: process.pid, ageMs: ageHours * 60 * 60 * 1000 };
}

const HOUR_MS = 60 * 60 * 1000;

describe("looksLikePlaywrightBrowserMain", () => {
  it("accepts a NUL-separated Playwright browser main command line", () => {
    const commandLine = [
      "/home/rbowen/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell",
      "--no-sandbox",
      "--user-data-dir=/tmp/playwright_chromiumdev_profile-Gn4eTQ",
      "--remote-debugging-pipe",
      "about:blank",
    ].join("\0");
    expect(looksLikePlaywrightBrowserMain(commandLine)).toBe(true);
  });

  it("accepts the space-separated command line Chromium rewrites into /proc", () => {
    const commandLine = [
      "/home/rbowen/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell",
      "--no-sandbox",
      "--user-data-dir=/tmp/playwright_chromiumdev_profile-Gn4eTQ",
    ].join(" ") + "\0";
    expect(looksLikePlaywrightBrowserMain(commandLine)).toBe(true);
  });

  it("rejects helper processes carrying a --type switch even with a Playwright profile", () => {
    const commandLine = [
      "/home/rbowen/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell",
      "--type=zygote",
      "--user-data-dir=/tmp/playwright_chromiumdev_profile-Gn4eTQ",
    ].join("\0");
    expect(looksLikePlaywrightBrowserMain(commandLine)).toBe(false);
  });

  it("rejects processes whose user-data-dir is not a Playwright temporary profile", () => {
    const commandLine = ["/usr/bin/chromium", "--user-data-dir=/home/rbowen/.config/chromium"].join("\0");
    expect(looksLikePlaywrightBrowserMain(commandLine)).toBe(false);
  });

  it("rejects a plain command line without a user-data-dir", () => {
    expect(looksLikePlaywrightBrowserMain(["/usr/bin/node", "server.js"].join("\0"))).toBe(false);
  });
});

describe("BrowserReaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("signals only candidates older than the max age", async () => {
    const killProcess = vi.fn();
    const stale = 9;
    const fresh = 0.1;
    const reaper = new BrowserReaper({
      maxAgeMs: 6 * HOUR_MS,
      listCandidates: () => Promise.resolve([candidate(101, stale), candidate(202, fresh)]),
      killProcess,
    });

    await expect(reaper.sweepOnce()).resolves.toBe(1);
    expect(killProcess).toHaveBeenCalledExactlyOnceWith(101);
  });

  it("continues past a kill failure and still counts the successes", async () => {
    const killError = new Error("ESRCH");
    const killProcess = vi.fn((pid: number) => {
      if (pid === 101) throw killError;
    });
    const { logger, warn } = createLogger();
    const reaper = new BrowserReaper({
      logger,
      maxAgeMs: 6 * HOUR_MS,
      listCandidates: () => Promise.resolve([candidate(101, 7), candidate(202, 8)]),
      killProcess,
    });

    await expect(reaper.sweepOnce()).resolves.toBe(1);
    expect(killProcess).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith({ err: killError, pid: 101 }, "browser reaper failed to signal an orphaned browser");
  });

  it("logs a summary when browsers are reaped and nothing when none are stale", async () => {
    const killProcess = vi.fn();
    const { logger, info } = createLogger();
    const quiet = new BrowserReaper({
      logger,
      maxAgeMs: 6 * HOUR_MS,
      listCandidates: () => Promise.resolve([candidate(303, 1)]),
      killProcess,
    });
    await expect(quiet.sweepOnce()).resolves.toBe(0);
    expect(killProcess).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();

    const loud = new BrowserReaper({
      logger,
      maxAgeMs: 6 * HOUR_MS,
      listCandidates: () => Promise.resolve([candidate(404, 13.5)]),
      killProcess,
    });
    await expect(loud.sweepOnce()).resolves.toBe(1);
    expect(info).toHaveBeenCalledWith(
      { reaped: 1, browsers: [{ pid: 404, ageHours: 13.5 }] },
      "browser reaper terminated orphaned browsers",
    );
  });

  it("skips the sweep and warns when listing fails", async () => {
    const listError = new Error("no /proc");
    const killProcess = vi.fn();
    const { logger, warn } = createLogger();
    const reaper = new BrowserReaper({
      logger,
      listCandidates: () => Promise.reject(listError),
      killProcess,
    });

    await expect(reaper.sweepOnce()).resolves.toBe(0);
    expect(killProcess).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ err: listError }, "browser reaper could not list candidate processes; skipping sweep");
  });

  it("sweeps on the interval, keeps the first timer across double start, and stops at dispose", async () => {
    const listCandidates = vi.fn(() => Promise.resolve([]));
    const reaper = new BrowserReaper({ sweepIntervalMs: 10 * 60 * 1000, listCandidates });

    reaper.start();
    reaper.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(listCandidates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(listCandidates).toHaveBeenCalledTimes(2);

    reaper.dispose();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(listCandidates).toHaveBeenCalledTimes(2);

    reaper.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(listCandidates).toHaveBeenCalledTimes(2);
  });

  it("does not sweep after dispose even when dispose precedes the first tick", async () => {
    const listCandidates = vi.fn(() => Promise.resolve([]));
    const reaper = new BrowserReaper({ sweepIntervalMs: 10 * 60 * 1000, listCandidates });

    reaper.start();
    reaper.dispose();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(listCandidates).not.toHaveBeenCalled();
    await expect(reaper.sweepOnce()).resolves.toBe(0);
  });
});
