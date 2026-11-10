import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import type { Machine, MachineHealth, Project, SessionActivity, SessionInfo, SessionStatus } from "../../api";
import type { MachineStatusSnapshot } from "../../../../shared/machineStatus";
import { selectedMachineId } from "../../controllers/types";
import type { NavigationSection } from "../../appShell/navigationState";
import { NAVIGATION_SECTION_ORDER } from "../../appShell/navigationState";
import type { KeyboardNavigableSection } from "../navigationFocus";
import "../MachineList";
import "../ProjectList";
import "../SessionList";

export type NavigationFocusTarget = NavigationSection | "chat";

@customElement("app-navigation-panel")
export class AppNavigationPanel extends LitElement {
  @property({ attribute: false }) machines: Machine[] = [];
  @property({ attribute: false }) selectedMachine?: Machine;
  @property({ attribute: false }) machineStatuses: Record<string, MachineHealth> = {};
  @property({ attribute: false }) machineStatusSnapshots: Record<string, MachineStatusSnapshot> = {};
  @property({ attribute: false }) projects: Project[] = [];
  @property({ attribute: false }) selectedProject?: Project;
  @property({ attribute: false }) sessions: SessionInfo[] = [];
  @property({ attribute: false }) selectedSession?: SessionInfo;
  @property({ attribute: false }) sessionActivities: Record<string, SessionActivity> = {};
  @property({ attribute: false }) sessionStatuses: Record<string, SessionStatus> = {};
  @property({ attribute: false }) sendingPrompts: Record<string, true> = {};
  @property({ attribute: false }) unreadSessionIds: ReadonlySet<string> = new Set();
  @property({ type: Boolean, reflect: true }) collapsible = false;
  @property({ type: Boolean, reflect: true }) compact = false;
  @property({ type: Boolean }) machinesCollapsed = false;
  @property({ type: Boolean }) projectsCollapsed = false;
  @property({ type: Boolean }) sessionsCollapsed = false;
  @property({ type: Number }) startingSessionCount = 0;
  @property({ type: Boolean }) canStartSession = false;
  // rbowen (wstoggle): Projects/Sessions split, persisted in localStorage.
  @property({ attribute: false }) projectsHidden = false;
  @property({ attribute: false }) projectsFlex = 50;
  @property({ attribute: false }) onToggleMachines?: () => void;
  @property({ attribute: false }) onToggleProjects?: () => void;
  @property({ attribute: false }) onToggleSessions?: () => void;
  @property({ attribute: false }) onSelectProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onCloseProject?: (project: Project) => void | Promise<void>;
  @property({ attribute: false }) onStartSession?: () => void | Promise<void>;
  @property({ attribute: false }) onStartPlain?: () => void | Promise<void>;
  @property({ attribute: false }) unitMenuCwd?: string | undefined;
  @property({ attribute: false }) onSessionMenuOpen?: (session: SessionInfo) => void;
  @property({ attribute: false }) onStartSessionAt?: (path: string) => void;
  @property({ attribute: false }) onAddWorktree?: (session: SessionInfo) => void;
  @property({ attribute: false }) onSelectSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSessionWithDescendants?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onArchiveSessions?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onRestoreSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteCachedNewSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onDeleteArchivedSessions?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onDetachParentSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onMarkSessionRead?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onMarkSessionsRead?: (sessions: SessionInfo[]) => void | Promise<void>;
  @property({ attribute: false }) onReloadSession?: (session: SessionInfo) => void | Promise<void>;
  @property({ attribute: false }) onCleanupSessions?: () => void | Promise<void>;
  @property({ attribute: false }) onArchivedCollapsed?: () => void | Promise<void>;
  @property({ attribute: false }) onSelectMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onRemoveMachine?: (machine: Machine) => void | Promise<void>;
  @property({ attribute: false }) onFocusNavigationTarget?: (target: NavigationFocusTarget) => void | Promise<void>;
  @property({ attribute: false }) onCancelKeyboardNavigation?: () => void | Promise<void>;

  @query("machine-list") private machineList?: KeyboardNavigableSection;
  @query("project-list") private projectList?: KeyboardNavigableSection;
  @query("session-list") private sessionList?: KeyboardNavigableSection;

  constructor() {
    super();
    // rbowen: projectsHidden is owned by PiWebApp (the toggle lives in the
    // workspace/main tab bars now) and arrives as a plain property.
    const flex = Number(localStorage.getItem("pi-web.projectsFlex"));
    this.projectsFlex = flex >= 5 && flex <= 95 ? flex : 50;
  }

  async focusSection(section: NavigationSection): Promise<boolean> {
    await this.updateComplete;
    switch (section) {
      case "machines": return await this.focusNavigableSection(this.machineList);
      case "projects": return await this.focusNavigableSection(this.projectList);
      case "workspaces": return false;
      case "sessions": return await this.focusNavigableSection(this.sessionList);
    }
  }

