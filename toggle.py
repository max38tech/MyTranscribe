#!/usr/bin/env python3
"""
CLI shortcut toggle for MyTranscribe Global Dictation.
Usage:
    python toggle.py

Can be assigned to any custom keyboard shortcut in:
- GNOME: Settings -> Keyboard -> View and Customize Shortcuts -> Custom Shortcuts -> Add (+)
- KDE Plasma: System Settings -> Shortcuts -> Custom Shortcuts
- Sway / Hyprland / i3: bindsym $mod+Space exec python /path/to/MyTranscribe/toggle.py
"""

import sys
import urllib.request
import urllib.error
import json

PORT = 8000
URL = f"http://127.0.0.1:{PORT}/api/dictation/toggle"


def toggle_dictation():
    try:
        req = urllib.request.Request(
            URL,
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("is_recording"):
                print("[Dictation] 🔴 Recording started...")
            else:
                print("[Dictation] ⏹️ Stopped. Processing and inserting text...")
    except urllib.error.URLError:
        print("[!] MyTranscribe server is not running. Please start it with ./run.sh or run.bat first.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    toggle_dictation()
