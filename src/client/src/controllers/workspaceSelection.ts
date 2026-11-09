import type { Workspace } from "../api";
import { browserSessionStorage, parseStoredString, PersistentValueMap, type KeyValueStorage } from "./sessionStorageMemory";

export interface WorkspaceSelectionMemory {
  latestWorkspaceId(projectId: string): string | undefined;
  rememberWorkspace(workspace: Workspace): void;
  forgetProject(projectId: string): void;
}

export class InMemoryWorkspaceSelectionMemory implements WorkspaceSelectionMemory {
  private readonly workspaceIdsByProject = new Map<string, string>();

  latestWorkspaceId(projectId: string): string | undefined {
    return this.workspaceIdsByProject.get(projectId);
  }

  rememberWorkspace(workspace: Workspace): void {
    this.workspaceIdsByProject.set(workspace.projectId, workspace.id);
  }

  forgetProject(projectId: string): void {
    this.workspaceIdsByProject.delete(projectId);
  }
}

const workspaceSelectionStorageKey = "pi-web:workspace-selection:v1";

export class SessionStorageWorkspaceSelectionMemory implements WorkspaceSelectionMemory {
  private readonly workspaceIdsByProject: PersistentValueMap<string>;

  constructor(storage: KeyValueStorage | undefined = browserSessionStorage()) {
    this.workspaceIdsByProject = new PersistentValueMap(workspaceSelectionStorageKey, parseStoredString, storage);
  }

  latestWorkspaceId(projectId: string): string | undefined {
    return this.workspaceIdsByProject.get(projectId);
  }

  rememberWorkspace(workspace: Workspace): void {
    this.workspaceIdsByProject.set(workspace.projectId, workspace.id);
  }

  forgetProject(projectId: string): void {
    this.workspaceIdsByProject.delete(projectId);
  }
}

export function selectPreferredWorkspace(workspaces: Workspace[], options?: { targetWorkspaceId?: string | undefined; latestWorkspaceId?: string | undefined }): Workspace | undefined {
  const targetWorkspaceId = options?.targetWorkspaceId;
  if (targetWorkspaceId !== undefined && targetWorkspaceId !== "") return workspaces.find((workspace) => workspace.id === targetWorkspaceId);

  // A project opens on its main checkout by default; worktree lists order the
  // repo's main checkout first only when the project IS that checkout, so
  // sibling-worktree projects would otherwise inherit another checkout's
  // sessions.
  return workspaces.find((workspace) => workspace.isMain) ?? workspaces[0];
}
