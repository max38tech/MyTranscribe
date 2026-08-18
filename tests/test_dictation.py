"""
Unit tests for DictationService in backend/dictation.py and dictation API endpoints.
"""

import pytest
import numpy as np
from fastapi.testclient import TestClient

from backend.dictation import DictationService, HOTKEY_PRESETS
from backend.transcriber import Transcriber
from backend.cleaner import DisfluencyCleaner
from backend.server import app

client = TestClient(app)


def test_dictation_presets():
    assert len(HOTKEY_PRESETS) >= 4
    preset_ids = [p["id"] for p in HOTKEY_PRESETS]
    assert "<ctrl>+<alt>+<space>" in preset_ids
    assert "<alt>+d" in preset_ids


def test_dictation_service_init():
    transcriber = Transcriber(default_model="base")
    cleaner = DisfluencyCleaner()
    service = DictationService(
        transcriber=transcriber,
        cleaner=cleaner,
        hotkey="<ctrl>+<alt>+<space>",
        enable_sound_chimes=False,
    )
    assert service.hotkey_str == "<ctrl>+<alt>+<space>"
    assert not service.is_recording
    assert not service.is_processing


def test_dictation_process_pipeline():
    """Verify that _process_and_insert transcribes, cleans, and triggers callback."""
    class MockTranscriber:
        current_model_name = "base"
        def transcribe(self, audio_np, **kwargs):
            return {
                "text": "Uuhmmm, we need to send this to, uh, WhatsApp.",
                "duration": 2.5,
                "language": "en",
                "language_probability": 0.99,
                "segments": [],
            }

    callback_called = []
    def callback(data):
        callback_called.append(data)

    service = DictationService(
        transcriber=MockTranscriber(),
        cleaner=DisfluencyCleaner(),
        enable_sound_chimes=False,
        on_transcription_callback=callback,
    )

    # Prevent actual OS simulated keypress during unit test
    service.keyboard_controller = None

    synthetic_audio = np.zeros(16000 * 2, dtype=np.float32)
    service._process_and_insert(synthetic_audio)

    assert len(callback_called) == 1
    event = callback_called[0]
    assert event["type"] == "dictation_event"
    assert event["cleaned_text"] == "We need to send this to WhatsApp."
    assert event["removed_count"] >= 2


def test_api_dictation_status():
    resp = client.get("/api/dictation/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "hotkey" in data
    assert "presets" in data
    assert len(data["presets"]) > 0


def test_api_dictation_config():
    resp = client.post(
        "/api/dictation/config",
        json={"hotkey": "<alt>+d", "enable_sound_chimes": True},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert data["hotkey"] == "<alt>+d"
