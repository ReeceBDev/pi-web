import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PiWebConfigService } from "../configRoutes.js";
import { createSpeechChunker, type SpeechChunker } from "./speechChunker.js";
import { createSpeechWorker, type SpeechWorkerConfig, type SpeechWorker } from "./speechWorkerClient.js";

export interface SpeechRouteOptions {
  config?: PiWebConfigService;
  /** Test seam: build the worker client instead of spawning Python. */
  createWorker?: (config: SpeechWorkerConfig) => SpeechWorker;
  /** Test seam: wall-clock for session expiry. */
  now?: () => number;
}

interface SpeechSession {
  id: string;
  chunker: SpeechChunker;
  /** Committed transcript from finished chunks, in order. */
  committed: string;
  /** Resolves once every submitted chunk has finished (success or failure). */
  completion: Promise<void>;
  /** Chunks submitted but not yet finished. */
  outstanding: number;
  lastUsed: number;
}

const SESSION_TTL_MS = 5 * 60 * 1000;
const SAMPLE_RATE = 16000;

export function registerSpeechRoutes(app: FastifyInstance, options: SpeechRouteOptions = {}): void {
  const sessions = new Map<string, SpeechSession>();
  const sessionWorkers = new Map<SpeechSession, SpeechWorker>();
  let sharedWorker: SpeechWorker | undefined;
  const now = options.now ?? Date.now;
  const createWorker = options.createWorker ?? ((config: SpeechWorkerConfig) => createSpeechWorker(config));

  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  }

  const readSpeechConfig = async (): Promise<SpeechWorkerConfig | undefined> => {
    const effective = options.config === undefined ? {} : (await options.config.read()).effectiveConfig;
    const speech = effective.speech;
    const python = speech?.python;
    const modelDir = speech?.modelDir;
    if (python === undefined || python === "" || modelDir === undefined || modelDir === "") return undefined;
    return {
      python,
      modelDir,
      ...(speech?.model === undefined ? {} : { model: speech.model }),
      ...(speech?.quantization === undefined ? {} : { quantization: speech.quantization }),
    };
  };

  const notConfigured = (reply: { code: (code: number) => { send: (body: unknown) => unknown } }): unknown => {
    return reply.code(503).send({ error: "Voice dictation is not configured: set speech.python and speech.modelDir in the PI WEB config, then run scripts/setup-speech.sh." });
  };

  const submitChunk = (session: SpeechSession, worker: SpeechWorker, chunk: Buffer): void => {
    session.outstanding += 1;
    const finished = session.completion.then(async () => {
      try {
        const text = await worker.transcribe(chunk);
        if (text !== "") {
          session.committed = session.committed === "" ? text : `${session.committed} ${text}`;
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        session.committed = session.committed === "" ? `[transcription failed: ${detail}]` : `${session.committed} [transcription failed: ${detail}]`;
      } finally {
        session.outstanding -= 1;
      }
    });
    session.completion = finished;
  };

  const sweepSessions = (): void => {
    const cutoff = now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (session.lastUsed < cutoff && session.outstanding === 0) sessions.delete(id);
    }
  };

  app.post("/api/speech/sessions", async (_request, reply) => {
    sweepSessions();
    const workerConfig = await readSpeechConfig();
    if (workerConfig === undefined) return notConfigured(reply);
    // One worker process serves every session: the model is single-threaded
    // and resident, so a second instance would only double the RAM.
    sharedWorker ??= createWorker(workerConfig);
    void sharedWorker.ping().catch(() => { /* warm the model; transcribe errors surface per chunk */ });
    const session: SpeechSession = {
      id: randomUUID(),
      chunker: createSpeechChunker({ sampleRate: SAMPLE_RATE }),
      committed: "",
      completion: Promise.resolve(),
      outstanding: 0,
      lastUsed: now(),
    };
    sessionWorkers.set(session, sharedWorker);
    sessions.set(session.id, session);
    return reply.code(201).send({ id: session.id });
  });

  app.post<{ Params: { id: string } }>("/api/speech/sessions/:id/audio", async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (session === undefined) return reply.code(404).send({ error: "Unknown speech session" });
    session.lastUsed = now();
    const pcm = request.body;
    if (!Buffer.isBuffer(pcm) || pcm.length === 0) return reply.code(400).send({ error: "Expected a non-empty application/octet-stream PCM16 body" });
    const worker = sessionWorkers.get(session);
    if (worker === undefined) return reply.code(404).send({ error: "Unknown speech session" });
    for (const chunk of session.chunker.append(pcm)) submitChunk(session, worker, chunk);
    return { text: session.committed };
  });

  app.post<{ Params: { id: string } }>("/api/speech/sessions/:id/finish", async (request, reply) => {
    const session = sessions.get(request.params.id);
    if (session === undefined) return reply.code(404).send({ error: "Unknown speech session" });
    const worker = sessionWorkers.get(session);
    if (worker === undefined) return reply.code(404).send({ error: "Unknown speech session" });
    const rest = session.chunker.flush();
    if (rest !== null) submitChunk(session, worker, rest);
    await session.completion;
    sessions.delete(session.id);
    sessionWorkers.delete(session);
    return { text: session.committed };
  });

  app.delete<{ Params: { id: string } }>("/api/speech/sessions/:id", (request) => {
    sessions.delete(request.params.id);
    return Promise.resolve({ ok: true });
  });

  const sweepTimer = setInterval(sweepSessions, 60 * 1000);
  sweepTimer.unref();
  app.addHook("onClose", () => {
    clearInterval(sweepTimer);
    if (sharedWorker !== undefined) sharedWorker.stop();
  });
}
