@echo off
setlocal enabledelayedexpansion

REM 저장소 루트 기준으로 동작하도록 이동 (이 스크립트는 scripts\bat\ 하위에 있음)
cd /d "%~dp0..\.."

echo =========================================
echo EasyPaper Auto Setup ^& Installation Script
echo =========================================

REM 1단계: 'python'이 PATH에서 바로 정상 동작하는지 확인.
REM Windows Store 앱 실행 별칭 스텁이면 실제로는 아무 것도 하지 않으므로 걸러낸다.
set "PYTHON_EXE="
where python 2>nul | findstr /i "WindowsApps" >nul
if errorlevel 1 (
    python --version >nul 2>nul
    if not errorlevel 1 set "PYTHON_EXE=python"
)

REM 2단계: bare 'python'을 못 쓰면, 더블클릭 실행 시 activate되지 않는 Miniforge,
REM Anaconda, Miniconda의 흔한 설치 경로들을 직접 찾아본다. 설치되어 있기만 하면
REM activate 여부와 무관하게 전체 경로로 바로 실행 가능하다.
if not defined PYTHON_EXE (
    echo    'python' 명령을 바로 쓸 수 없어 Miniforge/Anaconda/Miniconda 설치를 찾는 중...
    for %%P in (
        "%USERPROFILE%\miniforge3\python.exe"
        "%USERPROFILE%\anaconda3\python.exe"
        "%USERPROFILE%\miniconda3\python.exe"
        "%LOCALAPPDATA%\miniforge3\python.exe"
        "%PROGRAMDATA%\miniforge3\python.exe"
        "%PROGRAMDATA%\Anaconda3\python.exe"
        "%PROGRAMDATA%\Miniconda3\python.exe"
    ) do (
        if not defined PYTHON_EXE (
            if exist %%P (
                set "PYTHON_EXE=%%P"
                echo    Found: %%P
            )
        )
    )
)

if not defined PYTHON_EXE (
    echo Error: 'python' command not found, and no Miniforge/Anaconda/Miniconda
    echo installation was found in the usual locations either.
    echo.
    echo Please install Python 3.8+ from https://www.python.org/downloads/
    echo and make sure to check "Add python.exe to PATH" during installation.
    echo.
    echo If you use Miniforge/Anaconda/Miniconda under a different path, run this
    echo script from an "Anaconda Prompt" / "Miniforge Prompt" instead.
    goto :error
)

echo    Using Python: !PYTHON_EXE!

where npm >nul 2>nul
if errorlevel 1 (
    echo Error: 'npm' command not found.
    echo Please install Node.js 16+ from https://nodejs.org/ ^(npm is included^).
    goto :error
)

echo 1. Setting up Backend...
cd backend

if not exist ".venv" (
    echo    Creating Python virtual environment ^(.venv^)...
    "!PYTHON_EXE!" -m venv .venv
    if errorlevel 1 goto :error
)

echo    Installing backend dependencies...
.venv\Scripts\pip.exe install -r requirements.txt
if errorlevel 1 goto :error

if not exist ".env" (
    echo    Creating configuration file ^(.env from template^)...
    copy /y ".env.example" ".env" >nul
)

cd ..

echo 2. Setting up Frontend...
cd frontend

echo    Installing frontend dependencies...
if exist package-lock.json (
    call npm ci
) else (
    call npm install
)
if errorlevel 1 goto :error

echo    Building frontend production assets...
call npm run build
if errorlevel 1 goto :error
git -C .. rev-parse HEAD > dist\.build-commit 2>nul

cd ..

echo =========================================
echo EasyPaper Setup Complete!
echo =========================================
echo To start the development servers concurrently, run:
echo    scripts\bat\start-dev.bat
echo.
echo To run the production-ready server serving both frontend ^& backend, run:
echo    scripts\bat\start.bat
echo    Then open: http://localhost:8000
echo =========================================
echo.
pause
goto :eof

:error
echo.
echo Setup failed. Please check the error message above.
echo.
pause
exit /b 1
