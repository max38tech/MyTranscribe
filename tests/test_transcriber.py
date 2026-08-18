"""
Unit tests for Transcriber in backend/transcriber.py
"""

import io
import pytest
import numpy as np
from backend.transcriber import Transcriber, AVAILABLE_MODELS


def test_available_models():
    assert len(AVAILABLE_MODELS) >= 5
    ids = [m["id"] for m in AVAILABLE_MODELS]
    assert "tiny" in ids
    assert "base" in ids
    assert "small" in ids
    assert "large-v3" in ids


def test_transcriber_initialization():
    t = Transcriber(default_model="base")
    assert t.current_model_name == "base"
    dev, ct = t._determine_device_and_compute()
    assert dev in ("cpu", "cuda")
    assert ct in ("int8", "float16", "float32")


def test_decode_audio_synthetic_pcm():
    t = Transcriber()
    # Create 1 second of 16kHz sine wave PCM 16-bit
    sampling_rate = 16000
    t_arr = np.linspace(0, 1, sampling_rate, False)
    sine = np.sin(2 * np.pi * 440 * t_arr)
    pcm_int16 = (sine * 32767).astype(np.int16)
    pcm_bytes = pcm_int16.tobytes()

    decoded = t.decode_audio_bytes(pcm_bytes)
    assert len(decoded) == sampling_rate
    assert isinstance(decoded, np.ndarray)
    assert decoded.dtype == np.float32

    # Test odd-length byte buffers
    odd_bytes = pcm_bytes[:-1]
    decoded_odd = t.decode_audio_bytes(odd_bytes)
    assert isinstance(decoded_odd, np.ndarray)


def test_decode_audio_wav_format():
    import soundfile as sf
    t = Transcriber()
    sr = 44100  # Non-16kHz sample rate
    sine = (np.sin(2 * np.pi * 440 * np.linspace(0, 1, sr, False)) * 0.5).astype(np.float32)
    bio = io.BytesIO()
    sf.write(bio, sine, sr, format="WAV")
    wav_bytes = bio.getvalue()

    decoded = t.decode_audio_bytes(wav_bytes)
    assert len(decoded) == 16000  # Resampled to 16kHz
    assert decoded.dtype == np.float32
