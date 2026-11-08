import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type {
  PiWebServerPlugin,
  ProjectInput,
  ProviderClaim,
  ProviderRemoveContext,
  ProviderWorkspace,
  ServerPluginActivationContext,
  ServerPluginExecFileResult,
  WorkspaceProvider,
  WorkspaceRemovePlan,
} from "@jmfederico/pi-web/server-plugin-api";
import { requestGitBackend } from "./git-backend.js";

const UNIT_SCAN_TTL_MS = 3_000;
const UNIT_SCAN_CONCURRENCY = 12;

const GIT_LOCAL_ENV_VARS = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
]);

interface GitWorktreeInfo {
  path: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  prunable?: boolean;
}

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "Git",
  activate(context) {
    return {
      workspaceProvider: createGitWorkspaceProvider(context),
      peer: { request: (request) => requestGitBackend(context, request) },
    };
  },
};

export default plugin;

export function createGitWorkspaceProvider(
  context: ServerPluginActivationContext,
  options: { unitsRoot?: string } = {},
): WorkspaceProvider {
  const unitScan = createUnitScan(context, options.unitsRoot);
  return Object.freeze({
    fallback: true,
    async probe(project: ProjectInput, signal: AbortSignal): Promise<ProviderClaim> {
      const result = await runGit(context, project.path, ["rev-parse", "--is-inside-work-tree"], signal);
      if (result.signal !== null) throw new Error(`git repository probe ended from signal ${result.signal}`);
      if (result.exitCode !== 0) return "pass";
      return result.stdout.trim() === "true" ? "claim" : "pass";
    },
    async list(project: ProjectInput, signal: AbortSignal): Promise<ProviderWorkspace[]> {
      const rootResult = await requireGit(
        runGit(context, project.path, ["rev-parse", "--show-toplevel"], signal),
        "resolve the Git worktree root",
      );
      const mainRootOutput = rootResult.stdout.trim();
      if (mainRootOutput === "") throw new Error("Git returned an empty worktree root");
      const mainRoot = resolve(mainRootOutput);
      const commonDirectoryResult = await requireGit(
        runGit(context, project.path, ["rev-parse", "--git-common-dir"], signal),
        "resolve the Git common directory",
      );
      const commonDirectoryOutput = commonDirectoryResult.stdout.trim();
      if (commonDirectoryOutput === "") throw new Error("Git returned an empty common directory");
      const commonDirectory = resolve(project.path, commonDirectoryOutput);

      const listResult = await requireGit(
        runGit(context, project.path, ["worktree", "list", "--porcelain", "-z"], signal),
        "list Git worktrees",
      );
      const worktrees = parseGitWorktreeList(listResult.stdout)
        .filter((worktree) => worktree.bare !== true)
        .map((worktree) => {
          const path = resolve(worktree.path);
          return { worktree: { ...worktree, path }, path };
        });
      // Prefer the checkout Git identifies for the registered project. A
      // submodule is the exception: its sole worktree record points at common
      // storage under the superproject instead of at --show-toplevel.
      const mainWorkspacePath = worktrees.some(({ path }) => path === mainRoot)
        ? mainRoot
        : commonDirectory;
      const selectable = worktrees
        .map(({ worktree, path }) => ({ worktree, path, isMain: path === mainWorkspacePath }))
        .filter(({ worktree, path, isMain }) => worktree.prunable !== true || isMain || path === project.path);
      const unitWorkspaces = unitWorkspacesFor(await unitScan(signal), [
        mainRoot,
        project.path,
        ...selectable.map(({ path }) => path),
      ]);
      if (selectable.length === 0) {
        return unitWorkspaces.length > 0 ? unitWorkspaces : [singleGitWorkspace(project)];
      }

      return [
        ...selectable.map(({ worktree, path, isMain }) => {
          const label = worktree.branch ?? (worktree.detached === true ? "detached" : basename(worktree.path) || worktree.path);
          return {
            key: path,
            path,
            label,
            isMain,
            data: {
              worktreePath: worktree.path,
              ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
            },
            publicMetadata: {
              isGitRepo: true,
              isGitWorktree: true,
              ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
              ...(worktree.detached === undefined ? {} : { detached: worktree.detached }),
            },
            ...(isMain ? {} : { removal: gitRemovalPresentation(label, path) }),
          };
        }),
        ...unitWorkspaces,
      ];
    },
    async prepareRemove({ project, workspace, signal }: ProviderRemoveContext): Promise<WorkspaceRemovePlan> {
      const privatePath = gitPrivateWorktreePath(workspace);
      if (resolve(privatePath) !== workspace.path) {
        throw new Error("Git workspace removal data no longer matches the current workspace path");
      }
      const listResult = await requireGit(
        runGit(context, project.path, ["worktree", "list", "--porcelain", "-z"], signal),
        "validate the Git worktree before removal",
      );
      const current = parseGitWorktreeList(listResult.stdout)
        .find((worktree) => resolve(worktree.path) === workspace.path);
      if (current === undefined || current.prunable === true) {
        throw new Error("Git worktree is no longer available for removal");
      }
      if (current.bare === true) throw new Error("A bare Git workspace cannot be removed as a linked worktree");
      return {
        title: `Delete workspace: ${workspace.label}`,
        command: `git worktree remove ${shellQuote(workspace.path)}`,
      };
    },
  });
}

