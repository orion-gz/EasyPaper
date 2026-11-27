#!/bin/bash
# EasyPaper Setup & Installation Script

set -e

# 저장소 루트 기준으로 동작하도록 이동 (이 스크립트는 scripts/sh/ 하위에 있음)
cd "$(dirname "$0")/../.."

echo "========================================="
echo "⚙️  EasyPaper Auto Setup & Installation Script"
echo "========================================="

# 1. Setup Backend
echo "📡 1. Setting up Backend..."
cd backend
if [ ! -d ".venv" ]; then
    echo "   Creating Python virtual environment (.venv)..."
    python3 -m venv .venv
fi
echo "   Installing backend dependencies..."
.venv/bin/pip install -r requirements.txt

if [ ! -f ".env" ]; then
    echo "   Creating configuration file (.env from template)..."
    cp .env.example .env
fi
cd ..

# 2. Setup Frontend
echo "🌐 2. Setting up Frontend..."
cd frontend
echo "   Installing frontend dependencies (npm install)..."
npm install
echo "   Building frontend production assets..."
npm run build
git -C .. rev-parse HEAD > dist/.build-commit 2>/dev/null || true
cd ..

echo "========================================="
echo "✅ EasyPaper Setup Complete!"
echo "========================================="
echo "To start the development servers concurrently, run:"
echo "   ./scripts/sh/start-dev.sh"
echo ""
echo "To run the production-ready server serving both frontend & backend, run:"
echo "   ./scripts/sh/start.sh"
echo "   Then open: http://localhost:8000"
echo "========================================="
