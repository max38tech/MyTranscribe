"""
Global System-Wide Dictation Service for MyTranscribe.
Allows pressing a global key combination in ANY application (WhatsApp, Slack, Notepad, etc.),
speaking speech, and automatically inserting the cleaned text into the active text field.
"""

from __future__ import annotations
import os
import sys
import time
import uuid
import queue
import logging
import threading
from typing import Optional, Callable, Dict, Any, List
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

from .transcriber import Transcriber
from .cleaner import DisfluencyCleaner
from .database import save_transcript


# Available standard hotkey presets
HOTKEY_PRESETS = [
    {"id": "<ctrl>+<alt>+<space>", "name": "Ctrl + Alt + Space (Recommended)"},
    {"id": "<alt>+d", "name": "Alt + D"},
    {"id": "<ctrl>+<shift>+<space>", "name": "Ctrl + Shift + Space"},
    {"id": "<ctrl>+<shift>+d", "name": "Ctrl + Shift + D"},
    {"id": "<f8>", "name": "F8 Key"},
    {"id": "<f9>", "name": "F9 Key"},
]


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
        self._audio_queue: queue.Queue = queue.Queue()
        self._audio_buffer: List[np.ndarray] = []
        self._sd_stream: Optional[Any] = None
        self._hotkey_listener: Optional[Any] = None
        self._lock = threading.Lock()
        self.keyboard_controller = KeyboardController() if PYNPUT_AVAILABLE else None

    def start(self):
        """Start the global hotkey listener in background."""
        if not PYNPUT_AVAILABLE:
            logger.warning("Global hotkeys cannot start because pynput is not available.")
            return False

        self._stop_hotkey_listener()

        try:
            hotkeys = {self.hotkey_str: self._on_hotkey_triggered}
            self._hotkey_listener = keyboard.GlobalHotKeys(hotkeys)
            self._hotkey_listener.daemon = True
            self._hotkey_listener.start()
            logger.info(f"Global Dictation active. Hotkey: {self.hotkey_str}")
            return True
        except Exception as e:
            logger.error(f"Failed to start global hotkey listener with '{self.hotkey_str}': {e}")
            # Fallback to default
            if self.hotkey_str != "<ctrl>+<alt>+<space>":
                self.hotkey_str = "<ctrl>+<alt>+<space>"
                return self.start()
            return False

    def stop(self):
        """Stop hotkey listener and any active recording."""
        self._stop_hotkey_listener()
        if self.is_recording:
            self._stop_recording()

    def _stop_hotkey_listener(self):
        if self._hotkey_listener:
            try:
                self._hotkey_listener.stop()
            except Exception:
                pass
            self._hotkey_listener = None

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
            except Exception as e:
                logger.debug(f"Audio chime failed: {e}")

        threading.Thread(target=_play, daemon=True).start()

    def _on_hotkey_triggered(self):
        """Called whenever the global shortcut is pressed."""
        with self._lock:
            if not self.is_recording:
                self.start_recording()
            else:
                self.stop_recording_and_insert()

    def start_recording(self):
        """Begin audio capture from microphone."""
        if self.is_recording or self.is_processing:
            return

        if not SOUNDDEVICE_AVAILABLE:
            logger.error("Cannot record: sounddevice library is missing.")
            return

        logger.info("[Dictation] Recording started...")
        self.is_recording = True
        self._audio_buffer = []
        self._play_sound("start")

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
        except Exception as e:
            logger.error(f"Failed to open audio input stream: {e}")
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

        if not self._audio_buffer:
            return None

        audio_np = np.concatenate(self._audio_buffer, axis=0).flatten()
        self._audio_buffer = []
        return audio_np

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
                # Insert text into active text field
                self._paste_text(clean_text)

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

    def _paste_text(self, text: str):
        """
        Pastes text directly into the focused application window
        (WhatsApp, Slack, Notepad, Word, etc.) via clipboard paste simulation.
        """
        if not PYNPUT_AVAILABLE or self.keyboard_controller is None:
            return

        try:
            # Preserve existing clipboard content
            try:
                old_clip = pyperclip.paste()
            except Exception:
                old_clip = ""

            # Copy cleaned text to clipboard
            pyperclip.copy(text)

            # Small delay to ensure clipboard is updated in OS
            time.sleep(0.06)

            # Simulate Ctrl+V (or Cmd+V on macOS)
            is_mac = sys.platform == "darwin"
            modifier = Key.cmd if is_mac else Key.ctrl

            with self.keyboard_controller.pressed(modifier):
                self.keyboard_controller.press("v")
                self.keyboard_controller.release("v")

            # Small delay before restoring clipboard
            time.sleep(0.12)
            try:
                if old_clip:
                    pyperclip.copy(old_clip)
            except Exception:
                pass

            logger.info(f"[Dictation] Inserted clean text into active window successfully.")
        except Exception as e:
            logger.error(f"Failed to paste text into active window: {e}")
