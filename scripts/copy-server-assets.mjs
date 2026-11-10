#!/usr/bin/env node
// Copy non-TypeScript server runtime assets (the speech worker script) from src
// into dist after tsc, preserving their relative location for import.meta.url resolution.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = [
  ["src/server/speech/parakeetWorker.py", "dist/server/speech/parakeetWorker.py"],
];

for (const [source, target] of assets) {
  await mkdir(dirname(join(root, target)), { recursive: true });
  await copyFile(join(root, source), join(root, target));
}
