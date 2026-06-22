#!/usr/bin/env bash
# Downloads the full mlx-community/Qwen3.5-0.8B-4bit repo snapshot into
# Models/Qwen3.5-0.8B-4bit/ (gitignored) so the weights can be BUNDLED into the
# iOS .app at build time — the app never downloads the model at runtime.
#
# MLX loads a model from a local directory and needs config.json + the
# *.safetensors + the tokenizer files all sitting side by side, so we fetch the
# entire repo snapshot (config.json, *.safetensors, tokenizer.json,
# tokenizer_config.json, special_tokens_map.json, generation_config.json,
# preprocessor_config.json, chat_template.*, etc.).
#
# Idempotent: if the destination already has config.json + at least one
# .safetensors it is considered present and the download is skipped.
set -euo pipefail

REPO="mlx-community/Qwen3.5-0.8B-4bit"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HERE/Models/Qwen3.5-0.8B-4bit"

have_model() {
  [ -f "$DEST/config.json" ] && compgen -G "$DEST/*.safetensors" >/dev/null 2>&1
}

if have_model; then
  echo "Model already present in $DEST — skipping download."
  exit 0
fi

mkdir -p "$DEST"

# Prefer the official Hugging Face CLI (handles the full snapshot + resume).
HF_BIN=""
if command -v hf >/dev/null 2>&1; then
  HF_BIN="hf"
elif command -v huggingface-cli >/dev/null 2>&1; then
  HF_BIN="huggingface-cli"
fi

if [ -n "$HF_BIN" ]; then
  echo "Downloading $REPO via $HF_BIN into $DEST"
  # --local-dir places real files (not a cache symlink farm) so the folder
  # reference Xcode copies into the .app contains the actual weights.
  if [ "$HF_BIN" = "hf" ]; then
    hf download "$REPO" --local-dir "$DEST"
  else
    huggingface-cli download "$REPO" --local-dir "$DEST"
  fi
else
  # Fallback: pull the file list from the HF API and curl each from the
  # resolve/main endpoint. No HF CLI required.
  echo "No hf CLI found — falling back to curl from the HF resolve API."
  FILES=$(curl -fsSL "https://huggingface.co/api/models/$REPO" \
    | /usr/bin/python3 -c "import json,sys;print('\n'.join(f['rfilename'] for f in json.load(sys.stdin)['siblings']))")
  if [ -z "$FILES" ]; then
    echo "Could not list files for $REPO" >&2
    exit 1
  fi
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    out="$DEST/$f"
    mkdir -p "$(dirname "$out")"
    echo "  $f"
    curl -fsSL "https://huggingface.co/$REPO/resolve/main/$f?download=true" -o "$out"
  done <<< "$FILES"
fi

# Strip the HF metadata cache dir if hf created one — we only want the model files.
rm -rf "$DEST/.cache"

if ! have_model; then
  echo "Download finished but $DEST is missing config.json or *.safetensors" >&2
  exit 1
fi

echo "Model ready in $DEST"
ls -lh "$DEST"
