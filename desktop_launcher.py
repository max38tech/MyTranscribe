"""
Desktop Application Launcher for MyTranscribe.
Starts the FastAPI backend and global dictation service,
and opens the app in a desktop window or default browser.
"""

from __future__ import annotations
import sys
import os
import time
import threading
import webbrowser
import uvicorn

# Add project root to sys.path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

PORT = int(os.environ.get("MYTRANSCRIBE_PORT", 8000))
HOST = os.environ.get("MYTRANSCRIBE_HOST", "0.0.0.0")


def start_server():
    """Run uvicorn server."""
    from backend.server import app
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")


def open_browser():
    """Wait for server to start, then open the browser or PWA window."""
    time.sleep(1.2)
    url = f"http://localhost:{PORT}"
    print(f"\n=======================================================")
    print(f"  🎙️  MyTranscribe is running at: {url}")
    print(f"  ⚡  faster-whisper inference ready")
    print(f"  🧹  Speech cleanup & filler removal active")
    print(f"  ⌨️   GLOBAL DICTATION: Press [ Ctrl + Alt + Space ] in")
    print(f"      ANY app (WhatsApp, Slack, Word, Notepad, etc.)")
    print(f"      to dictate and auto-insert clean text!")
    print(f"=======================================================\n")

    # Try PyWebView if installed for native desktop window
    try:
        import webview
        webview.create_window("MyTranscribe", url, width=1200, height=850, min_size=(800, 600))
        webview.start()
        return
    except Exception:
        pass

    # Default: Open in default browser
    webbrowser.open(url)


def main():
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    open_browser()

    # Keep main thread alive if browser mode
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping MyTranscribe...")


if __name__ == "__main__":
    main()
