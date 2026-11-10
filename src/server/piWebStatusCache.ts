import type { PiWebStatusResponse } from "../shared/apiTypes.js";

const DEFAULT_PI_WEB_STATUS_CACHE_TTL_MS = 60_000;

export interface PiWebStatusCacheOptions {
  ttlMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
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
      if (cached !== undefined) {
        if (cached.expiresAt > now()) return cached.status;
        void refresh().catch((error: unknown) => { options.onError?.(error); });
        return cached.status;
      }
      return refresh();
    },
    refresh,
    invalidate(): void {
      cached = undefined;
      loadSequence += 1;
      pending = undefined;
    },
  };
}
