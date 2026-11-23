import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * Workspaces whose newest session file changed within this window count as
 * recently active and get warmed; anything older is skipped, so an idle
 * workspace never costs background CPU.
 */
const DEFAULT_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Give the daemon a moment to finish startup before the single warm run. */
const DEFAULT_INITIAL_DELAY_MS = 30_000;

/** Minimal structured-logging seam for warm-run lifecycle and non-fatal failures. */
export interface SessionWorkspaceWarmerLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface SessionWorkspaceWarmerOptions {
  /**
   * Root of the default pi session store: one subdirectory per workspace.
   * Only this store is warmed — workspaces that configure their own session
   * dir through settings or the environment are served from their own store
   * and stay out of scope here.
   */
  sessionsRoot: string;
  /**
   * Scan one workspace session dir purely to fill the daemon's summary memo.
   * Returns the number of sessions scanned, for the per-workspace log line.
   */
  scanSessionDir: (sessionDir: string) => Promise<number>;
  logger?: SessionWorkspaceWarmerLogger;
  initialDelayMs?: number;
  activeWindowMs?: number;
}

const noopLogger: SessionWorkspaceWarmerLogger = {
  info() { /* no-op */ },
  warn() { /* no-op */ },
  error() { /* no-op */ },
};

/**
 * Fills the session summary memo for recently active workspaces once, shortly
 * after daemon start, so the first open of a workspace you used this week
 * answers from the memo instead of a cold multi-megabyte scan.
 *
 * Like the model catalog refresher, this runs off any request path with an
 * unref'd timer and stops at `dispose()`. Unlike it, there is no schedule:
 * exactly one run per daemon start. Workspace dirs are scanned serialized —
 * the summary scanner already bounds its work per dir — and a failure on one
 * dir is logged and skipped, never thrown out of the run.
 */
export class SessionWorkspaceWarmer {
  private readonly sessionsRoot: string;
  private readonly scanSessionDir: (sessionDir: string) => Promise<number>;
  private readonly logger: SessionWorkspaceWarmerLogger;
  private readonly initialDelayMs: number;
  private readonly activeWindowMs: number;
  private initialTimer: NodeJS.Timeout | undefined;
  private run: Promise<void> | undefined;
  private started = false;
  private disposed = false;

  constructor(options: SessionWorkspaceWarmerOptions) {
    this.sessionsRoot = options.sessionsRoot;
    this.scanSessionDir = options.scanSessionDir;
    this.logger = options.logger ?? noopLogger;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.activeWindowMs = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  }

  /** Idempotent: a second call keeps the timer the first call installed. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.initialTimer = setTimeout(() => { this.run ??= this.runOnce(); }, this.initialDelayMs);
    this.initialTimer.unref();
  }

  /** Resolves once the one warm run (if one was due) has finished. Callers that need to sequence against the background work await this instead of guessing at timing. */
  whenWarmComplete(): Promise<void> {
    return this.run ?? Promise.resolve();
  }

  /**
   * Terminal: cancels a run that has not started yet. A run already in flight
   * checks the flag between workspaces and stops early.
   */
  dispose(): void {
    this.disposed = true;
    if (this.initialTimer !== undefined) clearTimeout(this.initialTimer);
    this.initialTimer = undefined;
  }

  /** One warm pass over the store. Reports every failure through the logger and never throws. */
  private async runOnce(): Promise<void> {
    if (this.disposed) return;
    let workspaceDirs: string[];
    try {
      const entries = await readdir(this.sessionsRoot, { withFileTypes: true });
      workspaceDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => join(this.sessionsRoot, entry.name));
    } catch (error) {
      this.logger.warn({ err: error, sessionsRoot: this.sessionsRoot }, "session workspace warm could not list the session store; skipping");
      return;
    }
    const activeCutoffMs = Date.now() - this.activeWindowMs;
    const activeDirs: string[] = [];
    for (const workspaceDir of workspaceDirs) {
      if (await this.isRecentlyActive(workspaceDir, activeCutoffMs)) activeDirs.push(workspaceDir);
    }
    let warmed = 0;
    let sessions = 0;
    for (const workspaceDir of activeDirs) {
      if (this.isDisposed()) break;
      try {
        const scanned = await this.scanSessionDir(workspaceDir);
        warmed += 1;
        sessions += scanned;
        this.logger.info({ workspace: basename(workspaceDir), sessions: scanned }, "warmed session summaries for a recently active workspace");
      } catch (error) {
        this.logger.warn({ err: error, workspace: basename(workspaceDir) }, "session workspace warm failed for a workspace; skipping");
      }
    }
    this.logger.info({ warmed, total: workspaceDirs.length, skipped: workspaceDirs.length - warmed, sessions }, "background session summary warm finished");
  }

  /** Fresh read of the disposal flag for the between-workspace check. */
  private isDisposed(): boolean {
    return this.disposed;
  }

  /** Whether any session file in the dir changed within the active window. Unreadable dirs are skipped with a warning. */
  private async isRecentlyActive(workspaceDir: string, activeCutoffMs: number): Promise<boolean> {
    try {
      const names = await readdir(workspaceDir);
      const sessionStats = await Promise.all(
        names.filter((name) => name.endsWith(".jsonl")).map((name) => stat(join(workspaceDir, name))),
      );
      return sessionStats.some((sessionStat) => sessionStat.mtimeMs >= activeCutoffMs);
    } catch (error) {
      this.logger.warn({ err: error, workspace: basename(workspaceDir) }, "session workspace warm could not inspect a workspace; skipping");
      return false;
    }
  }
}