/** Parse `git worktree list --porcelain -z` without path quoting or space loss. */
export function parseGitWorktreeList(stdout: string): GitWorktreeInfo[] {
  return stdout.split("\0\0").flatMap((record) => {
    if (record === "") return [];
    const info: GitWorktreeInfo = { path: "" };
    for (const field of record.split("\0")) {
      const separator = field.indexOf(" ");
      const key = separator === -1 ? field : field.slice(0, separator);
      const value = separator === -1 ? "" : field.slice(separator + 1);
      if (key === "worktree") info.path = value;
      else if (key === "branch") info.branch = value.replace(/^refs\/heads\//u, "");
      else if (key === "bare") info.bare = true;
      else if (key === "detached") info.detached = true;
      else if (key === "prunable") info.prunable = true;
    }
    return info.path === "" ? [] : [info];
  });
}

/** One checkout under ~/units/<unit>/worktrees/ that looks like a git clone.
 * Unit sessions create these outside `git worktree list`, which is why the
 * provider must scan for them: clone-based worktrees are invisible to the
 * main repository's worktree registry. */
export interface UnitWorktreeEntry {
  path: string;
  /** "<unit>/<worktree-name>" — stable and human-readable. */
  label: string;
  /** `git remote get-url origin` output; for unit clones this is the source
   * checkout's filesystem path, which is how entries are matched to a project. */
  origin: string;
  /** Current branch name, "" when detached. */
  branch: string;
}

export interface UnitScanDeps {
  runGit(cwd: string, args: readonly string[]): Promise<{ stdout: string }>;
}

/** Scan ~/units/<unit>/worktrees/* for git checkouts, resolving each entry's
 * origin URL and current branch. Entries that cannot be inspected are skipped;
 * a missing or unreadable units root yields an empty result. */
export async function scanUnitWorktrees(deps: UnitScanDeps, unitsRoot: string): Promise<UnitWorktreeEntry[]> {
  let units: string[];
  try {
    units = readdirSync(unitsRoot);
  } catch {
    return [];
  }
  const groups: Array<{ unit: string; paths: string[] }> = [];
  for (const unit of units) {
    const worktreesRoot = join(unitsRoot, unit, "worktrees");
    let children: string[];
    try {
      children = readdirSync(worktreesRoot);
    } catch {
      continue;
    }
    const paths = children.map((child) => join(worktreesRoot, child)).filter((path) => existsSync(join(path, ".git")));
    if (paths.length > 0) groups.push({ unit, paths });
  }
  // Every worktree of a unit shares the unit clone's origin, so the origin is
  // read once per unit and branches are read in parallel. The previous sweep
  // ran two serial git spawns per worktree (~126 processes for ~63 units) and
  // gated the workspace catalog listing for seconds.
  const scanned = await boundedMap(groups, UNIT_SCAN_CONCURRENCY, async ({ unit, paths }) => {
    const firstPath = paths[0];
    if (firstPath === undefined) return [];
    let origin = "";
    try {
      origin = (await deps.runGit(firstPath, ["remote", "get-url", "origin"])).stdout.trim();
    } catch {
      return [];
    }
    return boundedMap(paths, UNIT_SCAN_CONCURRENCY, async (path) => {
      try {
        const branch = (await deps.runGit(path, ["branch", "--show-current"])).stdout.trim();
        return { path, label: `${unit}/${basename(path)}`, origin, branch };
      } catch {
        return null;
      }
    });
  });
  return scanned.flat().filter((entry): entry is UnitWorktreeEntry => entry !== null);
}

/** Runs `fn` over `items` with at most `limit` promises in flight, preserving order. */
async function boundedMap<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) break;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Unit checkouts whose origin path belongs to this project's known checkout
 * paths become provider workspaces of the project. Branch-less entries (fresh
 * or detached checkouts) omit the branch fields rather than emitting empty
 * strings. */
