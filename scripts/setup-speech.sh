#!/usr/bin/env bash
# One-time setup for PI WEB voice dictation: Parakeet TDT 0.6B v2 (int8 ONNX) via onnx-asr.
# Creates a Python venv, downloads the int8 model, verifies the stack, and prints
# the config.json snippet to add. Idempotent: re-running skips existing parts.
set -euo pipefail

SPEECH_DIR="${PI_WEB_SPEECH_DIR:-$HOME/.pi-web/speech}"
VENV="$SPEECH_DIR/venv"
MODEL_DIR="$SPEECH_DIR/model"
REPO="istupakov/parakeet-tdt-0.6b-v2-onnx"

mkdir -p "$SPEECH_DIR"
if [ ! -x "$VENV/bin/pip" ]; then
  echo "Creating venv at $VENV ..."
  # --without-pip: ensurepip is missing on Debian without python3-venv; the host
  # pip's --python flag installs pip into the fresh venv instead.
  python3 -m venv --without-pip "$VENV"
  pip3 --python "$VENV/bin/python" install --quiet pip
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet "onnx-asr[cpu,hub]" numpy

if [ ! -f "$MODEL_DIR/encoder-model.int8.onnx" ]; then
  echo "Downloading Parakeet TDT 0.6B v2 int8 (~700 MB) from $REPO ..."
  "$VENV/bin/python" - "$MODEL_DIR" <<PYEOF
import sys
from huggingface_hub import snapshot_download
# int8 files only (fp32 encoder is ~2.4 GB and unused). local_dir downloads real
# files, not HF-cache symlinks; symlinks break onnxruntime external-data checks.
snapshot_download("$REPO", local_dir=sys.argv[1],
                  allow_patterns=["*int8.onnx", "vocab.txt", "config.json"])
PYEOF
fi

echo "Verifying the model loads and transcribes (~10 s, ~0.9 GB RAM) ..."
"$VENV/bin/python" - "$MODEL_DIR" <<PYEOF
import sys
import numpy as np
import onnx_asr
model = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v2", path=sys.argv[1], quantization="int8")
print("ok; silence transcribes to:", repr(str(model.recognize(np.zeros(16000, dtype=np.float32)))))
PYEOF

cat <<EOF

Setup complete. Add this to the PI WEB config (the config.json that PI_WEB_CONFIG
points at; by default ~/.pi-web/config.json), then restart the web/API process:

  "speech": {
    "python": "$VENV/bin/python",
    "modelDir": "$MODEL_DIR",
    "quantization": "int8"
  }

EOF
