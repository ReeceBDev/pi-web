// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineCard } from "./PipelineCard";
import type { PipelineApprovalBinding } from "../../../shared/pipelineApproval";
import type { PipelineDecisionCard } from "./shared";

const execution = "01a1f777-e9fe-777d-b157-8cd6e797d35a";
const binding = {
  rootExecutionId: execution, targetExecutionId: execution, stage: "sketches" as const,
  questionId: "sketch-approval", revision: 1, artifactSha256: "a".repeat(64),
};

afterEach(() => {
  document.body.replaceChildren();
});

async function mount(card?: PipelineDecisionCard, onDecide?: (decision: "approve" | "revise", runId: string, binding: PipelineApprovalBinding) => void | Promise<void>): Promise<PipelineCard> {
  const element = new PipelineCard();
  element.runId = "run-1";
  element.phase = "AWAITING_SKETCH_APPROVAL";
  if (card !== undefined) element.card = card;
  if (onDecide !== undefined) element.onDecide = onDecide;
  document.body.appendChild(element);
  await element.updateComplete;
  return element;
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
  it("renders the open question with its artifact and both decision buttons", async () => {
    const element = await mount({ questionId: "sketch-approval", artifactSha256: binding.artifactSha256, binding, revision: 1, stage: "sketches", artifact: "{\"goal\":\"hello world\"}" });
    const root = rootOf(element);
    expect(root.querySelector(".q-label")?.textContent).toContain("sketch-approval");
    expect(root.querySelector(".artifact pre")?.textContent).toContain("hello world");
    expect(button(root, ".decide-approve")).toBeInstanceOf(HTMLButtonElement);
    expect(button(root, ".decide-revise")).toBeInstanceOf(HTMLButtonElement);
    expect(button(root, ".decide-approve").disabled).toBe(false);
  });

  it("calls back with the pressed decision", async () => {
    const onDecide = vi.fn();
    const element = await mount({ questionId: "sketch-approval", artifactSha256: binding.artifactSha256, binding, artifact: "goal", revision: 1 }, onDecide);
    const root = rootOf(element);
    button(root, ".decide-approve").click();
    await element.updateComplete;
    expect(onDecide).toHaveBeenCalledWith("approve", "run-1", binding);
  });

  it("disables the buttons once the question is decided", async () => {
    const element = await mount({ questionId: "sketch-approval", artifactSha256: "664ef460", revision: 1, decided: true });
    const root = rootOf(element);
    expect(root.querySelector(".decided")?.textContent).toContain("Decided");
    expect(root.querySelector(".decide-approve")).toBeNull();
  });

  it("shows the close status instead of buttons on a closed run", async () => {
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