export function unitWorkspacesFor(entries: readonly UnitWorktreeEntry[], knownPaths: readonly string[]): ProviderWorkspace[] {
  const known = new Set(knownPaths.map((path) => resolve(path)));
  const seen = new Set<string>();
  const workspaces: ProviderWorkspace[] = [];
  for (const entry of entries) {
    if (!known.has(resolve(entry.origin)) || seen.has(entry.path)) continue;
    seen.add(entry.path);
    workspaces.push({
      key: entry.path,
      path: entry.path,
      label: entry.label,
      isMain: false,
      data: {
        worktreePath: entry.path,
        ...(entry.branch === "" ? {} : { branch: entry.branch }),
      },
      publicMetadata: {
        isGitRepo: true,
        isGitWorktree: true,
        ...(entry.branch === "" ? {} : { branch: entry.branch }),
      },
    });
  }
  return workspaces;
}

/** Bounded-rate unit scan shared by every list() call: at most one filesystem
 * + git sweep per UNIT_SCAN_TTL_MS, result cached in the provider closure. */
function createUnitScan(context: ServerPluginActivationContext, unitsRoot = join(homedir(), "units")) {
  let cache: { at: number; value: UnitWorktreeEntry[] } = { at: 0, value: [] };
  return async (signal: AbortSignal): Promise<UnitWorktreeEntry[]> => {
    if (Date.now() - cache.at >= UNIT_SCAN_TTL_MS) {
      cache = {
        at: Date.now(),
        value: await scanUnitWorktrees(
          { runGit: async (cwd, args) => await runGit(context, cwd, args, signal) },
          unitsRoot,
        ),
      };
    }
    return cache.value;
  };
}

function singleGitWorkspace(project: ProjectInput): ProviderWorkspace {
  return {
    key: project.path,
    path: project.path,
    label: project.name,
    isMain: true,
    data: { worktreePath: project.path },
    publicMetadata: { isGitRepo: true, isGitWorktree: false },
  };
}

function gitRemovalPresentation(label: string, path: string): NonNullable<ProviderWorkspace["removal"]> {
  return {
    actionLabel: "Delete workspace",
    confirmation: `Delete workspace ${label}?\n\nThis will run git worktree remove and delete:\n${path}\n\nThe Git branch will not be deleted.`,
  };
}

function gitPrivateWorktreePath(workspace: ProviderWorkspace): string {
  const data = workspace.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("Git workspace removal data is unavailable");
  }
  const path: unknown = Reflect.get(data, "worktreePath");
  if (typeof path !== "string" || path === "") throw new Error("Git worktree path is unavailable for removal");
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runGit(
  context: ServerPluginActivationContext,
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<ServerPluginExecFileResult> {
  const result = await context.execFile({
    file: "git",
    args: ["-C", cwd, ...args],
    unsetEnv: GIT_LOCAL_ENV_VARS,
    signal,
  });
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error(`git ${args.join(" ")} exceeded the host output limit`);
  }
  return result;
}

async function requireGit(
  resultPromise: Promise<ServerPluginExecFileResult>,
  action: string,
): Promise<ServerPluginExecFileResult> {
  const result = await resultPromise;
  if (result.signal === null && result.exitCode === 0) return result;
  const detail = result.stderr.trim();
  const outcome = result.signal === null ? `exit ${String(result.exitCode)}` : `signal ${result.signal}`;
  throw new Error(`Unable to ${action} (${outcome})${detail === "" ? "" : `: ${detail}`}`);
}
