// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  frames.clear();
  vi.unstubAllGlobals();
});

function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, height: bottom - top, width: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => "" };
}

async function mountedView(sessionId: string) {
  const view = new ChatView();
  view.sessionId = sessionId;
  view.messages = [
    { role: "user", parts: [{ type: "text", text: "one" }] },
    { role: "assistant", parts: [{ type: "text", text: "two" }] },
  ];
  document.body.append(view);
  await view.updateComplete;
  flushFrame();
  await view.updateComplete;
  const scroller = view.renderRoot.querySelector<HTMLDivElement>(".chat");
  if (scroller === null) throw new Error("Expected chat scroller");
  // happy-dom does no layout; stub geometry so the transcript is taller than the viewport.
  Object.defineProperties(scroller, { clientHeight: { value: 300 }, scrollHeight: { value: 6000 } });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(rect(0, 300));
  return { view, scroller };
}

// Anchor nodes are re-created on session switch, so stub their geometry only
// after the switch has rendered, then run the scheduled restore frame.
async function switchSession(view: ChatView, sessionId: string, lastAnchorTop?: number) {
  view.sessionId = sessionId;
  await view.updateComplete;
  if (lastAnchorTop !== undefined) {
    const anchors = view.renderRoot.querySelectorAll<HTMLElement>("[data-scroll-anchor-id]");
    const last = anchors[anchors.length - 1];
    if (last === undefined) throw new Error("Expected scroll anchors");
    vi.spyOn(last, "getBoundingClientRect").mockReturnValue(rect(lastAnchorTop, lastAnchorTop + 400));
  }
  flushFrame();
  await view.updateComplete;
}

function liveStatus(sessionId: string, pendingMessageCount = 0) {
  return {
    sessionId, isStreaming: pendingMessageCount === 0, isCompacting: false, isBashRunning: false,
    pendingMessageCount, queuedMessages: [], cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe("ChatView task-entry scroll (rbowen)", () => {
  it("tab into an idle task puts the newest message at the top of the screen, unpinned", async () => {
    const { view, scroller } = await mountedView("idle-a");
    await switchSession(view, "idle-b", 5600);
    expect(scroller.scrollTop).toBe(5600);
    expect(view.renderRoot.querySelector(".jump-to-bottom")).not.toBeNull();
  });

  it("tab into a live task pins to the bottom and follows", async () => {
    const { view, scroller } = await mountedView("live-a");
    view.status = liveStatus("live-b");
    await switchSession(view, "live-b");
    expect(scroller.scrollTop).toBe(6000);
    expect(view.renderRoot.querySelector(".jump-to-bottom")).toBeNull();
  });

  it("queued prompts count as live: the task pins to the bottom", async () => {
    const { view, scroller } = await mountedView("queued-a");
    view.status = liveStatus("queued-b", 1);
    await switchSession(view, "queued-b");
    expect(scroller.scrollTop).toBe(6000);
    expect(view.renderRoot.querySelector(".jump-to-bottom")).toBeNull();
  });
});
