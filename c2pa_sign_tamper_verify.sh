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

# Verification function
verify_file() {
  local file="$1"
  local label="$2"
  local output
  if output=$(docker run --rm -v "$(pwd)":/app -w /app "$DOCKER_IMAGE" \
      sh -c "c2patool \"$file\" trust --trust_anchors \"$TRUST_BUNDLE\"" 2>&1); then
    echo "$label|PASS|$output"
  else
    echo "$label|FAIL|$output"
  fi
}

# Tampering tests
cp "$SIGNED" tamper_append.jpg && echo "junk" >> tamper_append.jpg
dd if="$SIGNED" of=tamper_trunc.jpg bs=1 count=$(( $(stat -c%s "$SIGNED" 2>/dev/null || stat -f%z "$SIGNED") - 100 )) status=none || true
python3 - <<'PY'
from pathlib import Path
b=Path("signed_image.jpg").read_bytes()
i=200 if len(b)>400 else len(b)//2
Path("tamper_flip.jpg").write_bytes(b[:i]+bytes([b[i]^0xFF])+b[i+1:])
PY

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
    # show only the first meaningful line of the error
    echo "   ↳ $(echo "$msg" | head -n 1)"
  fi
done
echo "==============================================================="
echo "Full logs in $LOG"

