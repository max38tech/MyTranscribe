#!/usr/bin/env bash
set -e

echo "======================================================="
echo "         Starting MyTranscribe Desktop App"
echo "======================================================="

# Navigate to script directory
cd "$(dirname "$0")"

# Check if uv is installed
if command -v uv >/dev/null 2>&1; then
    UV_CMD="uv"
elif [ -f "$HOME/.local/bin/uv" ]; then
    UV_CMD="$HOME/.local/bin/uv"
elif [ -f "$HOME/.cargo/bin/uv" ]; then
    UV_CMD="$HOME/.cargo/bin/uv"
else
    echo "[!] uv package manager not found. Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    UV_CMD="$HOME/.local/bin/uv"
fi

echo "[*] Initializing environment and dependencies with uv..."
$UV_CMD run python desktop_launcher.py
