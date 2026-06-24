#!/bin/bash
# EasyPaper Setup & Installation Script

set -e

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
cd ..

echo "========================================="
echo "✅ EasyPaper Setup Complete!"
echo "========================================="
echo "To start the development servers concurrently, run:"
echo "   ./start-dev.sh"
echo ""
echo "To run the production-ready FastAPI server serving both frontend & backend, run:"
echo "   cd backend && .venv/bin/python main.py"
echo "   Then open: http://localhost:8000"
echo "========================================="
