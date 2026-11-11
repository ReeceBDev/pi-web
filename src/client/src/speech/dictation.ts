import { resolveAppUrl } from "../appUrl";
import { HttpRequestError } from "../api/http";

export interface DictationEvents {
  /** Committed transcript so far (finished audio chunks, in order). */
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
}

export interface DictationController {
  /** Stop capturing, return the full transcript. */
  finish(): Promise<string>;
  /** Transcript committed so far; readable even when finish() fails. */
  committedText?(): string;
  /** Stop capturing and discard everything server-side. */
  cancel(): void;
}

const TARGET_SAMPLE_RATE = 16000;
const POST_INTERVAL_MS = 500;
const WORKLET_URL = "speech-capture-worklet.js";

/**
 * Browser half of voice dictation: captures mic audio as PCM16 mono at 16 kHz,
 * streams it to the speech session endpoints, and reports committed partials.
 *
 * ponytail: nearest-sample decimation of the worklet's native-rate frames;
 * swap in linear resampling in the worklet if capture crackle ever matters.
 */
export async function startDictation(events: DictationEvents = {}): Promise<DictationController> {
  const session = await requestJson("POST", "api/speech/sessions", parseSession);
  // Track the latest committed transcript so it stays deliverable if finish() fails.
  let committed = "";
  const trackedEvents: DictationEvents = {
    ...events,
    onPartial: (text) => { committed = text; events.onPartial?.(text); },
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    void discardSession(session.id);
    const micState = await microphonePermissionState();
    // console.error so any browser-error reporting that reaches the server
    // carries the raw exception, not just the friendly hint text.
    console.error("Dictation getUserMedia failed:", error, "microphone permission state:", micState);
    throw new Error(microphoneErrorMessage(error, micState), { cause: error });
  }

  const context = new AudioContext();
  await context.audioWorklet.addModule(resolveAppUrl(WORKLET_URL));
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "speech-capture");
  source.connect(node);
  // The capture node only pulls audio when wired toward a destination; mute it.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute);
  mute.connect(context.destination);

  let posting = Promise.resolve();
  let pending: Int16Array[] = [];
  let pendingSamples = 0;
  let stopped = false;

  node.port.onmessage = (event: MessageEvent) => {
    if (stopped) return;
    const frame: unknown = event.data;
    if (!(frame instanceof Float32Array) || frame.length === 0) return;
    const decimation = context.sampleRate / TARGET_SAMPLE_RATE;
    const samples = new Int16Array(Math.ceil(frame.length / decimation));
    for (let i = 0; i < samples.length; i += 1) {
      const value = frame[Math.min(Math.round(i * decimation), frame.length - 1)] ?? 0;
      samples[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    }
    pending.push(samples);
    pendingSamples += samples.length;
  };

  const flushTimer = setInterval(() => {
    if (stopped || pendingSamples === 0) return;
    const payload = int16BatchesToBuffer(pending, pendingSamples);
    pending = [];
    pendingSamples = 0;
    posting = postAudio(session.id, payload, trackedEvents);
  }, POST_INTERVAL_MS);

  const cleanup = () => {
    stopped = true;
    clearInterval(flushTimer);
    node.port.onmessage = null;
    node.disconnect();
    mute.disconnect();
    source.disconnect();
    context.close().catch(() => { /* closing an already-closed context is harmless */ });
    for (const track of stream.getTracks()) track.stop();
  };

  return {
    async finish(): Promise<string> {
      cleanup();
      // Wait for an in-flight audio post before closing the session server-side.
      await posting;
      const payload = int16BatchesToBuffer(pending, pendingSamples);
      pending = [];
      pendingSamples = 0;
      if (payload.byteLength > 0) {
        posting = postAudio(session.id, payload, trackedEvents);
      }
      const final = await requestJson("POST", `api/speech/sessions/${encodeURIComponent(session.id)}/finish`, parseText);
      return final.text;
    },
    committedText: () => committed,
    cancel(): void {
      cleanup();
      void discardSession(session.id);
    },
  };
}

function postAudio(sessionId: string, payload: ArrayBuffer, events: DictationEvents): Promise<void> {
  return fetch(resolveAppUrl(`api/speech/sessions/${encodeURIComponent(sessionId)}/audio`), {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: payload,
  }).then(async (response) => {
    if (!response.ok) throw await responseError(response);
    const body: unknown = await response.json();
    return body;
  }).then((body: unknown) => {
    if (isRecord(body) && typeof body["text"] === "string") {
      events.onPartial?.(body["text"]);
    }
  }).catch((error: unknown) => {
    events.onError?.(error instanceof Error ? error.message : String(error));
  });
}

function int16BatchesToBuffer(batches: Int16Array[], totalSamples: number): ArrayBuffer {
  const buffer = new ArrayBuffer(totalSamples * 2);
  const view = new Int16Array(buffer);
  let offset = 0;
  for (const batch of batches) {
    view.set(batch, offset);
    offset += batch.length;
  }
  return buffer;
}

async function requestJson<T>(method: string, path: string, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(resolveAppUrl(path), { method });
  if (!response.ok) throw await responseError(response);
  const parsed: unknown = await response.json();
  return parse(parsed);
}

function parseSession(value: unknown): { id: string } {
  if (!isRecord(value) || typeof value["id"] !== "string") throw new Error("Malformed speech session response");
  return { id: value["id"] };
}

function parseText(value: unknown): { text: string } {
  if (!isRecord(value) || typeof value["text"] !== "string") throw new Error("Malformed speech transcript response");
  return { text: value["text"] };
}

async function discardSession(id: string): Promise<void> {
  await fetch(resolveAppUrl(`api/speech/sessions/${encodeURIComponent(id)}`), { method: "DELETE" }).catch(() => { /* best-effort discard */ });
}

async function responseError(response: Response): Promise<Error> {
  const body: unknown = await response.json().catch(() => ({}));
  const message = isRecord(body) && typeof body["error"] === "string" ? body["error"] : response.statusText;
  return new HttpRequestError(message, response.status);
}

async function microphonePermissionState(): Promise<string> {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state;
  } catch {
    // Browsers without navigator.permissions (or without the microphone
    // name) throw — report the state as unavailable.
    return "unavailable";
  }
}

function microphoneErrorMessage(error: unknown, micState: string): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Microphone access was denied. Allow microphone permission for this site and try again.";
  if (error instanceof DOMException && error.name === "NotFoundError") return "No microphone was found on this device.";
  const name = error instanceof DOMException ? error.name : error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return `Could not start dictation: ${name}: ${message} (microphone permission: ${micState})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
