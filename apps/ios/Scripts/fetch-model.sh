#!/usr/bin/env bash
# Downloads the pinned MobileCLIP-S0 Core ML package, verifies its SHA-256
# against Resources/model-manifest.json, and unzips it into Models/ (gitignored).
#
# NOTE: model-manifest.json currently ships PLACEHOLDER url + sha256. Replace both
# with the real pinned artifact values before running this for real; the checksum
# step below will (correctly) fail until the sha256 matches the downloaded file.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$HERE/Sources/AccountingHelper/Resources/model-manifest.json"
DEST="$HERE/Models"
mkdir -p "$DEST"

URL=$(/usr/bin/python3 -c "import json;print(json.load(open('$MANIFEST'))['url'])")
WANT=$(/usr/bin/python3 -c "import json;print(json.load(open('$MANIFEST'))['sha256'])")
TMP="$(mktemp -d)"
ZIP="$TMP/model.zip"

echo "Downloading $URL"
curl -fsSL "$URL" -o "$ZIP"
GOT=$(shasum -a 256 "$ZIP" | awk '{print $1}')
if [ "$GOT" != "$WANT" ]; then
  echo "checksum mismatch: want $WANT got $GOT" >&2
  exit 1
fi
echo "Unzipping into $DEST"
unzip -oq "$ZIP" -d "$DEST"
rm -rf "$TMP"
echo "Model ready in $DEST"
