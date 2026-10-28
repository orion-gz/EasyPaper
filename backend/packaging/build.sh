#!/usr/bin/env bash
# Linux/macOS용 sidecar 바이너리 빌드 스크립트.
# 사전조건: backend/에서 python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pyinstaller
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BACKEND_DIR/.." && pwd)"

PYINSTALLER="${PYINSTALLER:-pyinstaller}"

cd "$BACKEND_DIR"
"$PYINSTALLER" \
  "$SCRIPT_DIR/easypaper-backend.spec" \
  --distpath "$SCRIPT_DIR/dist" \
  --workpath "$SCRIPT_DIR/build" \
  --noconfirm

"$SCRIPT_DIR/dist/easypaper-backend/easypaper-backend" --easypaper-check-parser-stdlib

echo "Built: $SCRIPT_DIR/dist/easypaper-backend/"
