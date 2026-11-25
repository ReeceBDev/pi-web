import { readdir, readFile } from "node:fs/promises";
import { DEFAULT_BROWSER_MAX_AGE_HOURS } from "../../config.js";

/** Sweep cadence for the orphaned-browser scan. */
const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** Playwright names every temporary browser profile it creates with this marker, so no other process's user-data-dir can match. */
const PLAYWRIGHT_PROFILE_MARKER = "playwright_chromiumdev_profile";
/**
 * The /proc ABI reports process times in fixed USER_HZ units (100 ticks per
 * second on every Linux kernel since 2.6), independent of the live scheduler
 * tick, so the value is safe to hardcode.
 */
const PROC_USER_HZ = 100;
/** Matches a `--user-data-dir=` value pointing at a Playwright-managed temporary profile. */
const PLAYWRIGHT_PROFILE_ARG = new RegExp(`--user-data-dir=\\S*${PLAYWRIGHT_PROFILE_MARKER}`);
/** Matches a `--type=` helper switch (renderer/zygote/gpu/...) at an argument boundary. */
const HELPER_TYPE_ARG = /(^|\s)--type=/;

/** Minimal structured-logging seam for sweep summaries and non-fatal failures. */
export interface BrowserReaperLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

/** One live process that looks like a Playwright browser main forked by this daemon. */
export interface BrowserCandidate {
  pid: number;
  parentPid: number;
  /** Milliseconds since the process started, as of the listing pass. */
  ageMs: number;
}

export interface BrowserReaperOptions {
  logger?: BrowserReaperLogger;
  sweepIntervalMs?: number;
  /** Browsers older than this are treated as orphaned; defaults from PI_WEB_BROWSER_MAX_AGE_HOURS. */
  maxAgeMs?: number;
  /** Only processes forked directly by this pid are reapable; defaults to the current process. */
  daemonPid?: number;
  /** Lists Playwright browser mains forked by the daemon. Defaults to the real /proc scan. */
  listCandidates?: () => Promise<BrowserCandidate[]>;
  /** Terminates one process. Defaults to SIGTERM. */
  killProcess?: (pid: number) => void;
}

const noopLogger: BrowserReaperLogger = {
  info() { /* no-op */ },
  warn() { /* no-op */ },
  error() { /* no-op */ },
};

/**
 * True when a command line looks like a Playwright browser main: its
 * user-data-dir is a Playwright temporary profile and it carries no `--type=`
 * helper switch. Chromium rewrites its argv block space-separated behind a
 * single trailing NUL, so NUL bytes are normalized to spaces before matching
 * and both argv layouts are handled.
 */
export function looksLikePlaywrightBrowserMain(commandLine: string): boolean {
  const normalized = commandLine.split("\0").join(" ");
  if (HELPER_TYPE_ARG.test(normalized)) return false;
  return PLAYWRIGHT_PROFILE_ARG.test(normalized);
}

/** Boot time in epoch milliseconds, parsed from /proc/stat's `btime` line. */
async function bootTimeMs(): Promise<number> {
  const procStat = await readFile("/proc/stat", "utf8");
  const match = /^btime (\d+)$/m.exec(procStat);
  if (match === null) throw new Error("/proc/stat carries no btime line; process ages cannot be computed");
  return Number(match[1]) * 1000;
}

/**
 * Scans /proc for Playwright browser main processes forked directly by the
 * daemon process, with their current age. Helper processes are excluded by
 * their `--type=` switch (they die with their main anyway), and processes
 * whose parent is not the daemon are excluded so the reaper never touches
 * browsers owned by other processes, including the standalone pi CLI.
 */
async function listDaemonBrowserMains(daemonPid: number): Promise<BrowserCandidate[]> {
  const bootMs = await bootTimeMs();
  const entries = await readdir("/proc");
  const candidates: BrowserCandidate[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    // stat: `pid (comm) state ppid ... starttime`; after the comm's closing paren, index 1 is ppid and index 19 is starttime (field 22).
    const statRaw = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
    if (statRaw === null) continue;
    const afterComm = statRaw.slice(statRaw.lastIndexOf(")") + 2).split(" ");
    if (Number(afterComm[1]) !== daemonPid) continue;
    const commandLine = (await readFile(`/proc/${entry}/cmdline`, "utf8").catch(() => ""));
    if (!looksLikePlaywrightBrowserMain(commandLine)) continue;
    const startMs = bootMs + (Number(afterComm[19]) / PROC_USER_HZ) * 1000;
    candidates.push({ pid: Number(entry), parentPid: daemonPid, ageMs: Date.now() - startMs });
  }
  return candidates;
}

/**
 * Daemon-side safety net for leaked pi-session browsers. A browser launched
 * for a session outlives the session whenever its pipeline ends without
 * runtime disposal — the close chain (dispose → session_shutdown → extension
 * disconnect) never runs — and the daemon then keeps it as a direct child
 * forever. On a fixed interval this reaper signals such browser mains once
 * they are older than the max age: only processes forked directly by the
 * daemon whose command line is a Playwright browser main are eligible, so a
 * live session's fresh browser is never touched and helper processes follow
 * their terminated main. Failures are logged per process and never thrown; a
 * sweep that cannot list candidates is skipped wholesale.
 */
export class BrowserReaper {
  private readonly logger: BrowserReaperLogger;
  private readonly sweepIntervalMs: number;
  private readonly maxAgeMs: number;
  private readonly daemonPid: number;
  private readonly listCandidates: () => Promise<BrowserCandidate[]>;
  private readonly killProcess: (pid: number) => void;
  private sweepTimer: NodeJS.Timeout | undefined;
  private started = false;
  private disposed = false;

  constructor(options: BrowserReaperOptions) {
    this.logger = options.logger ?? noopLogger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_BROWSER_MAX_AGE_HOURS * 60 * 60 * 1000;
    this.daemonPid = options.daemonPid ?? process.pid;
    this.listCandidates = options.listCandidates ?? (() => listDaemonBrowserMains(this.daemonPid));
    this.killProcess = options.killProcess ?? ((pid) => process.kill(pid, "SIGTERM"));
  }

  /** Idempotent: a second call keeps the interval the first call installed. */
  start(): void {
    if (this.disposed || this.started) return;
    this.started = true;
    this.sweepTimer = setInterval(() => { void this.sweepOnce(); }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  /** Terminal: stops the interval. An in-flight sweep finishes on its own; its kills stay safe after dispose. */
  dispose(): void {
    this.disposed = true;
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /** One sweep. Signals every candidate older than the max age and returns how many were signaled; reports every failure through the logger and never throws. */
  async sweepOnce(): Promise<number> {
    if (this.disposed) return 0;
    let candidates: BrowserCandidate[];
    try {
      candidates = await this.listCandidates();
    } catch (error) {
      this.logger.warn({ err: error }, "browser reaper could not list candidate processes; skipping sweep");
      return 0;
    }
    const signaled: { pid: number; ageHours: number }[] = [];
    for (const candidate of candidates) {
      if (candidate.ageMs <= this.maxAgeMs) continue;
      try {
        this.killProcess(candidate.pid);
        signaled.push({ pid: candidate.pid, ageHours: Math.round((candidate.ageMs / 3_600_000) * 10) / 10 });
      } catch (error) {
        this.logger.warn({ err: error, pid: candidate.pid }, "browser reaper failed to signal an orphaned browser");
      }
    }
    if (signaled.length > 0) {
      this.logger.info({ reaped: signaled.length, browsers: signaled }, "browser reaper terminated orphaned browsers");
    }
    return signaled.length;
  }
}
