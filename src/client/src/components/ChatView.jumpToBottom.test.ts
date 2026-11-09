// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatView } from "./ChatView";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountedView() {
  const view = new ChatView();
  view.sessionId = "jump";
  view.messages = [
    { role: "user", parts: [{ type: "text", text: "one" }] },
    { role: "assistant", parts: [{ type: "text", text: "two" }] },
  ];
  document.body.append(view);
  await view.updateComplete;
  const scroller = view.renderRoot.querySelector<HTMLDivElement>(".chat");
  if (scroller === null) throw new Error("Expected chat scroller");
  // happy-dom does no layout; stub geometry so the transcript is taller than the viewport.
  Object.defineProperties(scroller, { clientHeight: { value: 300 }, scrollHeight: { value: 6000 } });
  return { view, scroller };
}

describe("ChatView scroll-to-bottom button", () => {
  it("is hidden while pinned to the bottom, shown after scrolling away, hidden again at the bottom", async () => {
    const { view, scroller } = await mountedView();
    expect(view.renderRoot.querySelector(".jump-to-bottom")).toBeNull();
    scroller.dispatchEvent(new Event("scroll"));
    await view.updateComplete;
    expect(view.renderRoot.querySelector(".jump-to-bottom")).not.toBeNull();
    scroller.scrollTop = 5700;
    scroller.dispatchEvent(new Event("scroll"));
    await view.updateComplete;
    expect(view.renderRoot.querySelector(".jump-to-bottom")).toBeNull();
  });

  it("click scrolls to the bottom and re-pins (button disappears)", async () => {
    const { view, scroller } = await mountedView();
    scroller.dispatchEvent(new Event("scroll"));
    await view.updateComplete;
    // Run the scheduled frame synchronously, like a real rAF tick would.
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
    const button = view.renderRoot.querySelector<HTMLButtonElement>(".jump-to-bottom");
    if (button === null) throw new Error("Expected jump-to-bottom button");
    button.click();
    await view.updateComplete;
    expect(view.renderRoot.querySelector(".jump-to-bottom")).toBeNull();
    expect(scroller.scrollTop).toBe(6000);
  });
});
