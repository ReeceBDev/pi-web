import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface SpeechWorkerConfig {
  /** Python interpreter with onnx-asr installed. */
  python: string;
  /** Directory holding the Parakeet ONNX model files. */
  modelDir: string;
  /** onnx-asr model kind; defaults to "nemo-parakeet-tdt-0.6b-v2". */
  model?: string;
  /** onnx-asr quantization, e.g. "int8". */
  quantization?: string;
}

export interface SpeechWorker {
  /** Transcribe PCM16 little-endian mono audio; resolves with the text. */
  transcribe(pcm: Buffer): Promise<string>;
  /** Health probe used to warm the model after a session opens. */
  ping(): Promise<void>;
  stop(): void;
}

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

const WORKER_IDLE_EXIT_SECONDS = 600;

/**
 * Owns one resident Python transcription process. Requests are serialized in
 * request order; the model is single-threaded anyway. The process respawns on
 * the next request after an exit or crash.
 *
 * ponytail: one global worker per web/API process, no per-machine fan-out.
 * If dictation load ever matters, pool workers per NUMA/CPU budget.
 */
export function createSpeechWorker(config: SpeechWorkerConfig, workerScriptPath = defaultWorkerPath()): SpeechWorker {
  let child: ChildProcessWithoutNullStreams | undefined;
  let nextId = 1;
  let starting: Promise<void> | undefined;
  const pending = new Map<number, PendingRequest>();

  const spawnWorker = (): ChildProcessWithoutNullStreams => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PARAKEET_MODEL_DIR: config.modelDir,
      ...(config.model === undefined ? {} : { PARAKEET_KIND: config.model }),
      ...(config.quantization === undefined ? {} : { PARAKEET_QUANTIZATION: config.quantization }),
      PARAKEET_IDLE_SECONDS: String(WORKER_IDLE_EXIT_SECONDS),
    };
    const spawned = spawn(config.python, [workerScriptPath], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    spawned.stderr.setEncoding("utf8");
    let bufferedStderr = "";
    spawned.stderr.on("data", (chunk: string) => {
      bufferedStderr = `${bufferedStderr}${chunk}`.slice(-4000);
    });
    const exit = (code: number | null, signal: NodeJS.Signals | null) => {
      const lastStderrLine = bufferedStderr.trim().split("\n").at(-1) ?? "";
      const detail = lastStderrLine === "" ? "" : `: ${lastStderrLine}`;
      const error = new Error(`speech worker exited (code ${String(code)} signal ${String(signal)})${detail}`);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      if (child === spawned) {
        child = undefined;
        starting = undefined;
      }
    };
    spawned.on("exit", exit);
    const lines = createInterface({ input: spawned.stdout });
    lines.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(parsed)) return;
      if (parsed["type"] === "pong") {
        startingResolve();
        return;
      }
      const id = parsed["id"];
      const errorText = parsed["error"];
      if (typeof id !== "number") {
        // An id-less error before any request exists is a startup failure.
        if (typeof errorText === "string" && errorText !== "") startingReject(new Error(errorText));
        return;
      }
      const waiter = pending.get(id);
      if (waiter === undefined) return;
      pending.delete(id);
      if (typeof errorText === "string" && errorText !== "") waiter.reject(new Error(errorText));
      else waiter.resolve(typeof parsed["text"] === "string" ? parsed["text"] : "");
    });
    return spawned;
  };

  let resolveStarting: (() => void) | undefined;
  let rejectStarting: ((error: Error) => void) | undefined;
  const startingResolve = () => {
    resolveStarting?.();
    resolveStarting = undefined;
    rejectStarting = undefined;
  };
  const startingReject = (error: Error) => {
    rejectStarting?.(error);
    resolveStarting = undefined;
    rejectStarting = undefined;
  };

  const ensureStarted = (): Promise<void> => {
    if (child !== undefined && starting === undefined) return Promise.resolve();
    if (starting !== undefined) return starting;
    const spawned = spawnWorker();
    child = spawned;
    starting = new Promise<void>((resolve, reject) => {
      resolveStarting = resolve;
      rejectStarting = reject;
      spawned.once("exit", () => { reject(new Error("speech worker exited during startup")); });
    });
    // The warmup ping makes the worker load and verify the model now, before
    // the first transcribe request needs it. The pong handler resolves `starting`.
    spawned.stdin.write(`${JSON.stringify({ type: "ping" })}\n`, () => { /* errors surface via exit */ });
    return starting;
  };

  const request = (payload: Record<string, unknown>, current: ChildProcessWithoutNullStreams): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      current.stdin.write(`${JSON.stringify({ ...payload, id })}\n`, (writeError) => {
        if (writeError) {
          pending.delete(id);
          reject(writeError);
        }
      });
    });
  };

  return {
    async transcribe(pcm: Buffer): Promise<string> {
      await ensureStarted();
      if (child === undefined) throw new Error("speech worker is not running");
      return request({ type: "transcribe", pcm: pcm.toString("base64") }, child);
    },
    async ping(): Promise<void> {
      await ensureStarted();
      if (child === undefined) throw new Error("speech worker is not running");
      await request({ type: "ping" }, child);
    },
    stop(): void {
      const current = child;
      child = undefined;
      starting = undefined;
      startingResolve();
      for (const waiter of pending.values()) waiter.reject(new Error("speech worker stopped"));
      pending.clear();
      current?.kill();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultWorkerPath(): string {
  // Runs beside the compiled client file; scripts/copy-server-assets.mjs copies
  // the Python source next to it in dist.
  return join(dirname(fileURLToPath(import.meta.url)), "parakeetWorker.py");
}
