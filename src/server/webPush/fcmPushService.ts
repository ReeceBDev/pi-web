import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionUnreadCatalogSnapshot, SessionUnreadEvent, SessionUnreadSummary } from "../../shared/apiTypes.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";
import type { FcmPushStore } from "./fcmPushStore.js";

export interface FcmDeliveryResult { ok: boolean; status: number; bodyText?: string }
export type FcmSender = (token: string, data: Record<string, string>) => Promise<FcmDeliveryResult>;

export const DEFAULT_FCM_SERVICE_ACCOUNT_PATH = join(homedir(), ".secrets", "box-push-firebase-svc.json");
const OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function isFirebaseServiceAccount(value: unknown): value is FcmServiceAccount {
  return isRecord(value) && typeof value["project_id"] === "string" && typeof value["client_email"] === "string" && typeof value["private_key"] === "string";
}

function isOAuthGrant(value: unknown): value is { access_token: string; expires_in: number } {
  return isRecord(value) && typeof value["access_token"] === "string" && typeof value["expires_in"] === "number";
}

function b64url(value: string): string { return Buffer.from(value).toString("base64url"); }

interface FcmServiceAccount { project_id: string; client_email: string; private_key: string }

export interface FcmTransport { send: FcmSender; probe: () => Promise<boolean>; dispose: () => void }

