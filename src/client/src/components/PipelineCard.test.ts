// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineCard } from "./PipelineCard";
import type { PipelineApprovalBinding } from "../../../shared/pipelineApproval";
import type { PipelineDecisionCard } from "./shared";

const execution = "01a1f777-e9fe-777d-b157-8cd6e797d35a";
const binding: PipelineApprovalBinding = {
  rootExecutionId: execution, targetExecutionId: execution, stage: "sketches",
  questionId: "sketch-approval", revision: 1, artifactSha256: "a".repeat(64),
};

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

async function mount(card?: PipelineDecisionCard, onDecide?: (decision: "approve" | "revise", runId: string, binding: PipelineApprovalBinding | undefined) => void | Promise<void>): Promise<PipelineCard> {
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
  it("renders the open question with its inline artifact and both decision buttons", async () => {
    vi.stubGlobal("fetch", fetchMock);
    // Transcript-restored rows carry the artifact bytes inline: ready to decide.
    const element = await mount({ questionId: "sketch-approval", artifactSha256: binding.artifactSha256, binding, revision: 1, stage: "sketches", artifact: "{\"goal\":\"hello world\"}" });
    const root = rootOf(element);
    expect(root.querySelector(".q-label")?.textContent).toContain("sketch-approval");
    expect(root.querySelector(".artifact pre")?.textContent).toContain("hello world");
    expect(button(root, ".decide-approve")).toBeInstanceOf(HTMLButtonElement);
    expect(button(root, ".decide-revise")).toBeInstanceOf(HTMLButtonElement);
    expect(button(root, ".decide-approve").disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
    // The buttons wait for the bytes: a decision is recorded only for a
    // question the reviewer could actually read.
    expect(button(root, ".decide-approve").disabled).toBe(false);
  });

  it("shows the artifact as unavailable when the proxy answer is not ok", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const element = await mount({ questionId: "sketch-approval", artifactSha256: SKETCH_SHA256, revision: 1 });
    await settle(element);

    expect(rootOf(element).querySelector(".artifact-missing")?.textContent).toContain("(content unavailable)");
    expect(button(rootOf(element), ".decide-approve").disabled).toBe(true);
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

  it("calls back with the pressed decision, the run id, and the binding", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const onDecide = vi.fn();
    const element = await mount({ questionId: "sketch-approval", artifactSha256: binding.artifactSha256, binding, artifact: "goal", revision: 1 }, onDecide);
    const root = rootOf(element);
    button(root, ".decide-approve").click();
    await element.updateComplete;
    expect(onDecide).toHaveBeenCalledWith("approve", "run-1", binding);
  });

  it("keeps a revision draft across status refreshes and submits the reviewed binding", async () => {
    vi.stubGlobal("fetch", fetchMock);
    const onDecide = vi.fn();
    const moduleBinding = { ...binding, stage: "modules" as const };
    const card = { questionId: "module-review", artifactSha256: binding.artifactSha256, binding: moduleBinding, artifact: "plan", reviewNotes: "Outstanding objection: compare the previous field and the proposed value.", stage: "modules" as const, revision: 1 };
    const element = await mount(card, onDecide);
    const root = rootOf(element);
    button(root, ".decide-revise").click();
    await element.updateComplete;
    const reason = root.querySelector("textarea");
    if (!(reason instanceof HTMLTextAreaElement)) throw new Error("revision reason field missing");
    reason.value = "Preserve the fourth approved example.";
    reason.dispatchEvent(new Event("input"));
    const reference = root.querySelector("input");
    if (!(reference instanceof HTMLInputElement)) throw new Error("revision reference field missing");
    expect(root.querySelector("details[open]")?.textContent).toContain("Outstanding objection");
    reference.value = "interface/provider#/errorSemantics";
    reference.dispatchEvent(new Event("input"));
    element.card = { ...card };
    await element.updateComplete;
    button(root, ".decide-revise").click();
    await element.updateComplete;
    expect(onDecide).toHaveBeenCalledWith("revise", "run-1", moduleBinding, { reason: reason.value, acceptanceRef: "interface/provider#/errorSemantics" });
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
