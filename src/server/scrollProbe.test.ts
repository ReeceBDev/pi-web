import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let clientDist: string;
let logFile: string;

beforeEach(async () => {
  clientDist = await mkdtemp(join(tmpdir(), "pi-web-scroll-probe-dist-"));
  logFile = join(await mkdtemp(join(tmpdir(), "pi-web-scroll-probe-log-")), "events.ndjson");
  await writeFile(join(clientDist, "index.html"), "<html><body><pi-web-app></pi-web-app></body></html>");
});

afterEach(async () => {
  await rm(clientDist, { recursive: true, force: true });
  await rm(logFile, { force: true });
});

describe("scroll probe", () => {
  it("injects the probe script into the app shell with revalidating cache", async () => {
    const app = await buildApp({ clientDist, logger: false, scrollProbeLogFile: logFile });
    try {
      const shell = await app.inject({ method: "GET", url: "/" });

      expect(shell.statusCode).toBe(200);
      expect(shell.headers["content-type"]).toContain("text/html");
      expect(shell.headers["cache-control"]).toBe("public, max-age=0");
      expect(shell.body).toContain('<script src="/__probe.js"></script>');
      expect(shell.body).toContain("<pi-web-app></pi-web-app>");
    } finally {
      await app.close();
    }
  });

  it("serves the probe script without caching", async () => {
    const app = await buildApp({ clientDist, logger: false, scrollProbeLogFile: logFile });
    try {
      const script = await app.inject({ method: "GET", url: "/__probe.js" });

      expect(script.statusCode).toBe(200);
      expect(script.headers["content-type"]).toContain("javascript");
      expect(script.headers["cache-control"]).toBe("no-store");
      expect(script.body).toContain("/__probe");
    } finally {
      await app.close();
    }
  });

  it("appends probe batches to the log file", async () => {
    const app = await buildApp({ clientDist, logger: false, scrollProbeLogFile: logFile });
    try {
      const posted = await app.inject({
        method: "POST",
        url: "/__probe",
        payload: JSON.stringify({ ua: "test", href: "https://hephaestus.test/", events: [{ t: 1, type: "s", y: 42 }] }),
        headers: { "content-type": "application/json" },
      });

      expect(posted.statusCode).toBe(200);
      const logged: unknown = JSON.parse(await readFile(logFile, "utf8"));
      expect(logged).toMatchObject({ ua: "test", events: [{ y: 42 }] });
    } finally {
      await app.close();
    }
  });

  it("rejects oversized probe batches", async () => {
    const app = await buildApp({ clientDist, logger: false, scrollProbeLogFile: logFile });
    try {
      const posted = await app.inject({
        method: "POST",
        url: "/__probe",
        payload: JSON.stringify({ ua: "test", events: [{ blob: "x".repeat(100_001) }] }),
        headers: { "content-type": "application/json" },
      });

      expect(posted.statusCode).toBe(413);
      await expect(readFile(logFile, "utf8")).rejects.toThrow();
    } finally {
      await app.close();
    }
  });
});
