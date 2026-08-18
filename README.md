# MyTranscribe 🎙️✨

An AI speech transcription desktop app and Progressive Web App (PWA) powered by [**faster-whisper**](https://github.com/SYSTRAN/faster-whisper) with intelligent **disfluency and filler word removal**.

When you speak and say *"uuhmmm"*, *"uh"*, *"um"*, or stutter repetitions like *"I I think"*, MyTranscribe automatically removes them and cleans up punctuation, spacing, and sentence capitalization to output clean, publish-ready text in real time.

---

## ✨ Features

- ⌨️ **Universal System-Wide Dictation (WhatsApp, Slack, Any App)**:
  - Press **`Ctrl + Alt + Space`** (or your custom shortcut) while typing in **WhatsApp**, **Slack**, **Discord**, **Notepad**, **Microsoft Word**, **Google Docs**, or any browser input field.
  - A subtle audio chime plays, you speak your thoughts, and pressing the shortcut again automatically transcribes, removes filler sounds, and **pastes the clean text directly into your active text field**!
  - Works with zero window switching.
- ⚡ **faster-whisper Engine**: High-efficiency, low-latency CTranslate2 Whisper inference running 100% locally on your machine.
- 🧹 **Intelligent Filler Word Cleanup**:
  - Automatically eliminates vocal fillers: `"uuhmmm"`, `"uh"`, `"um"`, `"umm"`, `"errr"`, `"ahhh"`, `"hmm"`, `"mhm"`, etc.
  - Cleans stuttered word repetitions: `"I I think"` $\rightarrow$ `"I think"`, `"the the"` $\rightarrow$ `"the"`.
  - Cleans hyphen false starts: `"th- that"` $\rightarrow$ `"that"`.
  - Fixes orphaned punctuation (hanging commas, double spaces) and re-capitalizes sentence beginnings.
  - Optional toggle for verbal crutches: `"like"`, `"you know"`, `"basically"`, `"sort of"`.
  - Custom blacklist and whitelist/preserve support.
- 🖥️ **Desktop & PWA Cross-Platform**:
  - Runs on **Windows**, **Linux**, and **macOS**.
  - Installable as a standalone PWA application on desktop and mobile.
  - LAN / Wi-Fi support: Access the app from your smartphone or tablet on your home/office network.
- 🎨 **Modern User Interface**:
  - Live 60fps audio waveform and frequency visualizer reacting to your microphone.
  - **Clean Text View**, **Filler Diff View** (showing removed words in strikethrough), and **Timestamps / Subtitle View**.
  - Push-to-Talk mode (Hold Spacebar to record).
  - Audio file drag & drop (MP3, WAV, M4A, OGG, WebM).
  - One-click copy, export to TXT, Markdown, Subtitles (.srt), or JSON.
  - Persistent SQLite history drawer with search and favorites.

---

## 🚀 Quick Start

### 🪟 Windows (One-Click)
Double-click `run.bat` or run:
```bat
run.bat
```
*(Dependencies and Python environment are automatically provisioned using `uv`).*

### 🐧 Linux / macOS
```bash
chmod +x run.sh
./run.sh
```

---

## 💻 Manual Launch / CLI Usage

### Running the Web / Desktop Application
```bash
uv run python desktop_launcher.py
```
Open [http://localhost:8000](http://localhost:8000) in your browser.

### Transcribing Audio Files from CLI
```bash
# Transcribe and clean an audio file
uv run python cli.py my_recording.wav

# Transcribe with a specific model and verbal crutches removal
uv run python cli.py speech.mp3 --model small --verbal-crutches -o clean_output.txt
```

---

## 🧪 Running Tests

```bash
uv run pytest
```

---

## 📁 Project Structure

```
MyTranscribe/
├── backend/
│   ├── cleaner.py       # Speech disfluency, filler sound & repetition cleanup engine
│   ├── transcriber.py   # faster-whisper CTranslate2 wrapper & audio decoder
│   ├── database.py      # SQLite persistent history storage
│   └── server.py        # FastAPI backend, WebSockets & REST endpoints
├── frontend/
│   ├── index.html       # Modern PWA user interface
│   ├── css/style.css    # Responsive styles, glassmorphism & dark/light theme
│   ├── js/app.js        # Web Audio API visualizer, recorder & UI logic
│   ├── manifest.webmanifest # PWA Web App manifest
│   ├── sw.js            # PWA Service Worker for offline asset caching
│   └── icons/           # App icons
├── tests/
│   ├── test_cleaner.py     # Unit tests for filler removal, stutters, formatting
│   ├── test_transcriber.py # Audio decoding and Whisper model tests
│   └── test_api.py         # REST & WebSocket API endpoint tests
├── desktop_launcher.py  # Cross-platform desktop launcher
├── cli.py               # Command-line interface for file transcription
├── run.bat              # One-click Windows runner
├── run.sh               # One-click Linux runner
└── pyproject.toml       # Project configuration and dependencies
```
