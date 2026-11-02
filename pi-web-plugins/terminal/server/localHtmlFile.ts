import { readFile, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// ponytail: near-copy of src/server/localHtmlFileRoutes.ts — plugin packages
// may not import PI WEB server internals (pluginPublicApi rule), and the
// terminal peer runs in sessiond while the endpoint runs in the web app, so
// the read core lives here too. Keep the two checks in sync; a shared package
// is the upgrade path if a third consumer appears.

// ponytail: 2 MiB raw cap — the result travels as one JSON peer-request
// response (8 MiB envelope, escaping inflates HTML ~2×); raise only with a
// chunked transport.
const MAX_BYTES = 2 * 1024 * 1024;

const HOME_ROOT = homedir();
const HTML_FILE_PATTERN = /\.html?$/iu;

export interface LocalHtmlFileResult {
  /** HTTP-style status for callers that surface one (endpoint parity). */
  readonly status: 200 | 400 | 403 | 404 | 413;
  readonly error?: string;
  readonly content?: string;
}

/** Reads one home-confined .html/.htm file for the read-local-html peer operation. */
export async function readLocalHtmlFile(requested: string, maxBytes = MAX_BYTES): Promise<LocalHtmlFileResult> {
  if (!HTML_FILE_PATTERN.test(requested)) {
    return { status: 400, error: "only .html and .htm files are served" };
  }
  const resolved = path.resolve(requested);
  if (!isUnderHome(resolved)) {
    return { status: 403, error: "path is outside the home directory" };
  }
  // Resolve symlinks so a link can not smuggle a path out of the home root.
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    return { status: 404, error: "file not found" };
  }
  if (!isUnderHome(real)) {
    return { status: 403, error: "path is outside the home directory" };
  }
  let size: number;
  try {
    size = (await stat(real)).size;
  } catch {
    return { status: 404, error: "file not found" };
  }
  if (size > maxBytes) {
    return { status: 413, error: "file exceeds the read size limit" };
  }
  try {
    return { status: 200, content: await readFile(real, "utf8") };
  } catch {
    return { status: 404, error: "file not found" };
  }
}

function isUnderHome(candidate: string): boolean {
  return candidate === HOME_ROOT || candidate.startsWith(HOME_ROOT + path.sep);
}
