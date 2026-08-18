"""
Global System-Wide Dictation Service for MyTranscribe.
Supports Windows, macOS, and Linux (Wayland and X11).
Allows pressing a global key combination in ANY application (WhatsApp, Slack, Notepad, etc.),
speaking speech, and automatically inserting the cleaned text into the active text field.
"""

from __future__ import annotations
import os
import sys
import time
import uuid
import queue
import shutil
import logging
import threading
import subprocess
from typing import Optional, Callable, Dict, Any, List, Set
import numpy as np

logger = logging.getLogger("mytranscribe.dictation")

try:
    import sounddevice as sd
    SOUNDDEVICE_AVAILABLE = True
except Exception as e:
    SOUNDDEVICE_AVAILABLE = False
    logger.warning(f"sounddevice not available: {e}")

try:
    import pyperclip
    import pynput
    from pynput import keyboard
    from pynput.keyboard import Key, KeyCode, Controller as KeyboardController
    PYNPUT_AVAILABLE = True
except Exception as e:
    PYNPUT_AVAILABLE = False
    logger.warning(f"pynput or pyperclip not available: {e}")

# Optional Linux evdev kernel input listener (Wayland + X11)
try:
    if sys.platform.startswith("linux"):
        import evdev
        from evdev import ecodes
        EVDEV_AVAILABLE = True
    else:
        EVDEV_AVAILABLE = False
except Exception:
    EVDEV_AVAILABLE = False

from .transcriber import Transcriber
from .cleaner import DisfluencyCleaner
from .database import save_transcript


HOTKEY_PRESETS = [
    {"id": "<ctrl>+<alt>+<space>", "name": "Ctrl + Alt + Space (Recommended)"},
    {"id": "<alt>+d", "name": "Alt + D"},
    {"id": "<ctrl>+<shift>+<space>", "name": "Ctrl + Shift + Space"},
    {"id": "<ctrl>+<shift>+d", "name": "Ctrl + Shift + D"},
    {"id": "<f8>", "name": "F8 Key"},
    {"id": "<f9>", "name": "F9 Key"},
]


class EvdevHotKeyManager:
    """Linux kernel-level global input listener working on both Wayland & X11."""

    def __init__(self, hotkey_str: str, on_trigger: Callable[[], None]):
        self.hotkey_str = hotkey_str
        self.on_trigger = on_trigger
        self.running = False
        self._thread: Optional[threading.Thread] = None
        self._key_codes = self._parse_hotkey(hotkey_str)

    def _parse_hotkey(self, hotkey: str) -> List[Set[int]]:
        """Map hotkey string to sets of evdev ecodes."""
        if not EVDEV_AVAILABLE:
            return []

        key_map = {
            "ctrl": {ecodes.KEY_LEFTCTRL, ecodes.KEY_RIGHTCTRL},
            "alt": {ecodes.KEY_LEFTALT, ecodes.KEY_RIGHTALT},
            "shift": {ecodes.KEY_LEFTSHIFT, ecodes.KEY_RIGHTSHIFT},
            "super": {ecodes.KEY_LEFTMETA, ecodes.KEY_RIGHTMETA},
            "space": {ecodes.KEY_SPACE},
            "d": {ecodes.KEY_D},
            "f8": {ecodes.KEY_F8},
            "f9": {ecodes.KEY_F9},
        }

        parts = hotkey.lower().replace("<", "").replace(">", "").split("+")
        groups = []
        for part in parts:
            part = part.strip()
            if part in key_map:
                groups.append(key_map[part])
            else:
                code_name = f"KEY_{part.upper()}"
                if hasattr(ecodes, code_name):
                    groups.append({getattr(ecodes, code_name)})
        return groups

    def start(self) -> bool:
        """Find keyboard devices and start event loop."""
        if not EVDEV_AVAILABLE or not self._key_codes:
            return False

        try:
            device_paths = evdev.list_devices()
            devices = []
            for path in device_paths:
                try:
                    dev = evdev.InputDevice(path)
                    caps = dev.capabilities()
                    if ecodes.EV_KEY in caps:
                        devices.append(dev)
                except (PermissionError, OSError):
                    continue

            if not devices:
                logger.warning(
                    "[Linux Evdev] No readable input devices found in /dev/input/. "
                    "To enable direct kernel hotkeys, run: 'sudo usermod -aG input $USER' and relogin. "
                    "Alternatively, bind 'python toggle.py' in GNOME/KDE Custom Shortcuts."
                )
                return False

            self.running = True
            self._thread = threading.Thread(target=self._loop, args=(devices,), daemon=True)
            self._thread.start()
            logger.info(f"[Linux Evdev] Kernel hotkey listener active on {len(devices)} device(s) for '{self.hotkey_str}'.")
            return True
        except Exception as e:
            logger.debug(f"[Linux Evdev] Failed to initialize: {e}")
            return False

    def stop(self):
        self.running = False

    def _loop(self, devices):
        import select
        active_keys: Set[int] = set()
        combo_was_active = False

        try:
            while self.running:
                r, _, _ = select.select(devices, [], [], 0.5)
                for dev in r:
                    try:
                        for event in dev.read():
                            if event.type == ecodes.EV_KEY:
                                if event.value == 1:  # Key down
                                    active_keys.add(event.code)
                                elif event.value == 0:  # Key up
                                    active_keys.discard(event.code)

                                # Check rising edge: only trigger once when combo is freshly pressed
                                combo_is_active = all(any(k in active_keys for k in grp) for grp in self._key_codes)
                                if combo_is_active and not combo_was_active:
                                    combo_was_active = True
                                    self.on_trigger()
                                elif not combo_is_active:
                                    combo_was_active = False
                    except Exception:
                        pass
        except Exception as err:
            logger.debug(f"[Linux Evdev] Loop error: {err}")


