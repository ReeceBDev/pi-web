import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { ProjectService } from "./projects/projectService.js";
import { ProjectStore } from "./storage/projectStore.js";
import { AppTestWorkspaceCatalog } from "./app.testSupport.js";
import { registerProjectMutationRoutes } from "./sessiond/projectMutationRoutes.js";
import type { SessionProxyDaemon } from "./sessiond/sessionProxyRoutes.js";
import type { PiWebConfigService } from "./configRoutes.js";
import type { PiWebConfigResponse, PiWebConfigValues } from "../shared/apiTypes.js";
import type { Project } from "./types.js";

interface ScriptedSessionResponse {
  statusCode: number;
  body: string;
}

interface CatalogDaemon extends SessionProxyDaemon {
  close(): Promise<void>;
  scriptedResponses: Map<string, ScriptedSessionResponse | Error>;
  requestedPaths: string[];
}

function fakeCatalogDaemon(projects: ProjectService): CatalogDaemon {
  const daemonApp = Fastify({ logger: false });
  registerProjectMutationRoutes(daemonApp, projects);
  const scriptedResponses = new Map<string, ScriptedSessionResponse | Error>();
  const requestedPaths: string[] = [];
  return {
    scriptedResponses,
    requestedPaths,
    close: () => daemonApp.close(),
    request: async (method, path, body) => {
      if (method === "POST" && path === "/projects") {
        const response = await daemonApp.inject({ method, url: path, payload: JSON.stringify(body), headers: { "content-type": "application/json" } });
        return { statusCode: response.statusCode, headers: { "content-type": "application/json" }, body: response.body };
      }
      requestedPaths.push(path);
      const cwd = new URL(path, "http://pi-web.local").searchParams.get("cwd") ?? "";
      const scripted = scriptedResponses.get(cwd);
      if (scripted instanceof Error) throw scripted;
      if (scripted !== undefined) return { statusCode: scripted.statusCode, headers: { "content-type": "application/json" }, body: scripted.body };
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: "[]" };
    },
    requestStream: () => Promise.reject(new Error("requestStream not configured for catalog test")),
    connectWebSocket: () => { throw new Error("WebSocket not configured for catalog test"); },
  };
}

function fakeConfigService(): PiWebConfigService {
  let config: PiWebConfigValues = {};
  const response = (): PiWebConfigResponse => ({
    path: join(tmpdir(), "catalog-test-config.json"),
    exists: false,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false },
  });
  return {
    read: () => response(),
    write: (nextConfig) => {
      config = nextConfig;
      return response();
    },
  };
}

function sessionPayload(cwd: string, id: string) {
  return { id, cwd, path: `${cwd}/.pi/sessions/${id}`, created: "now", modified: "now", messageCount: 1, firstMessage: "hello" };
}

describe("buildApp project catalog route", () => {
  let tempDir: string;
  let projectDir: string;
  let projects: ProjectService;
  let workspaceCatalog: AppTestWorkspaceCatalog;
  let daemon: CatalogDaemon;
  let app: FastifyInstance;

  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), "pi-web-catalog-test-")));
    projectDir = join(tempDir, "project");
    projects = new ProjectService(new ProjectStore(join(tempDir, "projects.json")));
    workspaceCatalog = new AppTestWorkspaceCatalog(projects);
    daemon = fakeCatalogDaemon(projects);
    app = await buildApp({
      projects,
      workspaceCatalog,
      sessionDaemon: daemon,
      config: fakeConfigService(),
      clientDist: false,
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
    await daemon.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns every project, its workspaces, and their session lists in one response", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Cataloged", path: projectDir, create: true } });
    expect(addResponse.statusCode).toBe(200);
    const added = addResponse.json<Project>();
    const main = (await workspaceCatalog.resolveProject(added.id)).workspaces[0];
    if (main === undefined) throw new Error("Expected a main workspace");
    const secondaryPath = join(tempDir, "secondary-worktree");
    workspaceCatalog.set(added.id, [main, { id: "secondary", projectId: added.id, path: secondaryPath, label: "secondary", isMain: false }]);
    daemon.scriptedResponses.set(secondaryPath, { statusCode: 200, body: JSON.stringify([sessionPayload(secondaryPath, "s2")]) });

    const response = await app.inject({ method: "GET", url: "/api/projects/catalog" });
    const aliasResponse = await app.inject({ method: "GET", url: "/api/machines/local/projects/catalog" });

    expect(response.statusCode).toBe(200);
    expect(aliasResponse.statusCode).toBe(200);
    expect(aliasResponse.json()).toEqual(response.json());
    expect(response.json()).toEqual({
      projects: [{
        ...added,
        workspaces: [
          { ...main, effectiveConfig: { uploads: { defaultFolder: ".pi-web/uploads" }, attachments: { defaultFolder: ".pi-web/attachments" } }, sessions: [] },
          {
            id: "secondary",
            projectId: added.id,
            path: secondaryPath,
            label: "secondary",
            isMain: false,
            effectiveConfig: { uploads: { defaultFolder: ".pi-web/uploads" }, attachments: { defaultFolder: ".pi-web/attachments" } },
            sessions: [sessionPayload(secondaryPath, "s2")],
          },
        ],
      }],
    });
    // The catalog fans out per workspace; the /api/machines/local alias request runs the same fan-out again.
    const expectedSessionRequests = [
      `/sessions?cwd=${encodeURIComponent(projectDir)}`,
      `/sessions?cwd=${encodeURIComponent(secondaryPath)}`,
    ];
    expect(daemon.requestedPaths).toEqual([...expectedSessionRequests, ...expectedSessionRequests]);
  });

  it("yields an empty session list for a workspace whose session request fails", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Broken", path: projectDir, create: true } });
    expect(addResponse.statusCode).toBe(200);
    daemon.scriptedResponses.set(projectDir, new Error("session daemon exploded"));

    const response = await app.inject({ method: "GET", url: "/api/projects/catalog" });

    expect(response.statusCode).toBe(200);
    const catalog = response.json<{ projects: { workspaces: { path: string; sessions: unknown[] }[] }[] }>();
    expect(catalog.projects).toHaveLength(1);
    expect(catalog.projects[0]?.workspaces).toEqual([
      expect.objectContaining({ path: projectDir, sessions: [] }),
    ]);
  });

  it("does not let /projects/catalog shadow the per-project workspaces route", async () => {
    const addResponse = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "Routing", path: projectDir, create: true } });
    const added = addResponse.json<{ id: string }>();

    const workspacesResponse = await app.inject({ method: "GET", url: `/api/projects/${added.id}/workspaces` });
    const catalogAsProjectResponse = await app.inject({ method: "GET", url: "/api/projects/catalog/workspaces" });

    expect(workspacesResponse.statusCode).toBe(200);
    expect(catalogAsProjectResponse.statusCode).toBe(404);
  });
});
