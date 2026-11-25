import { LitElement, css, html, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { resolveAppUrl } from "../appUrl";
import type { PendingPipelineDecision, PipelineApprovalBinding, PipelineRevisionFeedback } from "../../../shared/pipelineApproval";
import type { PipelineDecisionCard, PipelineDeliveryView } from "./shared";

export type PipelineDecideCallback = (decision: "approve" | "revise", runId: string, binding: PipelineApprovalBinding | undefined, feedback?: PipelineRevisionFeedback) => void | Promise<void>;

/**
 * The pipeline run's live decision card in the run's chat: current phase, the
 * open question's artifact, and Approve/Revise buttons. The artifact bytes are
 * fetched from /api/pipeline-runs/artifact/<sha256> (the byte proxy of the
 * pipeline's content-addressed store) when the card renders; transcript-
 * restored rows may instead carry the bytes inline. The buttons call back
 * into the session controller, which posts the decision — typing "approve" is
 * never required to drive a run.
 */
@customElement("pipeline-card")
export class PipelineCard extends LitElement {
  @property({ attribute: false }) runId = "";
  @property({ attribute: false }) phase = "";
  @property({ attribute: false }) closeStatus?: string;
  @property({ attribute: false }) detail?: string;
  @property({ attribute: false }) stale = false;
  @property({ attribute: false }) delivery?: PipelineDeliveryView;
  @property({ attribute: false }) retry?: PendingPipelineDecision;
  @property({ attribute: false }) card?: PipelineDecisionCard;
  @property({ attribute: false }) onDecide?: PipelineDecideCallback;

  @state() private submitting: "approve" | "revise" | undefined;
  @state() private error = "";
  @state() private artifact: { sha256: string; status: "loading" | "ready" | "unavailable"; text?: string } | undefined;

  @state() private editingRevision = false;
  @state() private reason = "";
  @state() private acceptanceRef = "";

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("card")) {
      // A status refresh of the SAME question must not wipe a draft revision
      // reason; only a genuinely different question (new id, revision, or
      // binding) starts a fresh draft.
      const previous = changed.get("card");
      const current = this.card;
      // undefined-safe: a first card (previous undefined) never counts as the
      // same question.
      const sameQuestion = previous?.questionId === current?.questionId
        && previous?.revision === current?.revision
        && JSON.stringify(previous?.binding) === JSON.stringify(current?.binding);
      if (!sameQuestion) {
        this.error = "";
        this.editingRevision = false;
        this.reason = "";
        this.acceptanceRef = "";
      }
      const sha256 = this.card?.artifactSha256;
      if (sha256 === undefined || this.card?.artifact !== undefined) this.artifact = undefined;
      else if (this.artifact?.sha256 !== sha256) void this.fetchArtifact(sha256);
    }
  }

  override render(): TemplateResult {
    const closed = this.phase === "CLOSED";
    return html`
      <article class="pipeline-card" data-testid="pipeline-card">
        <header class="card-head">
          <span class="phase" role="status" aria-live="polite">${closed ? `closed · ${this.closeStatus ?? "unknown"}` : `phase · ${this.phase}`}</span>
          <span class="run">${this.runId}</span>
        </header>
        ${this.detail !== undefined ? html`<p role="status">${this.detail}</p>` : null}
        ${this.stale ? html`<p role="status">Status could not refresh. Showing the last known state.</p>` : null}
        ${this.delivery ? html`
          <p>Build <code>${this.delivery.buildDigest}</code></p>
          ${this.delivery.report !== undefined ? html`<details class="artifact"><summary>Verification report</summary><pre>${this.delivery.report}</pre></details>`
            : html`<p>Verification report unavailable · ${this.delivery.reportDigest}</p>`}
          ${this.delivery.diff !== undefined ? html`<details class="artifact"><summary>Delivered changes</summary><pre>${this.delivery.diff}</pre></details>`
            : html`<p>Source diff unavailable for this build.</p>`}
        ` : null}
        ${this.retry ? this.renderRetry(this.retry) : null}
        ${this.renderBody()}
      </article>
    `;
  }

  private renderRetry(pending: PendingPipelineDecision): TemplateResult {
    return html`<button ?disabled=${this.submitting !== undefined}
      @click=${() => void this.decide(pending.decision, pending.binding, pending.feedback)}>Retry decision confirmation</button>`;
  }

  /** Approve/Revise wait for the artifact bytes: a decision is recorded only
   * for a question whose content the reviewer could actually read. Cards
   * without an artifact (and transcript rows with inline bytes) are ready. */
  private artifactReady(card: PipelineDecisionCard): boolean {
    if (card.artifact !== undefined) return true;
    if (card.artifactSha256 === undefined) return true;
    return this.artifact?.sha256 === card.artifactSha256 && this.artifact.status === "ready" && this.artifact.text !== undefined;
  }

  private renderBody(): TemplateResult {
    const card = this.card;
    if (card === undefined) return this.closeStatus !== undefined || this.detail !== undefined ? html`` : html`<p class="idle">No decision card open · the next one posts here</p>`;
    const disabled = card.historical === true || card.decided === true || card.decisionPending === true || this.submitting !== undefined || this.stale ||
      this.retry !== undefined || !this.artifactReady(card);
    return html`
      <div class="question">
        <span class="q-label">${card.stage ?? "decision"} · ${card.questionId}</span>
        <span class="q-rev">rev ${String(card.revision)}</span>
      </div>
      ${this.renderArtifact(card)}
      ${(card.reviewNotes ?? "") !== "" ? html`<details class="artifact" ?open=${card.stage === "modules"}><summary>${card.stage === "modules" ? "Revision review" : "Requirement and example IDs"}</summary><pre>${card.reviewNotes}</pre></details>` : null}
      ${card.decided === true || card.historical === true
        ? html`<p class="decided" role="status">${card.decided === true ? "Decided · recorded" : "Previous request"}</p>`
        : html`
          ${this.editingRevision ? html`<label>What needs to change?
            <textarea required maxlength="4000" .value=${this.reason} @input=${(e: Event) => { if (e.currentTarget instanceof HTMLTextAreaElement) this.reason = e.currentTarget.value; }}></textarea></label>
            <label>${card.stage === "modules" ? "Affected requirement, demo or interface ID (optional). To dispute a field, use interface/ID#/errorSemantics or demo/ID#/functionalExample/then." : "Affected goal, acceptance or example ID (optional)."}
              <input maxlength="240" .value=${this.acceptanceRef} @input=${(e: Event) => { if (e.currentTarget instanceof HTMLInputElement) this.acceptanceRef = e.currentTarget.value; }}></label>` : null}
          <div class="actions">
            <button class="decide-approve" ?disabled=${disabled} @click=${() => void this.decide("approve", card.binding)}>Approve</button>
            <button class="decide-revise" ?disabled=${disabled || (this.editingRevision && !this.reason.trim())}
              @click=${() => { if (!this.editingRevision) { this.editingRevision = true; return; }
                void this.decide("revise", card.binding, { reason: this.reason.trim(), ...(this.acceptanceRef.trim() ? { acceptanceRef: this.acceptanceRef.trim() } : {}) }); }}>
              ${this.editingRevision ? "Send revision" : "Revise"}</button>
            ${card.decisionPending === true || this.submitting !== undefined ? html`<span class="pending" role="status">Recording decision…</span>` : null}
          </div>
        `}
      ${this.error === "" ? null : html`<p class="error" role="alert">${this.error}</p>`}
    `;
  }

  private renderArtifact(card: PipelineDecisionCard): TemplateResult {
    if (card.artifact !== undefined) return html`<details class="artifact"><summary>artifact</summary><pre>${card.artifact}</pre></details>`;
    if (card.artifactSha256 === undefined) return html``;
    const artifact = this.artifact;
    if (artifact === undefined || artifact.status === "loading") return html`<p class="artifact-missing">loading artifact…</p>`;
    if (artifact.status === "unavailable" || artifact.text === undefined) {
      return html`<p class="artifact-missing">artifact ${card.artifactSha256.slice(0, 12)}… (content unavailable)</p>`;
    }
    return html`<details class="artifact"><summary>artifact</summary><pre>${artifact.text}</pre></details>`;
  }

  /** Fetch the card's artifact bytes from the byte proxy route; only the
   * fetch for the currently rendered sha256 may land. */
  private async fetchArtifact(sha256: string): Promise<void> {
    this.artifact = { sha256, status: "loading" };
    try {
      const response = await fetch(resolveAppUrl(`api/pipeline-runs/artifact/${encodeURIComponent(sha256)}`));
      if (!response.ok) throw new Error(`artifact fetch failed · ${String(response.status)}`);
      this.applyArtifact(sha256, { sha256, status: "ready", text: await response.text() });
    } catch {
      this.applyArtifact(sha256, { sha256, status: "unavailable" });
    }
  }

  /** Land a fetch result only when the card still shows this sha256 (a newer
   * card, or one without an artifact, replaces the in-flight request). */
  private applyArtifact(sha256: string, next: { sha256: string; status: "ready" | "unavailable"; text?: string }): void {
    const current = this.artifact;
    if (current?.sha256 !== sha256) return;
    this.artifact = next;
  }

  private async decide(decision: "approve" | "revise", binding?: PipelineApprovalBinding, feedback?: PipelineRevisionFeedback): Promise<void> {
    if (this.submitting !== undefined || this.card?.historical === true) return;
    this.submitting = decision;
    try {
      if (feedback) await this.onDecide?.(decision, this.runId, binding, feedback);
      else await this.onDecide?.(decision, this.runId, binding);
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
    label { display: grid; gap: 4px; }
    textarea, input { font: inherit; color: inherit; background: var(--pi-bg); border: 1px solid var(--pi-border); padding: 6px; }
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
