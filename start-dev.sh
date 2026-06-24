#!/bin/bash
# EasyPaper 개발 서버 시작 스크립트

set -e

echo "🚀 EasyPaper 개발 서버 시작..."

# 백엔드 시작
echo "📡 FastAPI 백엔드 시작 중 (포트 8000)..."
cd "$(dirname "$0")/backend"
.venv/bin/python main.py &
BACKEND_PID=$!
echo "   백엔드 PID: $BACKEND_PID"

# 잠시 대기
sleep 2

# 프론트엔드 시작
echo "🌐 Vite 프론트엔드 시작 중 (포트 5173)..."
cd "$(dirname "$0")/frontend"
npm run dev &
FRONTEND_PID=$!
echo "   프론트엔드 PID: $FRONTEND_PID"

echo ""
echo "✅ EasyPaper 실행 중!"
echo "   프론트엔드: http://localhost:5173"
echo "   백엔드 API: http://localhost:8000"
echo "   API 문서:   http://localhost:8000/docs"
echo ""
echo "종료하려면 Ctrl+C를 누르세요."

# 종료 시 하위 프로세스 정리
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGINT SIGTERM

wait
