/**
 * Streams raw PCM16 mono audio into transcription-sized chunks for an offline
 * ASR model (Parakeet TDT handles roughly 20-30 s per pass). A chunk closes on
 * a trailing silence gap or the maximum length, whichever comes first.
 *
 * ponytail: fixed RMS silence threshold tuned for normal dictation gain.
 * If quiet mics miss splits, track a rolling noise floor instead.
 */

export interface SpeechChunkerOptions {
  /** Sample rate of the PCM stream, e.g. 16000. */
  sampleRate: number;
  /** Close a chunk after this many seconds of audio even without silence. */
  maxChunkSeconds?: number;
  /** Close a chunk after this many seconds of continuous silence. */
  silenceSeconds?: number;
  /** RMS level (linear, 0-1) below which a 30 ms frame counts as silence. */
  silenceRms?: number;
}

const FRAME_SECONDS = 0.03;

export interface SpeechChunker {
  /** Append PCM16 little-endian audio; returns complete chunk buffers in order. */
  append(pcm: Buffer): Buffer[];
  /** Return any held audio as a final chunk (null when nothing is held). */
  flush(): Buffer | null;
}

export function createSpeechChunker(options: SpeechChunkerOptions): SpeechChunker {
  const maxChunkBytes = Math.round((options.maxChunkSeconds ?? 15) * options.sampleRate) * 2;
  const silenceFrameCount = Math.round((options.silenceSeconds ?? 0.7) / FRAME_SECONDS);
  const silenceRms = options.silenceRms ?? 0.006;
  const frameSamples = Math.max(1, Math.round(options.sampleRate * FRAME_SECONDS));

  let held: Buffer[] = [];
  let heldBytes = 0;
  let silentFrames = 0;
  let sawSound = false;

  const pushFrames = (pcm: Buffer): Buffer[] => {
    const closed: Buffer[] = [];
    for (let offset = 0; offset + 1 < pcm.length; offset += frameSamples * 2) {
      const end = Math.min(offset + frameSamples * 2, pcm.length);
      const frame = pcm.subarray(offset, end);
      held.push(Buffer.from(frame));
      heldBytes += frame.length;
      if (frameRms(frame) >= silenceRms) {
        silentFrames = 0;
        sawSound = true;
      } else {
        silentFrames += 1;
      }
      const reachedSilence = sawSound && silentFrames >= silenceFrameCount;
      const reachedMax = heldBytes >= maxChunkBytes;
      if (reachedSilence || reachedMax) {
        closed.push(Buffer.concat(held));
        held = [];
        heldBytes = 0;
        silentFrames = 0;
        sawSound = false;
      }
    }
    return closed;
  };

  return {
    append(pcm: Buffer): Buffer[] {
      // Keep the chunker's internal state byte-aligned to 16-bit samples across appends.
      if (heldBytes % 2 !== 0 && held.length > 0) {
        const tail = held.pop();
        if (tail !== undefined && tail.length > 1) {
          held.push(tail.subarray(0, tail.length - 1));
          heldBytes -= 1;
          pcm = Buffer.concat([Buffer.from(tail.subarray(tail.length - 1)), pcm]);
        }
      }
      return pushFrames(pcm);
    },
    flush(): Buffer | null {
      // A tail that never heard sound is trailing silence; transcribing it
      // would only add latency, so drop it.
      const rest = sawSound && heldBytes > 0 ? Buffer.concat(held) : null;
      held = [];
      heldBytes = 0;
      silentFrames = 0;
      sawSound = false;
      return rest;
    },
  };
}

function frameRms(frame: Buffer): number {
  let total = 0;
  let count = 0;
  for (let offset = 0; offset + 1 < frame.length; offset += 2) {
    const sample = frame.readInt16LE(offset) / 32768;
    total += sample * sample;
    count += 1;
  }
  return count === 0 ? 0 : Math.sqrt(total / count);
}
