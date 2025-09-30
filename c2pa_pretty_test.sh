#!/usr/bin/env bash
set -euo pipefail

DOCKER_IMAGE="c2pa-demo"
SRC="wax_seal_c2pa.jpg"
SIGNED="signed_image.jpg"
MANIFEST="manifest.json"
TRUST_BUNDLE="C2PA-TRUST-BUNDLE.pem"
LOG="c2pa_log_$(date +%Y%m%d_%H%M%S).txt"

echo "Logging full output to $LOG"
exec > >(tee -a "$LOG") 2>&1

# Ensure docker image exists
if ! docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1; then
  echo "Building $DOCKER_IMAGE..."
  docker build -t "$DOCKER_IMAGE" .
fi

# Sign the base image
echo "Signing $SRC -> $SIGNED"
docker run --rm -v "$(pwd)":/app -w /app "$DOCKER_IMAGE" \
  sh -c "c2patool \"$SRC\" -m \"$MANIFEST\" -o \"$SIGNED\" -f trust --trust_anchors \"$TRUST_BUNDLE\""

# Verify file by parsing JSON validation_state
verify_file() {
  local file="$1"
  local label="$2"
  local tmp=$(mktemp)

  docker run --rm -v "$(pwd)":/app -w /app "$DOCKER_IMAGE" \
    sh -c "c2patool \"$file\" trust --trust_anchors \"$TRUST_BUNDLE\"" >"$tmp" 2>&1 || true

  # Extract validation_state from JSON
  local state
  state=$(grep -o '"validation_state": *"[^"]*"' "$tmp" | head -n1 | cut -d'"' -f4)

  if [ "$state" = "Trusted" ]; then
    echo "$label|PASS|$state"
  else
    # fall back to first error-like line if no state found
    local msg
    msg=$(grep -m1 -i "error\|fail\|invalid\|unexpected" "$tmp" || echo "Untrusted")
    echo "$label|FAIL|$msg"
  fi

  rm -f "$tmp"
}

# Tampering tests
# Robust Tampering tests
# ---------------------------

# 1) Recompress (re-encode) - simulates resave / recompress (keeps JPEG valid)
tap_recompress="tamper_recompress.jpg"
if command -v convert >/dev/null 2>&1; then
  echo "Creating recompressed image -> $tap_recompress"
  convert "$SIGNED" -quality 85 "$tap_recompress"
else
  echo "ImageMagick 'convert' not found; falling back to append-as-last-resort -> $tap_recompress"
  cp "$SIGNED" "$tap_recompress"
  # append a small benign payload so bytes change (may sometimes break signature but keep file readable)
  printf "%s" "RECOMPRESS_FALLBACK" >> "$tap_recompress"
fi

# 2) Gentle edit (crop 1px) - simulates a real edit (keeps file structurally valid)
tap_edit="tamper_edit.jpg"
if command -v convert >/dev/null 2>&1; then
  echo "Creating small-crop edit -> $tap_edit"
  # crop 1 pixel from right/bottom (no visible change for most images) to alter bytes but keep valid
  convert "$SIGNED" -gravity southeast -crop +1+1 +repage "$tap_edit"
else
  echo "ImageMagick 'convert' not found; fallback copying -> $tap_edit"
  cp "$SIGNED" "$tap_edit"
  # fallback: touch the file's bytes in the middle in a minimally invasive way (will still break hash)
  filesize=$(stat -f%z "$tap_edit" 2>/dev/null || stat -c%s "$tap_edit")
  start=$((filesize/2))
  # write 8 bytes of pattern without changing file size
  printf '\0\1\2\3\4\5\6\7' | dd of="$tap_edit" bs=1 seek="$start" conv=notrunc status=none || true
fi

# 3) Deterministic byte-overwrite (safe: avoids header/footer) - replaces previous fragile byteflip
tap_byteflip="tamper_byteoverwrite.jpg"
cp "$SIGNED" "$tap_byteflip"
filesize=$(stat -f%z "$tap_byteflip" 2>/dev/null || stat -c%s "$tap_byteflip")

# choose start roughly 1/3 into the file, leaving headers and footers intact
start=$((filesize / 3))
# ensure start is at least 1024 and at most filesize-1024 to avoid header/footer
if [ "$start" -lt 1024 ]; then start=1024; fi
if [ "$((start + 64))" -gt "$filesize" ]; then start=$((filesize / 2)); fi

# overwrite 10 bytes with zeros (not truncating) — keeps file readable but breaks the hash
dd if=/dev/zero of="$tap_byteflip" bs=1 count=10 seek="$start" conv=notrunc status=none || true

# register test files into the list (or into your existing test array)
tests+=("$tap_recompress:recompress")
tests+=("$tap_edit:smalledit")
tests+=("$tap_byteflip:byteoverwrite")

# Collect results
declare -a results
results+=("$(verify_file $SIGNED baseline)")
results+=("$(verify_file tamper_append.jpg append)")
results+=("$(verify_file tamper_trunc.jpg truncate)")
results+=("$(verify_file tamper_flip.jpg byteflip)")

# Pretty report
echo
echo "==================== 📋 Verification Report ===================="
for r in "${results[@]}"; do
  IFS="|" read -r label status msg <<< "$r"
  if [ "$status" = "PASS" ]; then
    echo "✅ $label → PASS"
  else
    echo "❌ $label → FAIL"
    echo "   ↳ $msg"
  fi
done
echo "==============================================================="
echo "Full logs in $LOG"