class DictationService:
    """Manages background global hotkey listening, mic recording, and text insertion."""

    def __init__(
        self,
        transcriber: Transcriber,
        cleaner: Optional[DisfluencyCleaner] = None,
        hotkey: str = "<ctrl>+<alt>+<space>",
        enable_sound_chimes: bool = True,
        on_transcription_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        self.transcriber = transcriber
        self.cleaner = cleaner or DisfluencyCleaner()
        self.hotkey_str = hotkey
        self.enable_sound_chimes = enable_sound_chimes
        self.on_transcription_callback = on_transcription_callback

        self.is_recording = False
        self.is_processing = False
        self._last_toggle_time = 0.0
        self._audio_queue: queue.Queue = queue.Queue()
        self._audio_buffer: List[np.ndarray] = []
        self._raw_pcm_bytes: bytearray = bytearray()
        self._sd_stream: Optional[Any] = None
        self._cli_proc: Optional[Any] = None
        self._hotkey_listener: Optional[Any] = None
        self._evdev_manager: Optional[EvdevHotKeyManager] = None
        self._lock = threading.Lock()
        self.keyboard_controller = KeyboardController() if PYNPUT_AVAILABLE else None

    def _on_hotkey_triggered(self):
        """Called whenever the global shortcut is pressed with debounce protection."""
        with self._lock:
            now = time.time()
            if now - self._last_toggle_time < 0.6:
                # Debounce fast duplicate triggers (e.g. key repeats or dual GNOME/evdev events)
                return
            self._last_toggle_time = now

            if not self.is_recording:
                self.start_recording()
            else:
                self.stop_recording_and_insert()

    def start(self) -> bool:
        """Start the global hotkey listener in background across Windows, macOS, and Linux."""
        self._stop_listeners()

        started = False

        # On Linux: Try evdev kernel listener first (works on Wayland and X11)
        if sys.platform.startswith("linux") and EVDEV_AVAILABLE:
            self._evdev_manager = EvdevHotKeyManager(self.hotkey_str, self._on_hotkey_triggered)
            if self._evdev_manager.start():
                started = True

        # Try pynput GlobalHotKeys (works on Windows, macOS, and Linux X11)
        if PYNPUT_AVAILABLE:
            try:
                hotkeys = {self.hotkey_str: self._on_hotkey_triggered}
                self._hotkey_listener = keyboard.GlobalHotKeys(hotkeys)
                self._hotkey_listener.daemon = True
                self._hotkey_listener.start()
                started = True
                logger.info(f"Global Dictation active via pynput. Hotkey: {self.hotkey_str}")
            except Exception as e:
                logger.warning(f"pynput hotkey listener error: {e}")

        if not started:
            logger.info(
                f"[Dictation Ready] Global hotkey set to {self.hotkey_str}. "
                "On Linux Wayland, you can also bind 'python toggle.py' to any keyboard shortcut in GNOME/KDE Settings."
            )

        return True

    def stop(self):
        """Stop hotkey listener and any active recording."""
        self._stop_listeners()
        if self.is_recording:
            self._stop_recording()

    def _stop_listeners(self):
        if self._hotkey_listener:
            try:
                self._hotkey_listener.stop()
            except Exception:
                pass
            self._hotkey_listener = None

        if self._evdev_manager:
            try:
                self._evdev_manager.stop()
            except Exception:
                pass
            self._evdev_manager = None

    def set_hotkey(self, new_hotkey: str) -> bool:
        """Update hotkey combination dynamically."""
        with self._lock:
            self.hotkey_str = new_hotkey
            return self.start()

    def _play_sound(self, tone_type: str = "start"):
        """Play a short, subtle audio cue without blocking."""
        if not self.enable_sound_chimes:
            return

        def _play():
            try:
                if sys.platform == "win32":
                    import winsound
                    if tone_type == "start":
                        winsound.Beep(880, 100)   # 880Hz A5
                        winsound.Beep(1174, 120)  # 1174Hz D6
                    else:
                        winsound.Beep(1174, 90)
                        winsound.Beep(880, 110)
                elif SOUNDDEVICE_AVAILABLE:
                    sr = 16000
                    if tone_type == "start":
                        t1 = np.linspace(0, 0.08, int(sr * 0.08), False)
                        t2 = np.linspace(0, 0.10, int(sr * 0.10), False)
                        audio = np.concatenate([
                            np.sin(2 * np.pi * 880 * t1) * 0.2,
                            np.sin(2 * np.pi * 1174 * t2) * 0.2
                        ]).astype(np.float32)
                    else:
                        t1 = np.linspace(0, 0.08, int(sr * 0.08), False)
                        t2 = np.linspace(0, 0.10, int(sr * 0.10), False)
                        audio = np.concatenate([
                            np.sin(2 * np.pi * 1174 * t1) * 0.2,
                            np.sin(2 * np.pi * 880 * t2) * 0.2
                        ]).astype(np.float32)
                    sd.play(audio, sr)
                    sd.wait()
                elif sys.platform.startswith("linux"):
                    # Linux CLI sound fallback (aplay / pw-play)
                    sr = 16000
                    if tone_type == "start":
                        t1 = np.linspace(0, 0.08, int(sr * 0.08), False)
                        t2 = np.linspace(0, 0.10, int(sr * 0.10), False)
                        audio = np.concatenate([
                            np.sin(2 * np.pi * 880 * t1) * 0.3,
                            np.sin(2 * np.pi * 1174 * t2) * 0.3
                        ])
                    else:
                        t1 = np.linspace(0, 0.08, int(sr * 0.08), False)
                        t2 = np.linspace(0, 0.10, int(sr * 0.10), False)
                        audio = np.concatenate([
                            np.sin(2 * np.pi * 1174 * t1) * 0.3,
                            np.sin(2 * np.pi * 880 * t2) * 0.3
                        ])
                    pcm_data = (audio * 32767).astype(np.int16).tobytes()
                    if shutil.which("aplay"):
                        subprocess.run(["aplay", "-q", "-r", "16000", "-f", "S16_LE", "-c", "1"], input=pcm_data, timeout=1)
                    elif shutil.which("pw-play"):
                        subprocess.run(["pw-play", "--rate", "16000", "--channels", "1", "--format", "s16", "-"], input=pcm_data, timeout=1)
            except Exception as e:
                logger.debug(f"Audio chime failed: {e}")

        threading.Thread(target=_play, daemon=True).start()


    def start_recording(self):
        """Begin audio capture from microphone."""
        if self.is_recording or self.is_processing:
            return

        logger.info("[Dictation] 🔴 Recording started... Speak naturally.")
        self.is_recording = True
        self._audio_buffer = []
        self._raw_pcm_bytes = bytearray()
        self._play_sound("start")

        # Approach A: sounddevice if PortAudio is installed
        if SOUNDDEVICE_AVAILABLE:
            def audio_callback(indata, frames, time_info, status):
                if status:
                    logger.warning(f"Audio input status: {status}")
                if self.is_recording:
                    self._audio_buffer.append(indata.copy())

            try:
                self._sd_stream = sd.InputStream(
                    samplerate=16000,
                    channels=1,
                    dtype="float32",
                    callback=audio_callback,
                )
                self._sd_stream.start()
                return
            except Exception as e:
                logger.debug(f"sounddevice stream open failed: {e}. Trying Linux CLI recorder fallback.")
                self._sd_stream = None

        # Approach B: Native Linux CLI stream (arecord / pw-record / parec)
        if sys.platform.startswith("linux"):
            recorder_cmd = None
            if shutil.which("arecord"):
                recorder_cmd = ["arecord", "-q", "-r", "16000", "-f", "S16_LE", "-c", "1", "-t", "raw"]
            elif shutil.which("pw-record"):
                recorder_cmd = ["pw-record", "--rate", "16000", "--channels", "1", "--format", "s16", "-"]
            elif shutil.which("parec"):
                recorder_cmd = ["parec", "--rate=16000", "--channels=1", "--format=s16le"]

            if recorder_cmd:
                try:
                    self._cli_proc = subprocess.Popen(
                        recorder_cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,
                    )

                    def _read_cli_audio():
                        while self.is_recording and self._cli_proc and self._cli_proc.poll() is None:
                            chunk = self._cli_proc.stdout.read(4096)
                            if not chunk:
                                break
                            self._raw_pcm_bytes.extend(chunk)

                    threading.Thread(target=_read_cli_audio, daemon=True).start()
                    logger.info(f"[Dictation] Using native Linux audio recorder: {recorder_cmd[0]}")
                    return
                except Exception as ex:
                    logger.error(f"Failed to start Linux audio recorder: {ex}")

        logger.error(
            "Cannot record audio: sounddevice/PortAudio not found and no CLI recorder (arecord/pw-record) available. "
            "Please run './setup_linux.sh' or 'sudo apt install libportaudio2 alsa-utils'."
        )
        self.is_recording = False

    def _stop_recording(self) -> Optional[np.ndarray]:
        """Stop mic stream and return recorded audio as float32 1D numpy array."""
        self.is_recording = False

        if self._sd_stream:
            try:
                self._sd_stream.stop()
                self._sd_stream.close()
            except Exception:
                pass
            self._sd_stream = None

        if hasattr(self, "_cli_proc") and self._cli_proc:
            try:
                self._cli_proc.terminate()
                self._cli_proc.wait(timeout=1)
            except Exception:
                pass
            self._cli_proc = None

        # If sounddevice captured numpy frames
        if self._audio_buffer:
            audio_np = np.concatenate(self._audio_buffer, axis=0).flatten()
            self._audio_buffer = []
            return audio_np

        # If Linux CLI captured raw PCM bytes
        if hasattr(self, "_raw_pcm_bytes") and self._raw_pcm_bytes:
            raw_bytes = bytes(self._raw_pcm_bytes)
            even_len = len(raw_bytes) - (len(raw_bytes) % 2)
            if even_len > 0:
                audio_np = (np.frombuffer(raw_bytes[:even_len], dtype=np.int16).astype(np.float32) / 32768.0)
                self._raw_pcm_bytes.clear()
                return audio_np

        return None

    def stop_recording_and_insert(self):
        """Stop recording, transcribe, clean, and insert into the active window."""
        audio_np = self._stop_recording()
        self._play_sound("stop")

        if audio_np is None or len(audio_np) < 8000:  # less than 0.5s
            logger.info("[Dictation] Audio too short, skipping.")
            return

        # Run transcription & cleanup in a separate thread so hotkey thread doesn't hang
        threading.Thread(target=self._process_and_insert, args=(audio_np,), daemon=True).start()

    def _process_and_insert(self, audio_np: np.ndarray):
        """Worker thread for inference, cleanup, and keyboard paste."""
        self.is_processing = True
        try:
            logger.info("[Dictation] Transcribing speech with faster-whisper...")
            transcribe_res = self.transcriber.transcribe(audio_np)
            raw_text = transcribe_res.get("text", "").strip()

            if not raw_text:
                logger.info("[Dictation] No speech detected.")
                return

            # Clean filler words ('uuhmmm', 'uh', 'um', stutters, etc.)
            clean_res = self.cleaner.clean(raw_text)
            clean_text = clean_res["cleaned_text"].strip()

            logger.info(f"[Dictation] Raw: '{raw_text}' -> Clean: '{clean_text}'")

            if clean_text:
                # Insert text into active text field across Windows, macOS, and Linux
                self._paste_text_universal(clean_text)

                # Save to database history
                record_id = str(uuid.uuid4())
                title = clean_text[:40] + ("..." if len(clean_text) > 40 else "")
                saved = save_transcript(
                    item_id=record_id,
                    title=f"Dictation: {title}",
                    raw_text=raw_text,
                    cleaned_text=clean_text,
                    removed_count=clean_res["removed_count"],
                    removed_items=clean_res["removed_items"],
                    duration_seconds=transcribe_res["duration"],
                    model_name=self.transcriber.current_model_name,
                    language=transcribe_res["language"],
                )

                # Notify callback (e.g. WebSocket broadcast to UI)
                if self.on_transcription_callback:
                    try:
                        self.on_transcription_callback({
                            "type": "dictation_event",
                            "raw_text": raw_text,
                            "cleaned_text": clean_text,
                            "diff_html": clean_res["diff_html"],
                            "removed_count": clean_res["removed_count"],
                            "removed_items": clean_res["removed_items"],
                            "duration": transcribe_res["duration"],
                            "record": saved,
                        })
                    except Exception as err:
                        logger.warning(f"Error in dictation callback: {err}")

        except Exception as e:
            logger.error(f"Error during dictation processing: {e}", exc_info=True)
        finally:
            self.is_processing = False

    def _paste_text_universal(self, text: str):
        """
        Pastes text directly into the focused application window
        (WhatsApp, Slack, Notepad, Word, etc.) across Windows, Linux (Wayland & X11), and macOS.
        """
        # --- LINUX HANDLING (Wayland and X11) ---
        if sys.platform.startswith("linux"):
            is_wayland = bool(os.environ.get("WAYLAND_DISPLAY") or os.environ.get("XDG_SESSION_TYPE") == "wayland")

            # 1. Copy to system clipboard
            copied = False
            if is_wayland and shutil.which("wl-copy"):
                try:
                    subprocess.run(["wl-copy", "--type", "text/plain;charset=utf-8"], input=text.encode("utf-8"), check=True, timeout=2)
                    copied = True
                except Exception as e:
                    logger.debug(f"wl-copy failed: {e}")
            elif not is_wayland and shutil.which("xclip"):
                try:
                    subprocess.run(["xclip", "-selection", "clipboard"], input=text.encode("utf-8"), check=True, timeout=2)
                    copied = True
                except Exception as e:
                    logger.debug(f"xclip failed: {e}")

            if not copied and PYNPUT_AVAILABLE:
                try:
                    pyperclip.copy(text)
                    copied = True
                except Exception:
                    pass

            time.sleep(0.08)

            # 2. Simulate Paste without triggering GNOME Remote Desktop portal
            pasted = False

            # Primary for Linux (Wayland & X11): Kernel uinput virtual keyboard (No Remote Desktop prompt)
            if EVDEV_AVAILABLE:
                try:
                    from evdev import UInput, ecodes
                    cap = {ecodes.EV_KEY: [ecodes.KEY_LEFTCTRL, ecodes.KEY_V]}
                    with UInput(cap, name="mytranscribe-keyboard") as ui:
                        time.sleep(0.04)
                        ui.write(ecodes.EV_KEY, ecodes.KEY_LEFTCTRL, 1)
                        ui.write(ecodes.EV_KEY, ecodes.KEY_V, 1)
                        ui.syn()
                        time.sleep(0.04)
                        ui.write(ecodes.EV_KEY, ecodes.KEY_V, 0)
                        ui.write(ecodes.EV_KEY, ecodes.KEY_LEFTCTRL, 0)
                        ui.syn()
                    pasted = True
                    logger.info("[Dictation] Injected Ctrl+V via kernel uinput device.")
                except Exception as ui_err:
                    logger.debug(f"uinput paste fallback: {ui_err}")

            # Secondary for X11 / Xwayland: xdotool
            if not pasted and not is_wayland and shutil.which("xdotool"):
                try:
                    subprocess.run(["xdotool", "key", "--clearmodifiers", "ctrl+v"], check=True, timeout=2)
                    pasted = True
                except Exception:
                    pass

            # Secondary for Wayland: wtype or ydotool
            if not pasted and is_wayland:
                if shutil.which("wtype"):
                    try:
                        subprocess.run(["wtype", "-M", "ctrl", "-k", "v", "-m", "ctrl"], check=True, timeout=2)
                        pasted = True
                    except Exception:
                        pass
                elif shutil.which("ydotool"):
                    try:
                        subprocess.run(["ydotool", "key", "29:1", "47:1", "47:0", "29:0"], check=True, timeout=2)
                        pasted = True
                    except Exception:
                        pass

            # Only fallback to pynput on X11 (pynput on Wayland triggers the GNOME Remote Desktop dialog)
            if not pasted and not is_wayland and PYNPUT_AVAILABLE and self.keyboard_controller:
                try:
                    with self.keyboard_controller.pressed(Key.ctrl):
                        self.keyboard_controller.press("v")
                        self.keyboard_controller.release("v")
                    pasted = True
                except Exception as e:
                    logger.debug(f"pynput paste failed on X11: {e}")

            # Desktop notification on Linux
            if shutil.which("notify-send"):
                try:
                    preview = text[:50] + ("..." if len(text) > 50 else "")
                    subprocess.Popen(["notify-send", "-a", "MyTranscribe", "-i", "input-keyboard", "-t", "2000", "🎙️ Dictation", preview])
                except Exception:
                    pass

            logger.info("[Dictation] Text processing and insertion completed.")
            return

        # --- WINDOWS & MACOS HANDLING ---
        if PYNPUT_AVAILABLE and self.keyboard_controller:
            try:
                try:
                    old_clip = pyperclip.paste()
                except Exception:
                    old_clip = ""

                pyperclip.copy(text)
                time.sleep(0.06)

                is_mac = sys.platform == "darwin"
                modifier = Key.cmd if is_mac else Key.ctrl

                with self.keyboard_controller.pressed(modifier):
                    self.keyboard_controller.press("v")
                    self.keyboard_controller.release("v")

                time.sleep(0.12)
                try:
                    if old_clip:
                        pyperclip.copy(old_clip)
                except Exception:
                    pass

                logger.info("[Dictation] Inserted clean text into active window successfully.")
            except Exception as e:
                logger.error(f"Failed to paste text into active window: {e}")
