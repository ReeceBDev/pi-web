import { lookup } from "node:dns";
import { Agent, request } from "node:https";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import webPush from "web-push";
import type { SessionUnreadCatalogSnapshot, SessionUnreadEvent, SessionUnreadSummary } from "../../shared/apiTypes.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import { validatePushSubscription, type PushRecord, type WebPushStore } from "./webPushStore.js";

export interface PushDeliveryResult { status: number; retryAfter?: string | undefined }
export type PushSender = (record: PushRecord, payload: string, timeoutMs: number) => Promise<PushDeliveryResult>;
interface PushJob {
  record: PushRecord;
  url: string;
  event?: SessionUnreadEvent;
  finish?: (accepted: boolean) => void;
}
interface PendingCompletion { timer: ReturnType<typeof setTimeout>; event: SessionUnreadEvent }
export interface WebPushDependencies {
  store: WebPushStore;
  baseUrl: string;
  resolveChat: (summary: SessionUnreadSummary) => Promise<{ projectId: string; workspaceId: string } | undefined>;
  isCurrent: (event: SessionUnreadEvent) => boolean;
  mayNotify: (summary: SessionUnreadSummary) => boolean;
  report: (reason: string) => void;
  sender?: PushSender;
}

/** Public-only resolution is part of the actual TLS connection, not a preflight. */
export function publicPushLookup(resolve: typeof lookup = lookup): LookupFunction {
  return (hostname, options, callback) => {
    if (!["fcm.googleapis.com", "updates.push.services.mozilla.com"].includes(hostname)) { callback(new Error("Push host denied"), "", 4); return; }
    let settled = false;
    const finish: typeof callback = (...args) => { if (settled) return; settled = true; clearTimeout(timer); callback(...args); };
    const timer = setTimeout(() => { finish(new Error("Push DNS timeout"), "", 4); }, 2000);
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error !== null) { finish(error, "", 4); return; }
      if (addresses.length === 0 || addresses.some(({ address }) => !ipaddr.isValid(address) || ipaddr.process(address).range() !== "unicast")) { finish(new Error("Push DNS address denied"), "", 4); return; }
      const family = typeof options === "number" ? options : options.family;
      const filtered = family === 4 || family === 6 ? addresses.filter((entry) => entry.family === family) : addresses;
      const first = filtered[0];
      if (first === undefined) { finish(new Error("Push DNS family unavailable"), "", 4); return; }
      if (typeof options === "object" && options.all === true) finish(null, filtered);
      else finish(null, first.address, first.family);
    });
  };
}

export function createPushSender(store: WebPushStore, subject: string): { send: PushSender; dispose: () => void } {
  const agent = new Agent({ keepAlive: false, lookup: publicPushLookup(), rejectUnauthorized: true });
  const send: PushSender = async (record, payload, timeoutMs) => {
    const subscription = validatePushSubscription(record.subscription);
    const vapid = store.snapshot().vapid;
    const details = webPush.generateRequestDetails(subscription, payload, {
      TTL: 60, urgency: "normal", contentEncoding: "aes128gcm",
      vapidDetails: { subject, ...vapid },
    });
    return new Promise((resolve, reject) => {
      // Native HTTPS never follows redirects or inherits HTTP proxy environment variables.
      const outgoing = request(details.endpoint, { method: details.method, headers: details.headers, agent, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) }, (response) => {
        response.resume();
        const retryHeader: unknown = response.headers["retry-after"];
        const retryAfter = typeof retryHeader === "string" ? retryHeader
          : Array.isArray(retryHeader) && typeof retryHeader[0] === "string" ? retryHeader[0] : undefined;
        resolve({ status: response.statusCode ?? 0, retryAfter });
      });
      outgoing.on("error", () => { reject(new Error("Push transport failed")); });
      outgoing.end(details.body);
    });
  };
  return { send, dispose: () => { agent.destroy(); } };
}

