// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Machine, Project, SessionInfo } from "../../api";
import type { MachineStatusSnapshot } from "../../../../shared/machineStatus";
import { machineStatusSnapshot } from "../../machineStatus.testSupport";
import { MachineList } from "../MachineList";
import { ProjectList } from "../ProjectList";
import { SessionList } from "../SessionList";
import { AppNavigationPanel, shouldShowMachinesSection } from "./AppNavigationPanel";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("shouldShowMachinesSection", () => {
  it("hides machine navigation when there is no machine choice", () => {
    expect(shouldShowMachinesSection([])).toBe(false);
    expect(shouldShowMachinesSection([machine("local")])).toBe(false);
  });

  it("shows machine navigation when there are multiple machines", () => {
    expect(shouldShowMachinesSection([machine("local"), machine("remote-a")])).toBe(true);
  });
});

describe("header identity", () => {
  it("renders no header at all — brand and quick links moved to the tab bars (rbowen)", async () => {
    const panel = await mountHeaderPanel([machine("local")]);

    expect(panel.shadowRoot?.querySelector("header")).toBeNull();
  });
});

describe("machine status wiring", () => {
  it("gives machine sections every snapshot and the project section the selected machine's", async () => {
    const local = machineStatusSnapshot({ machine: { "core:working": true } });
    const remote = machineStatusSnapshot({ machine: { "core:unread": true } });
    const panel = await mountPanel({ local, "remote-a": remote }, machine("local"));

    expect(section(panel, "machine-list", MachineList).statusSnapshots).toEqual({ local, "remote-a": remote });
    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBe(local);
  });

  it("reads the local machine's snapshot before a machine has been selected", async () => {
    // `selectedMachine` is undefined until machines load, and can stay undefined
    // if that load fails, while local project rows already render. The app keys
    // snapshots by `selectedMachine?.id ?? LOCAL_MACHINE_ID`, so this panel must
    // resolve the same id instead of blanking every indicator.
    const local = machineStatusSnapshot({ projects: { "project-1": { "core:working": true } } });
    const panel = await mountPanel({ local }, undefined);

    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBe(local);
  });

  it("leaves the project section without a snapshot when the selected machine has none", async () => {
    const panel = await mountPanel({ "remote-a": machineStatusSnapshot() }, machine("local"));

    expect(section(panel, "project-list", ProjectList).statusSnapshot).toBeUndefined();
  });
});

describe("stable list inputs", () => {
  it("skips unchanged lists on panel updates while invoking the latest callbacks", async () => {
    const panel = await mountPanel({}, machine("local"));
    const currentSession = session("session-1");
    panel.sessions = [currentSession];
    const oldSelect = vi.fn();
    panel.onSelectProject = oldSelect;
    panel.onSelectSession = oldSelect;
    const projects = section(panel, "project-list", ProjectList);
    const sessions = section(panel, "session-list", SessionList);
    const lists = [projects, sessions];
    const settle = async () => {
      await panel.updateComplete;
      await Promise.all(lists.map((list) => list.updateComplete));
    };
    await settle();
    // Render counts are the regression contract, not a proxy for visible output.
    const renders = lists.map((list) => vi.spyOn(list, "render"));
    const panelRender = vi.spyOn(panel, "render");
    panel.projectsHidden = !panel.projectsHidden;
    await settle();
    expect(panelRender).toHaveBeenCalledOnce();
    for (const render of renders) expect(render).not.toHaveBeenCalled();

    const selectProject = vi.fn();
    const selectSession = vi.fn();
    const focus = vi.fn();
    panel.onSelectProject = selectProject;
    panel.onSelectSession = selectSession;
    panel.onFocusNavigationTarget = focus;
    panel.machines = [machine("local")];
    await settle();
    for (const render of renders) expect(render).not.toHaveBeenCalled();
    for (const list of lists) control(list, ".action-row").click();
    expect(selectProject).toHaveBeenCalledWith(panel.projects[0]);
    expect(selectSession).toHaveBeenCalledWith(currentSession);
    expect(oldSelect).not.toHaveBeenCalled();

    control(projects, ".action-row").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(focus).not.toHaveBeenCalled();
    panel.machines = [machine("local"), machine("remote-a")];
    await settle();
    control(projects, ".action-row").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(focus).toHaveBeenCalledWith("machines");
  });

  it("still renders changed list data", async () => {
    const panel = await mountPanel({}, machine("local"));
    const projects = section(panel, "project-list", ProjectList);
    const sessions = section(panel, "session-list", SessionList);
    await Promise.all([projects.updateComplete, sessions.updateComplete]);
    panel.projects = [project("latest-project")];
    panel.sessions = [session("latest-session")];
    await panel.updateComplete;
    await Promise.all([projects.updateComplete, sessions.updateComplete]);
    expect(projects.shadowRoot?.textContent).toContain("latest-project");
    expect(sessions.shadowRoot?.textContent).toContain("latest-session");
  });
});

function control(list: ProjectList | SessionList, selector: string): HTMLElement {
  const element = list.shadowRoot?.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
  return element;
}

function session(id: string): SessionInfo {
  return {
    id, path: `/sessions/${id}.jsonl`, cwd: "/workspace",
    created: "2026-06-09T00:00:00.000Z", modified: "2026-06-09T00:00:00.000Z",
    messageCount: 1, firstMessage: id,
  };
}

async function mountPanel(machineStatusSnapshots: Record<string, MachineStatusSnapshot>, selectedMachine: Machine | undefined): Promise<AppNavigationPanel> {
  const panel = new AppNavigationPanel();
  panel.compact = true;
  panel.machines = [machine("local"), machine("remote-a")];
  if (selectedMachine !== undefined) panel.selectedMachine = selectedMachine;
  panel.projects = [project("project-1")];
  panel.machineStatusSnapshots = machineStatusSnapshots;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function section<T>(panel: AppNavigationPanel, selector: string, type: abstract new (...args: never) => T): T {
  const element = panel.shadowRoot?.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Expected a ${selector} section`);
  return element;
}

async function mountHeaderPanel(machines: Machine[]): Promise<AppNavigationPanel> {
  const panel = new AppNavigationPanel();
  panel.machines = machines;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}

function machine(id: string): Machine {
  return {
    id,
    name: id,
    kind: id === "local" ? "local" : "remote",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}