  // Stable child inputs delegate at invocation time, never capturing old props.
  private readonly childCallbacks = {
    toggleProjects: () => { this.onToggleProjects?.(); },
    selectProject: (project: Project) => this.onSelectProject?.(project),
    closeProject: (project: Project) => this.onCloseProject?.(project),
    toggleSessions: () => { this.onToggleSessions?.(); },
    archivedCollapsed: () => this.onArchivedCollapsed?.(),
    startSession: () => this.onStartSession?.(),
    startSessionPlain: () => this.onStartPlain?.(),
    sessionMenuOpen: (session: SessionInfo) => this.onSessionMenuOpen?.(session),
    startSessionAt: (path: string) => this.onStartSessionAt?.(path),
    addWorktree: (session: SessionInfo) => this.onAddWorktree?.(session),
    selectSession: (session: SessionInfo) => this.onSelectSession?.(session),
    archiveSession: (session: SessionInfo) => this.onArchiveSession?.(session),
    archiveSessionWithDescendants: (session: SessionInfo) => this.onArchiveSessionWithDescendants?.(session),
    archiveSessions: (sessions: SessionInfo[]) => this.onArchiveSessions?.(sessions),
    restoreSession: (session: SessionInfo) => this.onRestoreSession?.(session),
    deleteCachedNewSession: (session: SessionInfo) => this.onDeleteCachedNewSession?.(session),
    deleteArchivedSession: (session: SessionInfo) => this.onDeleteArchivedSession?.(session),
    deleteArchivedSessions: (sessions: SessionInfo[]) => this.onDeleteArchivedSessions?.(sessions),
    detachParentSession: (session: SessionInfo) => this.onDetachParentSession?.(session),
    markSessionRead: (session: SessionInfo) => this.onMarkSessionRead?.(session),
    markSessionsRead: (sessions: SessionInfo[]) => this.onMarkSessionsRead?.(sessions),
    reloadSession: (session: SessionInfo) => this.onReloadSession?.(session),
    cleanupSessions: () => this.onCleanupSessions?.(),
    previousFromProjects: () => { this.focusPreviousFrom("projects"); },
    nextFromProjects: () => { this.focusNextFrom("projects"); },
    previousFromSessions: () => { this.focusPreviousFrom("sessions"); },
    nextFromSessions: () => { this.focusNextFrom("sessions"); },
    cancelKeyboardNavigation: () => { this.cancelKeyboardNavigation(); },
  };

  override render() {
    return html`
      ${this.compact && shouldShowMachinesSection(this.machines) ? html`
        <machine-list
          .machines=${this.machines}
          .selected=${this.selectedMachine}
          .statuses=${this.machineStatuses}
          .statusSnapshots=${this.machineStatusSnapshots}
          .collapsible=${this.collapsible}
          .collapsed=${this.machinesCollapsed}
          .onToggleCollapsed=${() => { this.onToggleMachines?.(); }}
          .onSelect=${(machine: Machine) => this.onSelectMachine?.(machine)}
          .onRemove=${(machine: Machine) => this.onRemoveMachine?.(machine)}
          .onFocusNextSection=${() => { this.focusNextFrom("machines"); }}
          .onCancelKeyboardNavigation=${() => { this.cancelKeyboardNavigation(); }}
        ></machine-list>
      ` : null}
      <project-list
        ?hidden=${this.projectsHidden && !this.compact}
        style=${`flex-grow:${String(this.projectsFlex)}`}
        .projects=${this.projects}
        .selected=${this.selectedProject}
        .statusSnapshot=${this.selectedMachineStatusSnapshot()}
        .collapsible=${false}
        .collapsed=${false}
        .onToggleCollapsed=${this.childCallbacks.toggleProjects}
        .onSelect=${this.childCallbacks.selectProject}
        .onClose=${this.childCallbacks.closeProject}
        .onFocusPreviousSection=${this.childCallbacks.previousFromProjects}
        .onFocusNextSection=${this.childCallbacks.nextFromProjects}
        .onCancelKeyboardNavigation=${this.childCallbacks.cancelKeyboardNavigation}
      ></project-list>
      <div class="section-resizer" title="Drag to resize Projects vs Sessions" @pointerdown=${(event: PointerEvent) => { this.startSectionResize(event); }}></div>
      <session-list
        style=${`flex-grow:${String(100 - this.projectsFlex)}`}
        .sessions=${this.sessions}
        .statuses=${this.sessionStatuses}
        .activities=${this.sessionActivities}
        .sending=${this.sendingPrompts}
        .unreadSessionIds=${this.unreadSessionIds}
        .selected=${this.selectedSession}
        .startingCount=${this.startingSessionCount}
        .canStart=${this.canStartSession}
        .collapsible=${this.collapsible}
        .collapsed=${this.sessionsCollapsed}
        .onToggleCollapsed=${this.childCallbacks.toggleSessions}
        .onArchivedCollapsed=${this.childCallbacks.archivedCollapsed}
        .onStart=${this.childCallbacks.startSession}
        .onStartPlain=${this.childCallbacks.startSessionPlain}
        .unitMenuCwd=${this.unitMenuCwd}
        .onSessionMenuOpen=${this.childCallbacks.sessionMenuOpen}
        .onStartAt=${this.childCallbacks.startSessionAt}
        .onAddWorktree=${this.childCallbacks.addWorktree}
        .onSelect=${this.childCallbacks.selectSession}
        .onArchive=${this.childCallbacks.archiveSession}
        .onArchiveWithDescendants=${this.childCallbacks.archiveSessionWithDescendants}
        .onArchiveMany=${this.childCallbacks.archiveSessions}
        .onRestore=${this.childCallbacks.restoreSession}
        .onDelete=${this.childCallbacks.deleteCachedNewSession}
        .onDeleteArchived=${this.childCallbacks.deleteArchivedSession}
        .onDeleteArchivedMany=${this.childCallbacks.deleteArchivedSessions}
        .onDetachParent=${this.childCallbacks.detachParentSession}
        .onMarkRead=${this.childCallbacks.markSessionRead}
        .onMarkReadMany=${this.childCallbacks.markSessionsRead}
        .onReload=${this.childCallbacks.reloadSession}
        .onCleanup=${this.childCallbacks.cleanupSessions}
        .onFocusPreviousSection=${this.childCallbacks.previousFromSessions}
        .onFocusNextSection=${this.childCallbacks.nextFromSessions}
        .onCancelKeyboardNavigation=${this.childCallbacks.cancelKeyboardNavigation}
      ></session-list>
    `;
  }

