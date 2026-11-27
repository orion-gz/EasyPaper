@echo off
setlocal enabledelayedexpansion

set "REPO_ROOT=%~dp0..\.."

REM frontend\dist\index.html이 참조하는 자산 파일이 실제로 dist\assets\에 없으면
REM (예: 과거 자동 업데이트가 git pull만 하고 npm run build를 건너뛰어 index.html은
REM 새 자산 해시를 가리키는데 실제 파일은 재생성되지 않은 경우) 화면이 깨진 채로
REM 뜬다. 매번 재시작할 때마다 자동으로 다시 빌드해 스스로 복구하도록 한다.
for /f "usebackq delims=" %%R in (`powershell -NoProfile -Command ^
    "$idx = Join-Path '%REPO_ROOT%' 'frontend\dist\index.html'; " ^
    "if (-not (Test-Path $idx)) { 'BUILD'; exit }; " ^
    "$missing = $false; " ^
    "(Select-String -Path $idx -Pattern '\x22(/assets/[^\x22]+\.(js|css))\x22' -AllMatches).Matches | ForEach-Object { " ^
    "  $p = Join-Path '%REPO_ROOT%' ('frontend\dist' + $_.Groups[1].Value.Replace('/', '\')); " ^
    "  if (-not (Test-Path $p)) { $missing = $true } " ^
    "}; " ^
    "if ($missing) { 'BUILD' } else { 'OK' }"`) do set "BUILD_CHECK_RESULT=%%R"

if "%BUILD_CHECK_RESULT%"=="BUILD" (
    echo Warning: frontend build output is missing or out of date, rebuilding...
    pushd "%REPO_ROOT%\frontend"
    if exist package-lock.json (
        call npm ci
    ) else (
        call npm install
    )
    call npm run build
    git -C "%REPO_ROOT%" rev-parse HEAD > dist\.build-commit 2>nul
    popd
)

cd /d "%~dp0..\..\backend"

if not exist ".venv" (
    echo Error: Python virtual environment not found. Please run scripts\bat\setup.bat first.
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo Warning: .env file not found, starting with defaults.
)

.venv\Scripts\python.exe main.py

if errorlevel 1 (
    echo.
    echo EasyPaper exited with an error. See the message above.
    echo.
    pause
)
