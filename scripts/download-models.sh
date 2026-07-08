#!/usr/bin/env bash
# Download the Beat This! ONNX models into src-tauri/models/. Weights
# are downloaded artifacts and never enter git
# (docs/design/bpm-analysis-rust.md). The mel front-end + small beat
# model are committed upstream and fetched from the raw branch; the
# full-accuracy FP32 beat model (beat_this.onnx, ~83 MB) lives on the
# `model-large` GitHub release and is opt-in via `--standard`.
#
# The GUI's "download analysis model" command fetches the same standard
# release asset (URL in crates/otori-analysis/src/models.rs) and
# sha256-verifies it against the release's .sha256 sidecar — this script
# is the CLI/offline counterpart and the source of the bundled small
# model for a fresh checkout.
set -euo pipefail

REPO="danigb/beat-this-rs"
REF="main" # ceiling: pin to a release tag once upstream tags one
BASE="https://raw.githubusercontent.com/${REPO}/${REF}/models"
STD_URL="https://github.com/${REPO}/releases/download/model-large/beat_this.onnx"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/models"

FETCH_STANDARD=0
[[ "${1:-}" == "--standard" ]] && FETCH_STANDARD=1

mkdir -p "${DEST}"
for asset in mel_spectrogram.onnx beat_this_small.onnx; do
  if [[ -f "${DEST}/${asset}" ]]; then
    echo "already present: ${DEST}/${asset}"
    continue
  fi
  echo "downloading ${asset}..."
  curl -fL --retry 3 -o "${DEST}/${asset}" "${BASE}/${asset}"
done

if [[ "$FETCH_STANDARD" -eq 1 ]]; then
  if [[ -f "${DEST}/beat_this.onnx" ]]; then
    echo "already present: ${DEST}/beat_this.onnx"
  else
    echo "downloading beat_this.onnx (full model, ~83 MB)..."
    curl -fL --retry 3 -o "${DEST}/beat_this.onnx" "${STD_URL}"
    # Verify against the release's .sha256 sidecar. `shasum -a 256` is
    # macOS; `sha256sum` is Linux + git-bash on Windows. Pick whichever
    # is on PATH so this runs on both CI runners.
    expected="$(curl -fsSL "${STD_URL}.sha256" | awk '{print $1}')"
    if command -v shasum >/dev/null 2>&1; then
      got="$(shasum -a 256 "${DEST}/beat_this.onnx" | awk '{print $1}')"
    else
      got="$(sha256sum "${DEST}/beat_this.onnx" | awk '{print $1}')"
    fi
    [[ "$expected" == "$got" ]] || { echo "sha256 mismatch: expected $expected, got $got" >&2; exit 1; }
    echo "verified: ${DEST}/beat_this.onnx"
  fi
fi

echo "models ready in ${DEST}"
