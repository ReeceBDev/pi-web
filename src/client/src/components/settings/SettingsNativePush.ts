import { css, html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { request } from "../../api/http";
import { resolveAppUrl } from "../../appUrl";

interface PushStatus { configured: boolean; publicKey?: string }
export function parseStatus(value: unknown): PushStatus {
  if (value === null || typeof value !== "object" || !("configured" in value) || typeof value.configured !== "boolean") throw new Error("Invalid push status");
  if (!value.configured) return { configured: false };
  if (!("publicKey" in value) || typeof value.publicKey !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(value.publicKey)) throw new Error("Invalid push status");
  return { configured: true, publicKey: value.publicKey };
}
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/") + "="), (character) => character.charCodeAt(0));
}
async function mutation(path: string, body: unknown): Promise<unknown> {
  return request(`api/web-push/${path}`, (value) => value, { method: "POST", body: JSON.stringify(body) });
}

@customElement("settings-native-push")
export class SettingsNativePush extends LitElement {
  @state() private busy = false;
  @state() private configured = false;
  @state() private enabled = false;
  @state() private message = "Loading notification status…";
  private subscription: PushSubscription | undefined;
  private get supported(): boolean { return window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }

  override connectedCallback(): void { super.connectedCallback(); void this.reload(); }
  override render() {
    return html`<section aria-label="Native push notifications">
      <h3>Android notifications</h3>
      <p>This browser receives generic updates from the local machine only, not remote fleet machines. An update means unread activity, not proven task success.</p>
      <button ?disabled=${this.busy || !this.configured || !this.supported} @click=${() => { void this.enable(); }}>Enable</button>
      <button ?disabled=${this.busy || !this.enabled} @click=${() => { void this.test(); }}>Test</button>
      <button ?disabled=${this.busy || this.subscription === undefined} @click=${() => { void this.disable(); }}>Disable</button>
      <button ?disabled=${this.busy} @click=${() => { void this.reload(); }}>Refresh status</button>
      <p role="status" aria-live="polite" aria-atomic="true">${this.message}</p>
    </section>`;
  }
  async reload(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.supported) { this.message = "Native push needs HTTPS and a browser with Web Push support."; return; }
      const status = await request("api/web-push/status", parseStatus);
      this.configured = status.configured;
      if (!status.configured) { this.message = "Native push is not configured on the local server."; return; }
      const registration = await navigator.serviceWorker.getRegistration(resolveAppUrl("./"));
      if (registration?.scope === resolveAppUrl("./") && registration.active?.scriptURL === resolveAppUrl("native-push-sw.js")) {
        this.subscription = await registration.pushManager.getSubscription() ?? undefined;
      }
      if (this.subscription !== undefined) {
        await mutation("subscription", this.subscription.toJSON());
        this.enabled = true; this.message = "Notifications enabled. Existing subscription registered again for server recovery.";
      } else {
        this.enabled = false;
        this.message = Notification.permission === "denied" ? "Notifications denied. Change this site's browser permission before enabling." : "Notifications disabled. Select Enable to request permission.";
      }
    } catch { this.enabled = false; this.message = "Cannot load or restore notifications. Select Refresh status to retry."; }
    finally { this.busy = false; }
  }
  async enable(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    // Invoke permission while the click gesture is still active, before any network await.
    const permission = Notification.permission === "granted" ? Promise.resolve("granted" as const) : Notification.requestPermission();
    try {
      const result = await permission;
      if (result !== "granted") { this.message = result === "denied" ? "Notifications denied. Change this site's browser permission before enabling." : "Permission request dismissed. Select Enable to try again."; return; }
      const status = await request("api/web-push/status", parseStatus);
      if (!status.configured || status.publicKey === undefined) throw new Error("Not configured");
      const registration = await navigator.serviceWorker.register(resolveAppUrl("native-push-sw.js"), { scope: resolveAppUrl("./"), updateViaCache: "none" });
      await activated(registration);
      this.subscription = await registration.pushManager.getSubscription() ?? undefined;
      if (this.subscription !== undefined) {
        const existing = this.subscription.options.applicationServerKey;
        if (existing !== null && new Uint8Array(existing).toString() !== keyBytes(status.publicKey).toString()) {
          this.message = "Server push key changed. Select Disable, then Enable to replace this subscription."; return;
        }
      }
      this.subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(status.publicKey) });
      await mutation("subscription", this.subscription.toJSON());
      this.enabled = true; this.message = "Notifications enabled for this browser and the local machine.";
    } catch { this.enabled = false; this.message = "Could not enable notifications. Check connectivity and browser permission, then select Enable to retry."; }
    finally { this.busy = false; }
  }
  async disable(): Promise<void> {
    if (this.busy || this.subscription === undefined) return;
    this.busy = true;
    try {
      // Server first: a failed request leaves a browser subscription available for retry.
      await mutation("unsubscribe", { endpoint: this.subscription.endpoint });
      await this.subscription.unsubscribe();
      this.subscription = undefined; this.enabled = false; this.message = "Notifications disabled; browser subscription and server registration removed.";
    } catch { this.message = "Could not finish disabling notifications. Select Disable to retry."; }
    finally { this.busy = false; }
  }
  async test(): Promise<void> {
    if (this.busy || this.subscription === undefined) return;
    this.busy = true;
    try {
      const result = await mutation("test", { endpoint: this.subscription.endpoint });
      const accepted = result !== null && typeof result === "object" && "accepted" in result && result.accepted === true;
      this.message = accepted ? "Push provider accepted the test. Display is not confirmed; check Android notifications and system settings." : "Push provider did not accept the test. Select Enable to restore registration, then retry Test.";
    } catch { this.message = "Test request failed. Select Enable to restore registration, then retry Test."; }
    finally { this.busy = false; }
  }
  static override styles = css`:host{display:block}section{padding:1rem;border:1px solid var(--border-color,#666);border-radius:.5rem}button{margin:.25rem;padding:.5rem}p{line-height:1.5}`;
}
async function activated(registration: ServiceWorkerRegistration): Promise<void> {
  if (registration.active !== null) return;
  const worker = registration.installing ?? registration.waiting;
  if (worker === null) throw new Error("Service worker missing");
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      clearTimeout(timer); worker.removeEventListener("statechange", done);
      if (worker.state === "activated") resolve(); else reject(new Error("Service worker activation failed"));
    };
    const timer = window.setTimeout(() => { worker.removeEventListener("statechange", done); reject(new Error("Service worker activation timeout")); }, 10_000);
    worker.addEventListener("statechange", done); done();
  });
}
