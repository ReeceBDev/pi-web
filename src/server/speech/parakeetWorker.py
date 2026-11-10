#!/usr/bin/env python3
"""Parakeet transcription worker for PI WEB voice dictation.

Reads JSON-line requests on stdin and writes JSON-line responses on stdout.
The model loads once; the process stays resident until an idle timeout.

Requests:
  {"type": "ping"}
  {"type": "transcribe", "id": 1, "pcm": "<base64 PCM16 little-endian mono audio>"}

Responses:
  {"type": "pong"}
  {"id": 1, "text": "..."}
  {"id": 1, "error": "..."}

Environment:
  PARAKEET_MODEL_DIR   directory holding the ONNX model files (required)
  PARAKEET_KIND        onnx-asr model kind (default "nemo-parakeet-tdt-0.6b-v2")
  PARAKEET_QUANTIZATION onnx-asr quantization, e.g. "int8" (optional)
  PARAKEET_IDLE_SECONDS exit after this many seconds without requests (default 600, 0 disables)
"""

import base64
import json
import os
import sys
import time

IDLE_SECONDS = float(os.environ.get("PARAKEET_IDLE_SECONDS", "600"))


def fail(message):
    print(json.dumps({"error": message}), flush=True)
    sys.exit(1)


def main():
    try:
        import numpy as np
        import onnx_asr
    except ImportError as error:
        fail(f"missing dependency: {error}")

    model_dir = os.environ.get("PARAKEET_MODEL_DIR")
    if not model_dir:
        fail("PARAKEET_MODEL_DIR is not set")
    kind = os.environ.get("PARAKEET_KIND", "nemo-parakeet-tdt-0.6b-v2")
    quantization = os.environ.get("PARAKEET_QUANTIZATION")
    try:
        if quantization:
            model = onnx_asr.load_model(kind, path=model_dir, quantization=quantization)
        else:
            model = onnx_asr.load_model(kind, path=model_dir)
    except Exception as error:  # noqa: BLE001 - reported to the host verbatim
        fail(f"model load failed: {error}")

    last_request = time.monotonic()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if IDLE_SECONDS > 0 and time.monotonic() - last_request > IDLE_SECONDS:
            break
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        last_request = time.monotonic()
        if request.get("type") == "ping":
            print(json.dumps({"type": "pong"}), flush=True)
            continue
        request_id = request.get("id")
        try:
            pcm = np.frombuffer(base64.b64decode(request.get("pcm", "")), dtype=np.int16)
            audio = pcm.astype(np.float32) / 32768.0
            if audio.size == 0:
                text = ""
            else:
                text = str(model.recognize(audio)).strip()
            print(json.dumps({"id": request_id, "text": text}), flush=True)
        except Exception as error:  # noqa: BLE001 - keep the worker alive on bad audio
            print(json.dumps({"id": request_id, "error": f"transcribe failed: {error}"}), flush=True)


if __name__ == "__main__":
    main()
