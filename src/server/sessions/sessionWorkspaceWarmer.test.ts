import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspaceWarmer } from "./sessionWorkspaceWarmer.js";

function deferred(): { promise: Promise<number>; resolve: (count: number) => void } {
  let resolveValue: (count: number) => void = () => undefined;
  const promise = new Promise<number>((resolve) => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}

function createLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return { logger: { info, warn, error }, info, warn, error };
}

const DAY_MS = 24 * 60 * 60 * 1000;

let tempDir: string;
let sessionsRoot: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-workspace-warmer-test-"));
  sessionsRoot = join(tempDir, "sessions");
  await mkdir(sessionsRoot, { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(tempDir, { recursive: true, force: true });
});

describe("SessionWorkspaceWarmer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** Fire the warm timer and wait for the run it starts to finish. */
  async function runWarm(warmer: SessionWorkspaceWarmer): Promise<void> {
    await vi.advanceTimersByTimeAsync(30_000);
    await warmer.whenWarmComplete();
  }

  it("warms only workspaces whose newest session changed within the active window", async () => {
    const activeDir = await writeActiveWorkspace("--home-rbowen-active--");
    await writeStaleWorkspace("--home-rbowen-stale--");
    const emptyDir = join(sessionsRoot, "--home-rbowen-empty--");
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(sessionsRoot, "not-a-workspace.jsonl"), "{}\n");
    const scanSessionDir = vi.fn(() => Promise.resolve(3));
    const { logger, info } = createLogger();
    const warmer = new SessionWorkspaceWarmer({ sessionsRoot, scanSessionDir, logger });

    warmer.start();
    await runWarm(warmer);

    expect(scanSessionDir).toHaveBeenCalledTimes(1);
    expect(scanSessionDir).toHaveBeenCalledWith(activeDir);
    expect(info).toHaveBeenCalledWith(
      { warmed: 1, total: 3, skipped: 2, sessions: 3 },
      "background session summary warm finished",
    );
    warmer.dispose();
  });

  it("warms active workspaces one at a time", async () => {
    const firstDir = await writeActiveWorkspace("--home-rbowen-first--");
    const secondDir = await writeActiveWorkspace("--home-rbowen-second--");
    const firstScan = deferred();
    let call = 0;
    const scanSessionDir = vi.fn(() => {
      call += 1;
      return call === 1 ? firstScan.promise : Promise.resolve(1);
    });
    const warmer = new SessionWorkspaceWarmer({ sessionsRoot, scanSessionDir });

    warmer.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => { expect(scanSessionDir).toHaveBeenCalledTimes(1); });

    expect(scanSessionDir).toHaveBeenCalledWith(firstDir);
    firstScan.resolve(2);
    await warmer.whenWarmComplete();

    expect(scanSessionDir).toHaveBeenCalledTimes(2);
    expect(scanSessionDir).toHaveBeenCalledWith(secondDir);
    warmer.dispose();
  });

  it("stops between workspaces when disposed mid-run and never restarts", async () => {
    await writeActiveWorkspace("--home-rbowen-first--");
    await writeActiveWorkspace("--home-rbowen-second--");
    const firstScan = deferred();
    const scanSessionDir = vi.fn(() => firstScan.promise);
    const warmer = new SessionWorkspaceWarmer({ sessionsRoot, scanSessionDir });

    warmer.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => { expect(scanSessionDir).toHaveBeenCalledTimes(1); });
    warmer.dispose();
    firstScan.resolve(1);
    await warmer.whenWarmComplete();

    expect(scanSessionDir).toHaveBeenCalledTimes(1);
    warmer.start();
    await runWarm(warmer);
    expect(scanSessionDir).toHaveBeenCalledTimes(1);
  });

  it("cancels the run when disposed before the delay elapses", async () => {
    await writeActiveWorkspace("--home-rbowen-active--");
    const scanSessionDir = vi.fn(() => Promise.resolve(1));
    const warmer = new SessionWorkspaceWarmer({ sessionsRoot, scanSessionDir });

    warmer.start();
    warmer.dispose();
    await runWarm(warmer);

    expect(scanSessionDir).not.toHaveBeenCalled();
  });

  it("keeps the first timer when start is called twice", async () => {
    await writeActiveWorkspace("--home-rbowen-active--");
    const scanSessionDir = vi.fn(() => Promise.resolve(1));
    const warmer = new SessionWorkspaceWarmer({ sessionsRoot, scanSessionDir });

    warmer.start();
    warmer.start();
    await runWarm(warmer);

    expect(scanSessionDir).toHaveBeenCalledTimes(1);
    warmer.dispose();
  });

  it("warns and warms nothing when the session store root is missing", async () => {
    const scanSessionDir = vi.fn(() => Promise.resolve(1));
    const { logger, warn } = createLogger();
    const warmer = new SessionWorkspaceWarmer({ sessionsRoot: join(sessionsRoot, "absent"), scanSessionDir, logger });

    warmer.start();
    await runWarm(warmer);

    expect(scanSessionDir).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    warmer.dispose();
  });
});

/** A workspace dir in the store, with one session file written now (recently active). */
async function writeActiveWorkspace(name: string): Promise<string> {
  const workspaceDir = join(sessionsRoot, name);
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "2026-01-01T00-00-00-000Z_session.jsonl"), "{}\n");
  return workspaceDir;
}

/** A workspace whose only session files are older than the warm window. */
async function writeStaleWorkspace(name: string): Promise<string> {
  const workspaceDir = await writeActiveWorkspace(name);
  const stale = new Date(Date.now() - 8 * DAY_MS);
  await utimes(join(workspaceDir, "2026-01-01T00-00-00-000Z_session.jsonl"), stale, stale);
  return workspaceDir;
}
