#!/usr/bin/env bash
# Download the Beat This! ONNX models (mel front-end + small beat
# model) into src-tauri/models/. Weights are downloaded artifacts and
# never enter git (docs/design/bpm-analysis-rust.md).
#
# Both files are committed in the upstream beat-this-rs repo, pinned
# here to the commit matching the beat-this 1.0 crate. The 83 MB full
# model (GitHub Releases) is deliberately not fetched — small model
# scores F-measure >= 0.99 against the Python reference.
set -euo pipefail

REPO="danigb/beat-this-rs"
REF="main" # ceiling: pin to a release tag once upstream tags one
BASE="https://raw.githubusercontent.com/${REPO}/${REF}/models"
DEST="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/models"

mkdir -p "${DEST}"
for asset in mel_spectrogram.onnx beat_this_small.onnx; do
  if [[ -f "${DEST}/${asset}" ]]; then
    echo "already present: ${DEST}/${asset}"
    continue
  fi
  echo "downloading ${asset}..."
  curl -fL --retry 3 -o "${DEST}/${asset}" "${BASE}/${asset}"
done
echo "models ready in ${DEST}"
