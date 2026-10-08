// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import "./SettingsNativePush";
import { SettingsNativePush, parseStatus } from "./SettingsNativePush";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

async function mounted(): Promise<SettingsNativePush> {
  const element = new SettingsNativePush();
  document.body.append(element);
  await element.updateComplete;
  await Promise.resolve();
  await element.updateComplete;
  return element;
}

function statusText(element: SettingsNativePush): string {
  const region = element.shadowRoot?.querySelector<HTMLParagraphElement>("p[role=\"status\"]");
  expect(region).not.toBeNull();
  return region?.textContent ?? "";
}

function button(element: SettingsNativePush, label: string): HTMLButtonElement | null {
  const buttons = [...(element.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  return buttons.find((candidate) => candidate.textContent.trim() === label) ?? null;
}

describe("SettingsNativePush visible status", () => {
  it("shows a visible unsupported-state message with disabled actions when Web Push is missing", async () => {
    const element = await mounted();
    expect(statusText(element)).toBe("Native push needs HTTPS and a browser with Web Push support.");
    expect(button(element, "Enable")?.disabled).toBe(true);
    expect(button(element, "Test")?.disabled).toBe(true);
    expect(button(element, "Disable")?.disabled).toBe(true);
    expect(button(element, "Refresh status")?.disabled).toBe(false);
  });

  it("reports load failure in the visible polite live region, never console-only", async () => {
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "serviceWorker", { value: { getRegistration: () => Promise.resolve(undefined) }, configurable: true });
    Object.defineProperty(window, "PushManager", { value: {}, configurable: true });
    const notificationStub: { permission: NotificationPermission; requestPermission: () => Promise<NotificationPermission> } = {
      permission: "default",
      requestPermission: () => Promise.resolve<NotificationPermission>("granted"),
    };
    Object.defineProperty(window, "Notification", { value: notificationStub, configurable: true });
    const fetchMock = vi.fn(() => Promise.reject(new Error("down")));
    vi.stubGlobal("fetch", fetchMock);

    const element = await mounted();
    expect(fetchMock).toHaveBeenCalled();
    expect(statusText(element)).toBe("Cannot load or restore notifications. Select Refresh status to retry.");
    expect(element.shadowRoot?.querySelector("p[role=\"status\"]")?.getAttribute("aria-live")).toBe("polite");
  });

  it("validates the status payload shape for the visible configuration state", () => {
    expect(parseStatus({ configured: true, publicKey: "A".repeat(87) })).toEqual({ configured: true, publicKey: "A".repeat(87) });
    expect(parseStatus({ configured: false })).toEqual({ configured: false });
    expect(() => parseStatus({ configured: true, publicKey: "short" })).toThrow();
    expect(() => parseStatus({ configured: true })).toThrow();
    expect(() => parseStatus(null)).toThrow();
  });
});
