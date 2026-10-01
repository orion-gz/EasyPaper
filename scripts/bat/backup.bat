@echo off
setlocal
cd /d "%~dp0..\.."
if exist "backend\.venv\Scripts\python.exe" (
    set "BACKUP_PYTHON=backend\.venv\Scripts\python.exe"
) else (
    set "BACKUP_PYTHON=python"
)
"%BACKUP_PYTHON%" scripts\backup_data.py --format zip %*
exit /b %errorlevel%
