import { readFile, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

// ponytail: serves THIS machine's files only — the terminal plugin is
// machineSpecific and the box is single-host, and the app already exposes a
// full shell via that plugin, so a home-confined read endpoint adds no
// capability for anyone with app access ("access is the auth"). If pi-web ever
// proxies terminal sessions to remote machines, this endpoint must move behind
// the machine proxy instead of serving the host's filesystem.
const HOME_ROOT = homedir();
// ponytail: 10 MB cap keeps huge files from being served into a tab; raise it
// if real reports outgrow it.
const MAX_BYTES = 10 * 1024 * 1024;

const HTML_FILE_PATTERN = /\.html?$/iu;

export function registerLocalHtmlFileRoutes(app: FastifyInstance, prefix = "/api"): void {
  app.get<{ Querystring: { path?: string } }>(`${prefix}/local-html-file`, async (request, reply) => {
    const requested = request.query.path;
    if (requested === undefined || requested === "") {
      return reply.code(400).send({ error: "path query parameter is required" });
    }
    if (!HTML_FILE_PATTERN.test(requested)) {
      return reply.code(400).send({ error: "only .html and .htm files are served" });
    }
    const resolved = path.resolve(requested);
    if (!isUnderHome(resolved)) {
      return reply.code(403).send({ error: "path is outside the home directory" });
    }
    // Resolve symlinks so a link can not smuggle a path out of the home root.
    let real: string;
    try {
      real = await realpath(resolved);
    } catch {
      return reply.code(404).send({ error: "file not found" });
    }
    if (!isUnderHome(real)) {
      return reply.code(403).send({ error: "path is outside the home directory" });
    }
    let size: number;
    try {
      size = (await stat(real)).size;
    } catch {
      return reply.code(404).send({ error: "file not found" });
    }
    if (size > MAX_BYTES) {
      return reply.code(413).send({ error: "file exceeds the 10 MB size limit" });
    }
    let content: Buffer;
    try {
      content = await readFile(real);
    } catch {
      return reply.code(404).send({ error: "file not found" });
    }
    reply.header("content-type", "text/html; charset=utf-8");
    reply.header("x-content-type-options", "nosniff");
    return content;
  });
}

function isUnderHome(candidate: string): boolean {
  return candidate === HOME_ROOT || candidate.startsWith(HOME_ROOT + path.sep);
}
