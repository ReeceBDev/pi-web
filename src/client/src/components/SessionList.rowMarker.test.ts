// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "../api";
import { SessionList, rowColorsFromRaw, ROW_COLORS_STORAGE_KEY } from "./SessionList";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.useRealTimers();
});

describe("row color marker (rbowen row-marker)", () => {
  it("tap applies the dark red mark and persists it, second tap clears it", async () => {
    const list = await mount([session("s1")]);
    const marker = markerFor(list, "s1");

    marker.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    marker.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await list.updateComplete;

    expect(rowColor(list, "s1")).toBe("#5c1616");
    expect(rowColorsFromRaw(localStorage.getItem(ROW_COLORS_STORAGE_KEY))["s1"]).toBe("#5c1616");

    marker.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    marker.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    await list.updateComplete;

    expect(rowColor(list, "s1")).toBeUndefined();
    expect(rowColorsFromRaw(localStorage.getItem(ROW_COLORS_STORAGE_KEY))).toEqual({});
  });

  it("a 0.5s hold opens the palette, a swatch click sets that color and closes it", async () => {
    vi.useFakeTimers();
    const list = await mount([session("s1")]);
    const marker = markerFor(list, "s1");

    marker.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    vi.advanceTimersByTime(499);
    expect(list.shadowRoot?.querySelector(".color-menu-panel")).toBeNull();

    vi.advanceTimersByTime(1);
    await list.updateComplete;
    const panel = list.shadowRoot?.querySelector(".color-menu-panel");
    if (!panel) throw new Error("Hold did not open the color palette");
    const swatches = [...panel.querySelectorAll<HTMLButtonElement>(".color-swatch")];
    expect(swatches.length).toBe(7);

    // The completed hold must not also toggle dark red on pointerup.
    marker.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));

    const teal = swatches.find((swatch) => swatch.title === "Teal");
    if (!teal) throw new Error("Missing teal swatch");
    teal.click();
    await list.updateComplete;
    expect(rowColor(list, "s1")).toBe("#0f5257");
    expect(list.shadowRoot?.querySelector(".color-menu-panel")).toBeNull();
  });

  it("a quick tap never opens the palette", async () => {
    vi.useFakeTimers();
    const list = await mount([session("s1")]);
    const marker = markerFor(list, "s1");

    marker.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    marker.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    vi.advanceTimersByTime(1000);
    await list.updateComplete;
    expect(list.shadowRoot?.querySelector(".color-menu-panel")).toBeNull();
  });

  it("restores marks from localStorage on construction", async () => {
    localStorage.setItem("pi-web.sessionRowColors", JSON.stringify({ s1: "#1e4d2b" }));
    const list = await mount([session("s1")]);
    expect(rowColor(list, "s1")).toBe("#1e4d2b");
    expect(list.shadowRoot?.querySelector(".action-row.marker-colored")).not.toBeNull();
  });
});

async function mount(sessions: SessionInfo[]): Promise<SessionList> {
  const list = new SessionList();
  list.sessions = sessions;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function markerFor(list: SessionList, sessionId: string): HTMLButtonElement {
  const row = [...(list.shadowRoot?.querySelectorAll<HTMLElement>(".action-row") ?? [])].find((candidate) => candidate.title === `/sessions/${sessionId}.jsonl`);
  const marker = row?.querySelector<HTMLButtonElement>(".row-color-marker");
  if (!marker) throw new Error(`Missing row marker for ${sessionId}`);
  return marker;
}

function rowColor(list: SessionList, sessionId: string): string | undefined {
  return list.rowColorFor(sessionId);
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z",
    modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1,
    firstMessage: id,
    ...overrides,
  };
}