  /** rbowen (wstoggle): drag handle between Projects and Sessions; 5–95% clamp, persisted. */
  private startSectionResize(event: PointerEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startFlex = this.projectsFlex;
    const height = this.clientHeight || 1;
    const onMove = (move: PointerEvent) => {
      const flex = startFlex + ((move.clientY - startY) / height) * 100;
      this.projectsFlex = Math.round(Math.min(95, Math.max(5, flex)));
      localStorage.setItem("pi-web.projectsFlex", String(this.projectsFlex));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  /**
   * Project and workspace rows always belong to the selected machine, resolved
   * exactly as the rest of the app resolves it — including its local-machine
   * default, which is the key snapshots arrive under before a machine has been
   * selected. Diverging here would blank every row's indicator while a snapshot
   * is in fact loaded.
   */
  private selectedMachineStatusSnapshot(): MachineStatusSnapshot | undefined {
    return this.machineStatusSnapshots[selectedMachineId({ selectedMachine: this.selectedMachine })];
  }

  private async focusNavigableSection(section: KeyboardNavigableSection | undefined): Promise<boolean> {
    if (section === undefined) return false;
    return await section.focusSelectedOrFirst();
  }

  private focusPreviousFrom(section: NavigationSection): void {
    const target = previousVisibleNavigationTarget(section, this.machines);
    if (target !== undefined) void this.onFocusNavigationTarget?.(target);
  }

  private focusNextFrom(section: NavigationSection): void {
    void this.onFocusNavigationTarget?.(nextVisibleNavigationTarget(section, this.machines));
  }

  private cancelKeyboardNavigation(): void {
    void this.onCancelKeyboardNavigation?.();
  }

  static override styles = css`
    :host { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
    :host([compact]) { flex: 1 1 auto; }
    /* Expanded sections share the panel height equally, so collapsing one
       section distributes its space to every remaining section, not just the
       session list. Collapsed sections keep only their heading height. */
    machine-list, project-list, session-list { flex: 1 1 0px; min-height: 0; overflow: hidden; border-bottom: 1px solid var(--pi-border-muted); }
    .section-resizer { flex: 0 0 7px; cursor: ns-resize; touch-action: none; user-select: none; position: relative; }
    .section-resizer::after { content: ""; position: absolute; left: 10px; right: 10px; top: 3px; height: 1px; background: var(--pi-border); }
    .section-resizer:hover::after, .section-resizer:active::after { background: var(--pi-accent); }
    machine-list[collapsed],
    project-list[collapsed],
    session-list[collapsed] { flex: 0 0 auto; min-height: auto; overflow: hidden; }
  `;
}

export function shouldShowMachinesSection(machines: readonly Machine[]): boolean {
  return machines.length > 1;
}

function previousVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[]): NavigationSection | undefined {
  const sections = visibleNavigationSections(machines);
  return sections[sections.indexOf(section) - 1];
}

function nextVisibleNavigationTarget(section: NavigationSection, machines: readonly Machine[]): NavigationFocusTarget {
  const sections = visibleNavigationSections(machines);
  return sections[sections.indexOf(section) + 1] ?? "chat";
}

// Only a machine choice makes the machines section navigable: with a single
// machine the switcher is a static bubble, and compact mode has no list.
function visibleNavigationSections(machines: readonly Machine[]): NavigationSection[] {
  return NAVIGATION_SECTION_ORDER.filter((section) => (section !== "machines" || shouldShowMachinesSection(machines)) && section !== "workspaces");
}
