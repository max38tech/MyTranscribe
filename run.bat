@echo off
setlocal enabledelayedexpansion

title MyTranscribe Launcher

echo =======================================================
echo          Starting MyTranscribe Desktop App
echo =======================================================
echo.

cd /d "%~dp0"

:: Check if uv is in PATH or user local bin
where uv >nul 2>nul
if %ERRORLEVEL% equ 0 (
    set "UV_CMD=uv"
) else if exist "%USERPROFILE%\.local\bin\uv.exe" (
    set "UV_CMD=%USERPROFILE%\.local\bin\uv.exe"
) else (
    echo [!] uv package manager not found. Installing uv...
    powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
    set "UV_CMD=%USERPROFILE%\.local\bin\uv.exe"
)

echo [*] Initializing environment and dependencies with uv...
%UV_CMD% run python desktop_launcher.py

pause
