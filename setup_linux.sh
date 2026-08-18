#!/usr/bin/env bash
# MyTranscribe Linux Setup Helper
# Configures clipboard utilities, input permissions, and GNOME/KDE shortcuts.

set -e

echo "======================================================="
echo "       MyTranscribe Linux Setup & Dependency Check     "
echo "======================================================="

# 1. Check and install recommended clipboard & input tools
if command -v apt-get >/dev/null 2>&1; then
    echo "[*] Debian/Ubuntu detected. Installing recommended tools (wl-clipboard, xdotool, wtype, portaudio)..."
    sudo apt-get update -qq && sudo apt-get install -y wl-clipboard xdotool wtype libportaudio2 || true
elif command -v dnf >/dev/null 2>&1; then
    echo "[*] Fedora/RHEL detected. Installing recommended tools..."
    sudo dnf install -y wl-clipboard xdotool wtype portaudio || true
elif command -v pacman >/dev/null 2>&1; then
    echo "[*] Arch Linux detected. Installing recommended tools..."
    sudo pacman -S --noconfirm wl-clipboard xdotool wtype portaudio || true
fi

# 2. Add user to 'input' group for kernel-level evdev hotkeys
if groups "$USER" | grep -q "\binput\b"; then
    echo "[✓] User '$USER' is already in the 'input' group for global hotkeys."
else
    echo "[*] Adding '$USER' to the 'input' group for global hotkey support..."
    sudo usermod -aG input "$USER" || true
    echo "[!] Note: You may need to log out and log back in for group changes to take effect."
fi

# 3. GNOME Custom Shortcut Auto-Configuration (Ubuntu / Fedora / Debian)
if command -v gsettings >/dev/null 2>&1; then
    SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/toggle.py"
    BINDING_PATH="/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom-mytranscribe/"
    
    echo "[*] Configuring GNOME keyboard shortcut (Ctrl+Alt+Space)..."
    CURRENT=$(gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings 2>/dev/null || echo "@as []")
    
    if [[ "$CURRENT" != *"$BINDING_PATH"* ]]; then
        if [[ "$CURRENT" == "@as []" ]] || [[ "$CURRENT" == "[]" ]]; then
            NEW_BINDINGS="['$BINDING_PATH']"
        else
            NEW_BINDINGS="${CURRENT%]*}, '$BINDING_PATH']"
        fi
        gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "$NEW_BINDINGS" 2>/dev/null || true
        gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$BINDING_PATH name "MyTranscribe Dictation" 2>/dev/null || true
        gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$BINDING_PATH command "python3 $SCRIPT_PATH" 2>/dev/null || true
        gsettings set org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$BINDING_PATH binding "<Primary><Alt>space" 2>/dev/null || true
        echo "[✓] GNOME shortcut registered: Ctrl+Alt+Space -> python3 $SCRIPT_PATH"
    else
        echo "[✓] GNOME shortcut is already active."
    fi
fi

echo ""
echo "======================================================="
echo "  Setup complete! Run ./run.sh to start MyTranscribe."
echo "======================================================="
