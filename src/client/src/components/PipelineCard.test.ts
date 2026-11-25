// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineCard } from "./PipelineCard";
import type { PipelineDecisionCard } from "./shared";

/** A well-formed artifact digest as the wire contract carries it (64 hex). */
const SKETCH_SHA256 = "664ef46000aabbcc0011223344556677889900aabbccddeeff0011223344559";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The pipeline-card fetch of /api/pipeline-runs/artifact/<sha256> goes
 * through the global fetch; every test stubs it before mounting. */
const fetchMock = vi.fn<FetchLike>();

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockClear();
  document.body.replaceChildren();
});

async function mount(card?: PipelineDecisionCard, onDecide?: (decision: "approve" | "revise") => void | Promise<void>): Promise<PipelineCard> {
  const element = new PipelineCard();
  element.runId = "run-1";
  element.phase = "AWAITING_SKETCH_APPROVAL";
  if (card !== undefined) element.card = card;
  if (onDecide !== undefined) element.onDecide = onDecide;
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
}

/** One macrotask lets the artifact fetch promise settle, then one render
 * cycle lets the component apply the fetched bytes. */
async function settle(element: PipelineCard): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await element.updateComplete;
}

function rootOf(element: PipelineCard): ShadowRoot {
  const root = element.shadowRoot;
  if (!(root instanceof ShadowRoot)) throw new Error("shadow root missing");
  return root;
}

function button(root: ShadowRoot, selector: string): HTMLButtonElement {
  const element = root.querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`button missing: ${selector}`);
  return element;
}

describe("pipeline-card", () => {
  it("fetches the artifact bytes from the proxy route and renders them next to the open question", async () => {
    fetchMock.mockResolvedValue(new Response("{\"goal\":\"hello world\"}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const element = await mount({ questionId: "sketch-approval", artifactSha256: SKETCH_SHA256, revision: 1, stage: "sketches" });
    await settle(element);

    const root = rootOf(element);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`api/pipeline-runs/artifact/${SKETCH_SHA256}`);
    expect(root.querySelector(".q-label")?.textContent).toContain("sketch-approval");
    expect(root.querySelector(".artifact pre")?.textContent).toContain("hello world");
    expect(button(root, ".decide-approve")).toBeInstanceOf(HTMLButtonElement);
    expect(button(root, ".decide-revise")).toBeInstanceOf(HTMLButtonElement);
    expect(button(root, ".decide-approve").disabled).toBe(false);
  });

  it("shows the artifact as unavailable when the proxy answer is not ok", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const element = await mount({ questionId: "sketch-approval", artifactSha256: SKETCH_SHA256, revision: 1 });
    await settle(element);

    expect(rootOf(element).querySelector(".artifact-missing")?.textContent).toContain("(content unavailable)");
  });

  it("renders no artifact section and fetches nothing for a card without an artifact sha", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const element = await mount({ questionId: "module-approval", revision: 3, stage: "modules" });
    await settle(element);

    const root = rootOf(element);
    expect(root.querySelector(".artifact")).toBeNull();
    expect(root.querySelector(".artifact-missing")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls back with the pressed decision", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const onDecide = vi.fn();
    const element = await mount({ questionId: "sketch-approval", revision: 1 }, onDecide);
    const root = rootOf(element);
    button(root, ".decide-approve").click();
    await element.updateComplete;
    expect(onDecide).toHaveBeenCalledWith("approve");
  });

  it("disables the buttons once the question is decided", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const element = await mount({ questionId: "sketch-approval", artifactSha256: SKETCH_SHA256, revision: 1, decided: true });
    const root = rootOf(element);
    expect(root.querySelector(".decided")?.textContent).toContain("Decided");
    expect(root.querySelector(".decide-approve")).toBeNull();
  });

  it("shows the close status instead of buttons on a closed run", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const element = new PipelineCard();
    element.runId = "run-1";
    element.phase = "CLOSED";
    element.closeStatus = "COMPLETED";
    document.body.appendChild(element);
    await element.updateComplete;
    const root = rootOf(element);
    expect(root.querySelector(".phase")?.textContent).toContain("COMPLETED");
    expect(root.querySelector(".decide-approve")).toBeNull();
  });
});
