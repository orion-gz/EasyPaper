#!/bin/bash
# EasyPaper Production Server Start Script

set -e

echo "📡 EasyPaper 서버 시작 중..."

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# frontend/dist/index.html이 참조하는 자산 파일이 실제로 dist/assets/에 없으면
# (예: 과거 자동 업데이트가 git pull만 하고 npm run build를 건너뛰어 index.html은
# 새 자산 해시를 가리키는데 실제 파일은 재생성되지 않은 경우) 화면이 깨진 채로
# 뜬다. 매번 재시작할 때마다 자동으로 다시 빌드해 스스로 복구하도록 한다.
DIST_INDEX="$REPO_ROOT/frontend/dist/index.html"
NEEDS_BUILD=0
if [ ! -f "$DIST_INDEX" ]; then
    NEEDS_BUILD=1
else
    while IFS= read -r asset_path; do
        [ -f "$REPO_ROOT/frontend/dist${asset_path}" ] || NEEDS_BUILD=1
    done < <(grep -oE '"/assets/[^"]+\.(js|css)"' "$DIST_INDEX" | tr -d '"')
fi

if [ "$NEEDS_BUILD" = "1" ]; then
    echo "⚠️  프론트엔드 빌드 산출물이 없거나 최신 소스와 어긋나 다시 빌드합니다..."
    (cd "$REPO_ROOT/frontend" && (if [ -f package-lock.json ]; then npm ci; else npm install; fi) && npm run build)
    git -C "$REPO_ROOT" rev-parse HEAD > "$REPO_ROOT/frontend/dist/.build-commit" 2>/dev/null || true
fi

# Ensure we run from backend folder with .venv python (이 스크립트는 scripts/sh/ 하위에 있음)
cd "$(dirname "$0")/../../backend"

if [ ! -d ".venv" ]; then
    echo "❌ Error: Python 가상환경이 존재하지 않습니다. 먼저 './scripts/sh/setup.sh'를 실행해주세요."
    exit 1
fi

if [ ! -f ".env" ]; then
    echo "⚠️  Warning: .env 파일이 존재하지 않아 기본값으로 시작합니다."
fi

# Run backend which also serves the compiled frontend dist
exec .venv/bin/python main.py
