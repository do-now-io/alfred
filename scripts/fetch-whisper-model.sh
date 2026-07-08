#!/bin/bash
# Fetch the Whisper `small` model into src-tauri/models/ so it gets bundled
# into the app at build time (tauri.conf.json -> bundle.resources, spec/04).
# Idempotent: skips the download if the file already exists.
set -e

SIZE="${1:-small}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src-tauri/models"
FILE="$DIR/ggml-$SIZE.bin"
URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$SIZE.bin"

mkdir -p "$DIR"

if [ -f "$FILE" ]; then
  echo "✓ Model already present: $FILE"
  exit 0
fi

echo "Downloading Whisper model '$SIZE' -> $FILE"
curl -L --fail -o "$FILE.part" "$URL"
mv "$FILE.part" "$FILE"
echo "✓ Downloaded: $FILE"
