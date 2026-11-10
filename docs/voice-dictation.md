# Voice dictation

Dictate into the pi-web chat editor: press the mic button (bottom-right, where the
attachment button was; the attachment button moved left of the send button), speak,
and a live transcript appears in the editor. Press the mic again to send the
transcript, or use the red cancel square beside it to discard and restore the
prior draft.

## Setup

Run `scripts/setup-speech.sh` once. It creates a Python venv, downloads the
Parakeet TDT 0.6B v2 int8 ONNX model (~700 MB), verifies the stack, and prints
the config snippet. Then add to the PI WEB config (`config.json`; by default
`~/.pi-web/config.json`) and restart the web/API process:

```json
"speech": {
  "python": "~/.pi-web/speech/venv/bin/python",
  "modelDir": "~/.pi-web/speech/model",
  "quantization": "int8"
}
```

`python` and `modelDir` are required; `model` (onnx-asr model kind, default
`nemo-parakeet-tdt-0.6b-v2`) and `quantization` are optional. When unset, the
speech routes answer `503` with the setup hint, and the mic button shows a hint
instead of recording.

## How streaming works

1. The browser captures audio with an AudioWorklet (`speech-capture`), converts
   to 16 kHz mono PCM16, and POSTs 500 ms chunks to the server while recording.
2. The server (`src/server/speech/speechRoutes.ts`) buffers chunks in a session
   and splits them at silences (0.7 s) or every 15 s max
   (`speechChunker.ts`), so the recognizer sees natural utterance boundaries.
3. Each chunk goes over stdio (JSON lines) to a resident Python worker
   (`parakeetWorker.py`) running onnx-asr; the worker stays warm between
   sessions and exits after 10 minutes idle. Chunk transcripts stream back as
   the partial transcript shown in the editor.
4. On finish, remaining audio is flushed, all chunk texts are committed in
   order, and the final transcript replaces the partials.

Sessions are in-memory only (audio never touches disk) and expire after 5
minutes of inactivity.

## HTTP API

- `POST /api/speech/sessions` — start a session, returns `{ id }`.
- `POST /api/speech/sessions/:id/audio` — request body is raw PCM16 16 kHz mono
  (`application/octet-stream`); response streams committed chunk texts so far.
- `POST /api/speech/sessions/:id/finish` — flush and return the final transcript.
- `DELETE /api/speech/sessions/:id` — discard a session.

## Limitations

- Dictation runs on the machine serving the web/API (the model needs ~0.9 GB
  RAM and CPU only); remote-machine dictation is not supported in v1.
- Partial transcripts update at chunk granularity (at silences or every 15 s),
  not word-by-word.
- Clips over ~30 s rely on chunking; quality may drift on very long single takes.
- Chrome is recommended; other browsers' AudioWorklet support varies.