/** Unread completion delivery for this daemon's local machine only. */
export class WebPushService {
  private catalogId = "";
  private revision = 0;
  private readonly completions = new Map<string, PendingCompletion>();
  private readonly jobs = new Map<string, PushJob>();
  private readonly busyEndpoints = new Set<string>();
  private readonly sent = new Map<string, string>();
  private readonly send: PushSender;
  private readonly closeTransport: () => void;
  private stopped = false;
  private disposeSubscription: (() => void) | undefined;
  constructor(private readonly deps: WebPushDependencies) {
    const transport = deps.sender === undefined ? createPushSender(deps.store, deps.baseUrl) : { send: deps.sender, dispose: () => undefined };
    this.send = transport.send; this.closeTransport = transport.dispose;
  }
  attach(hub: SessionEventHub, baseline: SessionUnreadCatalogSnapshot): void {
    this.catalogId = baseline.catalogId; this.revision = baseline.catalogRevision;
    // Synchronous baseline and subscription: no HTTP/WebSocket seeding race, no old backlog.
    this.disposeSubscription = hub.subscribeUnread((event) => { this.observe(event); });
  }
  observe(event: SessionUnreadEvent): void {
    if (this.stopped) return;
    if (event.catalogId !== this.catalogId) {
      this.cancelCompletions(); this.jobs.clear(); this.sent.clear();
      this.catalogId = event.catalogId; this.revision = 0;
    }
    if (event.catalogRevision <= this.revision) return;
    this.revision = event.catalogRevision;
    const identity = identityKey(event);
    const old = this.completions.get(identity);
    if (old !== undefined) clearTimeout(old.timer);
    this.completions.delete(identity);
    for (const [key, job] of this.jobs) if (job.event !== undefined && identityKey(job.event) === identity) this.jobs.delete(key);
    if (event.unread === null) return;
    const records = this.deps.store.snapshot().subscriptions;
    if (records.length === 0) return;
    const timer = setTimeout(() => {
      this.completions.delete(identity);
      void this.prepare(event, records).catch(() => { this.deps.report("chat-resolution-failed"); });
    }, 4000);
    if (typeof timer.unref === "function") timer.unref();
    this.completions.set(identity, { event, timer });
  }
  async test(endpoint: string): Promise<boolean> {
    const record = this.deps.store.snapshot().subscriptions.find((entry) => entry.subscription.endpoint === endpoint);
    if (record === undefined || this.stopped) throw new Error("Enable notifications before testing");
    // Bound tests too; one outstanding test per subscription.
    const key = JSON.stringify([endpoint, "test"]);
    if (this.jobs.has(key) || this.busyEndpoints.has(endpoint)) throw new Error("Push delivery is already pending");
    return new Promise((finish) => { this.jobs.set(key, { record, url: this.deps.baseUrl, finish }); this.pump(); });
  }
  dispose(): void {
    this.stopped = true;
    this.disposeSubscription?.(); this.cancelCompletions();
    for (const job of this.jobs.values()) job.finish?.(false);
    this.jobs.clear(); this.closeTransport();
  }
  private cancelCompletions(): void {
    for (const { timer } of this.completions.values()) clearTimeout(timer);
    this.completions.clear();
  }
  private current(event: SessionUnreadEvent): boolean {
    return !this.stopped && event.catalogId === this.catalogId && event.unread !== null && this.deps.isCurrent(event) && this.deps.mayNotify(event.unread);
  }
  private async prepare(event: SessionUnreadEvent, records: PushRecord[]): Promise<void> {
    if (!this.current(event) || event.unread === null) return;
    const target = await this.deps.resolveChat(event.unread);
    if (!this.current(event)) return;
    if (target === undefined) { this.deps.report("chat-target-missing-or-ambiguous"); return; }
    const url = new URL(this.deps.baseUrl);
    url.search = new URLSearchParams({ machine: "local", project: target.projectId, workspace: target.workspaceId, session: event.sessionId, view: "chat" }).toString();
    for (const record of records) {
      const key = JSON.stringify([record.subscription.endpoint, identityKey(event)]);
      if (this.deps.store.current(record)) this.jobs.set(key, { record, event, url: url.href });
    }
    this.pump();
  }
  private pump(): void {
    if (this.stopped) return;
    for (const [key, job] of this.jobs) {
      if (this.busyEndpoints.size >= 4) break;
      const endpoint = job.record.subscription.endpoint;
      if (this.busyEndpoints.has(endpoint)) continue;
      this.jobs.delete(key); this.busyEndpoints.add(endpoint);
      void this.deliver(job).then((accepted) => job.finish?.(accepted), () => { this.deps.report("push-delivery-failed"); job.finish?.(false); })
        .finally(() => { this.busyEndpoints.delete(endpoint); this.pump(); });
    }
  }
  private async deliver(job: PushJob): Promise<boolean> {
    const identity = job.event === undefined ? undefined : identityKey(job.event);
    const stamp = job.event === undefined ? undefined : JSON.stringify([job.record.generation, job.event.catalogId, job.event.unread?.completionOrder]);
    const sentKey = JSON.stringify([job.record.subscription.endpoint, identity]);
    const valid = () => !this.stopped && this.deps.store.current(job.record) && (job.event === undefined || (this.current(job.event) && this.sent.get(sentKey) !== stamp));
    const deadline = Date.now() + 10_000;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
      if (!valid()) return false;
      let result: PushDeliveryResult;
      try {
        result = await this.send(job.record, JSON.stringify({ title: "PI WEB", body: "A session update is ready.", url: job.url }), deadline - Date.now());
      } catch { result = { status: 0 }; }
      // Registration changes/read acknowledgements during any await are authoritative.
      if (!valid()) return false;
      if (result.status >= 200 && result.status < 300) {
        if (stamp !== undefined) this.sent.set(sentKey, stamp);
        // ponytail: bounded recent dedup, replace with per-record durable receipts if replay across restarts is required.
        if (this.sent.size > 20_000) {
          const oldest = this.sent.keys().next();
          if (oldest.done !== true) this.sent.delete(oldest.value);
        }
        return true;
      }
      if (result.status === 404 || result.status === 410) {
        await this.deps.store.unsubscribe(job.record.subscription.endpoint, job.record.generation);
        this.deps.report("push-subscription-expired"); return false;
      }
      if (result.status !== 0 && result.status !== 429 && result.status < 500) break;
      if (attempt === 2) break;
      const delay = retryDelay(result.retryAfter, attempt);
      if (Date.now() + delay >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    this.deps.report("push-provider-not-accepted"); return false;
  }
}
function identityKey(event: { cwd: string; sessionId: string }): string { return JSON.stringify([event.cwd, event.sessionId]); }
function retryDelay(value: string | undefined, attempt: number): number {
  const parsed = value === undefined ? NaN : /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Math.min(2000, Math.max(100, Number.isFinite(parsed) ? parsed : 250 * (attempt + 1)));
}
