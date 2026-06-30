#!/bin/bash
# EasyPaper Clean up & Uninstall Script

set -e

echo "========================================="
echo "🧹 EasyPaper Uninstall & Clean up Script"
echo "========================================="

# 1. Stop and Remove systemd Service (if exists)
echo "⚙️  1. Checking systemd service..."
SERVICE_NAME="easypaper.service"
SYSTEMD_PATH="/etc/systemd/system/$SERVICE_NAME"

if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "   Stopping $SERVICE_NAME..."
    sudo systemctl stop "$SERVICE_NAME"
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    echo "   Disabling $SERVICE_NAME..."
    sudo systemctl disable "$SERVICE_NAME"
fi

if [ -f "$SYSTEMD_PATH" ]; then
    echo "   Removing systemd service file..."
    sudo rm -f "$SYSTEMD_PATH"
    echo "   Reloading systemd daemon..."
    sudo systemctl daemon-reload
    sudo systemctl reset-failed
fi

# 2. Clean up Backend environment
echo "📡 2. Cleaning up Backend..."
if [ -d "backend/.venv" ]; then
    echo "   Removing Python virtual environment (backend/.venv)..."
    rm -rf backend/.venv
fi

if [ -f "backend/.env" ]; then
    echo "   Removing configuration file (backend/.env)..."
    rm -f backend/.env
fi

# 3. Clean up Frontend environment
echo "🌐 3. Cleaning up Frontend..."
if [ -d "frontend/node_modules" ]; then
    echo "   Removing node_modules..."
    rm -rf frontend/node_modules
fi

if [ -d "frontend/dist" ]; then
    echo "   Removing production build assets (frontend/dist)..."
    rm -rf frontend/dist
fi

# 4. Prompt to clean up database & library data
echo "========================================="
read -p "❓ Do you want to delete all database and document data? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "💾 4. Deleting all database, uploads, and library files..."
    
    # Database
    if [ -f "backend/easypaper.db" ]; then
        echo "   Deleting SQLite database (backend/easypaper.db)..."
        rm -f backend/easypaper.db
    fi
    
    # Uploads & Library dirs
    DIRS_TO_REMOVE=("uploads" "library" "cache" "backend/uploads" "backend/cache")
    for dir in "${DIRS_TO_REMOVE[@]}"; do
        if [ -d "$dir" ]; then
            echo "   Removing directory: $dir..."
            rm -rf "$dir"
        fi
    done
else
    echo "💾 4. Retaining database and document files (uploads/, library/, easypaper.db)."
fi

echo "========================================="
echo "✨ EasyPaper Clean up Complete!"
echo "========================================="
