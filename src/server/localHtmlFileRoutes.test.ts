import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerLocalHtmlFileRoutes } from "./localHtmlFileRoutes.js";

let app: FastifyInstance;
let dir: string;

beforeEach(async () => {
  app = Fastify({ logger: false });
  registerLocalHtmlFileRoutes(app);
  registerLocalHtmlFileRoutes(app, "/api/machines/local");
  await app.ready();
  dir = await mkdtemp(path.join(homedir(), "pi-web-local-html-file-test-"));
  await writeFile(path.join(dir, "report.html"), "<p>hello</p>");
});

afterEach(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("local html file routes", () => {
  it("serves an html file under the home directory with html headers", async () => {
    const response = await app.inject({ method: "GET", url: `/api/local-html-file?path=${encodeURIComponent(path.join(dir, "report.html"))}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("<p>hello</p>");
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves through the machines/local prefix too", async () => {
    const response = await app.inject({ method: "GET", url: `/api/machines/local/local-html-file?path=${encodeURIComponent(path.join(dir, "report.html"))}` });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("<p>hello</p>");
  });

  it("rejects ../ traversal out of the home directory", async () => {
    const response = await app.inject({ method: "GET", url: `/api/local-html-file?path=${encodeURIComponent(path.join(homedir(), "..", "etc", "evil.html"))}` });

    expect(response.statusCode).toBe(403);
  });

  it("rejects symlinks escaping the home directory", async () => {
    await symlink("/etc/hosts", path.join(dir, "escape.html"));
    const response = await app.inject({ method: "GET", url: `/api/local-html-file?path=${encodeURIComponent(path.join(dir, "escape.html"))}` });

    expect(response.statusCode).toBe(403);
  });

  it("rejects paths outside the home directory", async () => {
    const response = await app.inject({ method: "GET", url: `/api/local-html-file?path=${encodeURIComponent("/etc/evil.html")}` });

    expect(response.statusCode).toBe(403);
  });

  it("rejects non-html files", async () => {
    await writeFile(path.join(dir, "notes.md"), "# notes");
    const response = await app.inject({ method: "GET", url: `/api/local-html-file?path=${encodeURIComponent(path.join(dir, "notes.md"))}` });

    expect(response.statusCode).toBe(400);
  });

  it("rejects missing files", async () => {
    const response = await app.inject({ method: "GET", url: `/api/local-html-file?path=${encodeURIComponent(path.join(dir, "missing.html"))}` });

    expect(response.statusCode).toBe(404);
  });

  it("rejects a missing path parameter", async () => {
    const response = await app.inject({ method: "GET", url: "/api/local-html-file" });

    expect(response.statusCode).toBe(400);
  });
});
