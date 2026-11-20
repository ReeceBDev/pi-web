import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { PipelineDecisionCard } from "./shared";

export type PipelineDecideCallback = (decision: "approve" | "revise") => void | Promise<void>;

/**
 * The pipeline run's live decision card in the run's chat: current phase, the
 * open question's artifact, and Approve/Revise buttons. The buttons call back
 * into the session controller, which posts the decision — typing "approve" is
 * never required to drive a run.
 */
@customElement("pipeline-card")
export class PipelineCard extends LitElement {
  @property({ attribute: false }) runId = "";
  @property({ attribute: false }) phase = "";
  @property({ attribute: false }) closeStatus?: string;
  @property({ attribute: false }) card?: PipelineDecisionCard;
  @property({ attribute: false }) onDecide?: PipelineDecideCallback;

  @state() private submitting: "approve" | "revise" | undefined;
  @state() private error = "";

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("card")) this.error = "";
  }

  override render(): TemplateResult {
    const closed = this.phase === "CLOSED";
    return html`
      <article class="pipeline-card" data-testid="pipeline-card">
        <header class="card-head">
          <span class="phase" role="status" aria-live="polite">${closed ? `closed · ${this.closeStatus ?? "unknown"}` : `phase · ${this.phase}`}</span>
          <span class="run">${this.runId}</span>
        </header>
        ${this.renderBody()}
      </article>
    `;
  }

  private renderBody(): TemplateResult {
    const card = this.card;
    if (card === undefined) return html`<p class="idle">No decision card open · the next one posts here</p>`;
    const disabled = card.decided === true || card.decisionPending === true || this.submitting !== undefined;
    return html`
      <div class="question">
        <span class="q-label">${card.stage ?? "decision"} · ${card.questionId}</span>
        <span class="q-rev">rev ${String(card.revision)}</span>
      </div>
      ${card.artifact === undefined
        ? html`<p class="artifact-missing">artifact ${card.artifactSha256.slice(0, 12)}… (content unavailable)</p>`
        : html`<details class="artifact"><summary>artifact</summary><pre>${card.artifact}</pre></details>`}
      ${card.decided === true
        ? html`<p class="decided" role="status">Decided · recorded</p>`
        : html`
          <div class="actions">
            <button class="decide-approve" ?disabled=${disabled} @click=${() => void this.decide("approve")}>Approve</button>
            <button class="decide-revise" ?disabled=${disabled} @click=${() => void this.decide("revise")}>Revise</button>
            ${card.decisionPending === true || this.submitting !== undefined ? html`<span class="pending" role="status">Recording decision…</span>` : null}
          </div>
        `}
      ${this.error === "" ? null : html`<p class="error" role="alert">${this.error}</p>`}
    `;
  }

  private async decide(decision: "approve" | "revise"): Promise<void> {
    if (this.submitting !== undefined) return;
    this.submitting = decision;
    try {
      await this.onDecide?.(decision);
    } catch {
      this.error = "Decision failed · press the button again";
    } finally {
      this.submitting = undefined;
    }
  }

  static override readonly styles = css`
    :host { display: block; }
    .pipeline-card { border: 1px solid var(--pi-border); border-radius: 8px; background: var(--pi-surface); padding: 10px 12px; display: grid; gap: 8px; }
    .card-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
    .phase { font-weight: 600; }
    .run { color: var(--pi-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .idle { margin: 0; color: var(--pi-muted); }
    .question { display: flex; justify-content: space-between; gap: 8px; }
    .q-label { font-weight: 600; }
    .q-rev { color: var(--pi-muted); font-size: 12px; }
    .artifact summary { cursor: pointer; color: var(--pi-muted); }
    .artifact pre { margin: 6px 0 0; max-height: 260px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--pi-bg); border: 1px solid var(--pi-border-muted); border-radius: 6px; padding: 8px; font-size: 12px; }
    .artifact-missing { margin: 0; color: var(--pi-muted); font-size: 12px; }
    .actions { display: flex; gap: 8px; align-items: center; }
    .actions button { font: inherit; padding: 4px 14px; border-radius: 6px; border: 1px solid var(--pi-border); background: var(--pi-bg); color: var(--pi-text); cursor: pointer; }
    .actions button:hover:not(:disabled) { background: var(--pi-surface-hover); }
    .actions button:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .actions button:disabled { opacity: .5; cursor: default; }
    .decide-approve:not(:disabled) { border-color: var(--pi-accent); }
    .pending { color: var(--pi-muted); font-size: 12px; }
    .decided { margin: 0; color: var(--pi-muted); }
    .error { margin: 0; color: var(--pi-danger, #c0392b); font-size: 12px; }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "pipeline-card": PipelineCard;
  }
}
