@echo off
REM Windows용 sidecar 바이너리 빌드 스크립트.
REM 사전조건: backend\ 에서 python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt pyinstaller
setlocal

set "SCRIPT_DIR=%~dp0"
set "BACKEND_DIR=%SCRIPT_DIR%.."

if "%PYINSTALLER%"=="" set "PYINSTALLER=pyinstaller"

cd /d "%BACKEND_DIR%"
"%PYINSTALLER%" ^
  "%SCRIPT_DIR%easypaper-backend.spec" ^
  --distpath "%SCRIPT_DIR%dist" ^
  --workpath "%SCRIPT_DIR%build" ^
  --noconfirm

if errorlevel 1 exit /b %errorlevel%

echo Built: %SCRIPT_DIR%dist\easypaper-backend\
