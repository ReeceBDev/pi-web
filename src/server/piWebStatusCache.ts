import type { PiWebStatusResponse } from "../shared/apiTypes.js";

const DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS = 60_000;

/** How long an expired-cache get() waits for its refresh before serving stale. */
const DEFAULT_STALE_GRACE_MS = 8_000;

export interface PiWebStatusCacheOptions {
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  /** Grace window for an expired-cache get() to return fresh data. */
  staleGraceMs?: number;
}

export interface PiWebStatusCacheLoadOptions {
  force: boolean;
}

export interface PiWebStatusCacheRefreshOptions {
  force?: boolean;
}

export interface TtlCache<T> {
  get(): Promise<T>;
  refresh(options?: PiWebStatusCacheRefreshOptions): Promise<T>;
  invalidate(): void;
}

export type PiWebStatusCache = TtlCache<PiWebStatusResponse>;

export function createPiWebStatusCache(load: (options: PiWebStatusCacheLoadOptions) => Promise<PiWebStatusResponse>, options: PiWebStatusCacheOptions = {}): PiWebStatusCache {
  return createTtlCache(load, options);
}

export function createTtlCache<T>(load: (options: PiWebStatusCacheLoadOptions) => Promise<T>, options: PiWebStatusCacheOptions = {}): TtlCache<T> {
  const ttlMs = options.ttlMs ?? DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS;
  const staleGraceMs = options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
  const now = options.now ?? Date.now;
  let cached: { status: T; expiresAt: number } | undefined;
  let pending: { promise: Promise<T>; force: boolean; sequence: number } | undefined;
  let loadSequence = 0;

  const refresh = (refreshOptions: PiWebStatusCacheRefreshOptions = {}): Promise<T> => {
    const force = refreshOptions.force === true;
    if (pending !== undefined && (!force || pending.force)) return pending.promise;

    const sequence = ++loadSequence;
    const promise = Promise.resolve()
      .then(() => load({ force }))
      .then((status) => {
        if (sequence === loadSequence) cached = { status, expiresAt: now() + ttlMs };
        return status;
      })
      .finally(() => {
        if (pending?.sequence === sequence) pending = undefined;
      });
    pending = { promise, force, sequence };
    return promise;
  };

  return {
    async get(): Promise<T> {
      if (cached === undefined) return refresh();
      if (cached.expiresAt > now()) return cached.status;
      // Expired: an idle cache previously served its stale value FOREVER (the
      // background refresh only ran after some request had already been answered),
      // so the first requester after hours idle got hours-old data — a push-tap
      // deep link resolved its session against that stale catalog, missed, and
      // fell back to the project listing. Now get() waits a bounded grace window
      // for the refresh; only a slower-than-grace load falls back to stale (the
      // refresh keeps running either way).
      const stale = cached.status;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<T>((resolve) => {
        graceTimer = setTimeout(() => {
          resolve(stale);
        }, staleGraceMs);
      });
      try {
        return await Promise.race([
          refresh().catch((error: unknown) => {
            options.onError?.(error);
            return stale;
          }),
          grace,
        ]);
      } finally {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
      }
    },
    refresh,
    invalidate(): void {
      cached = undefined;
      loadSequence += 1;
      pending = undefined;
    },
  };
}