/** FCM v1 data-message transport: RS256 service-account JWT, cached OAuth grant, plain HTTPS send. */
export function createFcmSender(serviceAccountPath = DEFAULT_FCM_SERVICE_ACCOUNT_PATH): FcmTransport {
  let account: FcmServiceAccount | undefined;
  let access: { token: string; exp: number } | undefined;
  const loadAccount = async (): Promise<FcmServiceAccount> => {
    if (account !== undefined) return account;
    const parsed: unknown = JSON.parse(await readFile(serviceAccountPath, "utf8"));
    if (!isFirebaseServiceAccount(parsed)) throw new Error("Firebase service account lacks project_id/client_email/private_key");
    account = { project_id: parsed.project_id, client_email: parsed.client_email, private_key: parsed.private_key };
    return account;
  };
  const accessToken = async (): Promise<string> => {
    if (access !== undefined && Date.now() < access.exp) return access.token;
    const service = await loadAccount();
    const issuedAt = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claim = b64url(JSON.stringify({ iss: service.client_email, scope: FCM_SCOPE, aud: OAUTH_TOKEN_ENDPOINT, iat: issuedAt, exp: issuedAt + 3600 }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claim}`);
    const assertion = `${header}.${claim}.${Buffer.from(signer.sign(service.private_key.replace(/\\n/g, "\n"))).toString("base64url")}`;
    const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`OAuth token exchange failed: HTTP ${String(response.status)}`);
    const body: unknown = await response.json();
    if (!isOAuthGrant(body)) throw new Error("OAuth token exchange returned an unusable response");
    access = { token: body.access_token, exp: Date.now() + (body.expires_in - 60) * 1000 };
    return access.token;
  };
  const send: FcmSender = async (token, data) => {
    const service = await loadAccount();
    const bearer = await accessToken();
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${service.project_id}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token, data, android: { priority: "HIGH", collapse_key: data["conversationId"] } } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, status: response.status, bodyText: (await response.text()).slice(0, 500) };
    return { ok: true, status: response.status };
  };
  return {
    send,
    probe: () => loadAccount().then(() => true, () => false),
    dispose: () => undefined,
  };
}

export interface FcmPushDependencies {
  store: FcmPushStore;
  baseUrl: string;
  isCurrent: (event: SessionUnreadEvent) => boolean;
  mayNotify: (summary: SessionUnreadSummary) => boolean;
  report: (reason: string) => void;
  sender?: FcmSender;
}

function identityKey(event: { cwd: string; sessionId: string }): string { return JSON.stringify([event.cwd, event.sessionId]); }

/**
 * Unread completion delivery over FCM data messages, consumed by the box-launcher Android app.
 * Mirrors WebPushService decision timing (4 s watching window, currency re-check, baseline guard);
 * no send-level dedupe: collapse_key = sessionId collapses repeats on device.
 */
export class FcmPushService {
  private catalogId = "";
  private revision = 0;
  private readonly pending = new Map<string, { event: SessionUnreadEvent; timer: ReturnType<typeof setTimeout> }>();
  private readonly sending = new Set<string>();
  private readonly transport: FcmTransport;
  private stopped = false;
  private disposeSubscription: (() => void) | undefined;

  constructor(private readonly deps: FcmPushDependencies) {
    this.transport = deps.sender === undefined ? createFcmSender() : { send: deps.sender, probe: () => Promise.resolve(true), dispose: () => undefined };
  }

  attach(hub: SessionEventHub, baseline: SessionUnreadCatalogSnapshot): void {
    this.catalogId = baseline.catalogId; this.revision = baseline.catalogRevision;
    this.disposeSubscription = hub.subscribeUnread((event) => { this.observe(event); });
  }

  observe(event: SessionUnreadEvent): void {
    if (this.stopped) return;
    if (event.catalogId !== this.catalogId) {
      this.cancelPending(); this.sending.clear();
      this.catalogId = event.catalogId; this.revision = 0;
    }
    if (event.catalogRevision <= this.revision) return;
    this.revision = event.catalogRevision;
    const identity = identityKey(event);
    const existing = this.pending.get(identity);
    if (existing !== undefined) clearTimeout(existing.timer);
    this.pending.delete(identity);
    if (event.unread === null) return;
    const timer = setTimeout(() => {
      this.pending.delete(identity);
      void this.deliver(event).catch(() => { this.deps.report("fcm-delivery-failed"); });
    }, 4000);
    if (typeof timer.unref === "function") timer.unref();
    this.pending.set(identity, { event, timer });
  }

  async health(): Promise<{ ok: boolean; tokens: number; serviceAccountConfigured: boolean }> {
    return {
      ok: !this.stopped,
      tokens: this.deps.store.snapshot().tokens.length,
      serviceAccountConfigured: await this.transport.probe(),
    };
  }

  dispose(): void {
    this.stopped = true;
    this.disposeSubscription?.(); this.cancelPending();
    this.transport.dispose();
  }

  private cancelPending(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private current(event: SessionUnreadEvent): boolean {
    return !this.stopped && event.catalogId === this.catalogId && event.unread !== null
      && this.deps.isCurrent(event) && this.deps.mayNotify(event.unread);
  }

  private async deliver(event: SessionUnreadEvent): Promise<void> {
    if (!this.current(event) || event.unread === null) return;
    const tokens = this.deps.store.snapshot().tokens;
    if (tokens.length === 0) return;
    // Payload: constants, identifiers, the session title and the completion
    // timestamp (owner-requested 2026-11-09: launcher shows the session name
    // and an hh:mm completion stamp instead of the cwd basename). The 4 KB
    // FCM data-message cap bounds the title at SESSION_UNREAD_TITLE_MAX_LENGTH.
    const segments = event.cwd.split(/[\\/]/).filter(Boolean);
    const url = new URL(this.deps.baseUrl);
    // cwd rides along so the client can prefetch the transcript before the
    // catalog chain resolves the session's workspace (push-tap fast path).
    url.search = new URLSearchParams({ session: event.sessionId, cwd: event.cwd, view: "chat" }).toString();
    const data: Record<string, string> = {
      conversationId: event.sessionId,
      title: "Task finished",
      body: segments[segments.length - 1] ?? event.sessionId,
      completedAt: event.unread.completedAt,
      url: url.href,
    };
    if (event.unread.title !== undefined) data["sessionTitle"] = event.unread.title;
    const identity = identityKey(event);
    if (this.sending.has(identity)) return;
    this.sending.add(identity);
    try {
      const dead: string[] = [];
      for (const token of tokens) {
        if (!this.current(event)) return; // superseded mid-send; remaining tokens stay for the next event
        let result: FcmDeliveryResult;
        try { result = await this.transport.send(token, data); } catch { result = { ok: false, status: 0 }; }
        if (!this.current(event)) return;
        if (result.ok) { void this.deps.store.pushDiag("push_sent", { sessionId: event.sessionId }); continue; }
        if (result.status === 404 || result.status === 410 || (result.bodyText ?? "").includes("UNREGISTERED")) dead.push(token);
        else this.deps.report(`fcm-send-rejected-${String(result.status)}`);
      }
      if (dead.length > 0) await this.deps.store.prune(dead);
    } finally {
      this.sending.delete(identity);
    }
  }
}
