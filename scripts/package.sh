#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('${ROOT_DIR}/manifest.json').version")"
OUTPUT_DIR="${ROOT_DIR}/releases"
ARCHIVE="${OUTPUT_DIR}/x-translator-v${VERSION}.zip"

FILES=(
  manifest.json
  background.js
  content.css
  content.js
  popup.css
  popup.html
  popup.js
  shared.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
)

mkdir -p "${OUTPUT_DIR}"
rm -f "${ARCHIVE}"

(
  cd "${ROOT_DIR}"
  zip -q -X "${ARCHIVE}" "${FILES[@]}"
)

echo "Created ${ARCHIVE}"
