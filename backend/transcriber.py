"""
Faster-Whisper Speech Recognition Engine wrapper for MyTranscribe.
"""

from __future__ import annotations
import os
import io
import threading
import logging
from typing import Optional, List, Dict, Any, Tuple, Union
import numpy as np

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mytranscribe.transcriber")

try:
    from faster_whisper import WhisperModel
    FASTER_WHISPER_AVAILABLE = True
except ImportError:
    FASTER_WHISPER_AVAILABLE = False
    logger.warning("faster-whisper not installed. Running in mock/fallback mode.")

try:
    import av
    AV_AVAILABLE = True
except ImportError:
    AV_AVAILABLE = False

try:
    import soundfile as sf
    SOUNDFILE_AVAILABLE = True
except ImportError:
    SOUNDFILE_AVAILABLE = False


AVAILABLE_MODELS = [
    {"id": "tiny", "name": "Tiny (Fastest, ~75MB)", "size_mb": 75, "recommended": "Quick real-time / Low RAM"},
    {"id": "tiny.en", "name": "Tiny English (~75MB)", "size_mb": 75, "recommended": "Fast English only"},
    {"id": "base", "name": "Base (Balanced, ~145MB)", "size_mb": 145, "recommended": "Recommended default"},
    {"id": "base.en", "name": "Base English (~145MB)", "size_mb": 145, "recommended": "English default"},
    {"id": "small", "name": "Small (Accurate, ~480MB)", "size_mb": 480, "recommended": "High accuracy"},
    {"id": "small.en", "name": "Small English (~480MB)", "size_mb": 480, "recommended": "High accuracy English"},
    {"id": "medium", "name": "Medium (Very Accurate, ~1.5GB)", "size_mb": 1500, "recommended": "Best for complex audio"},
    {"id": "large-v3", "name": "Large v3 (State of the art, ~3GB)", "size_mb": 3000, "recommended": "Maximum accuracy"},
    {"id": "large-v3-turbo", "name": "Large v3 Turbo (Fast Large, ~1.6GB)", "size_mb": 1600, "recommended": "Fast & ultra-accurate"},
]


class Transcriber:
    """Thread-safe manager for faster-whisper models."""

    def __init__(
        self,
        default_model: str = "base",
        device: str = "auto",
        compute_type: str = "auto",
        download_root: Optional[str] = None,
    ):
        self.current_model_name = default_model
        self.device_setting = device
        self.compute_type_setting = compute_type
        self.download_root = download_root or os.path.join(os.path.expanduser("~"), ".cache", "mytranscribe_models")
        self._model: Optional[Any] = None
        self._lock = threading.Lock()
        self.active_device = "cpu"
        self.active_compute_type = "int8"

    def _determine_device_and_compute(self) -> Tuple[str, str]:
        """Detect CUDA availability or fallback to CPU with int8 quantization."""
        if self.device_setting == "cuda":
            dev = "cuda"
            ct = self.compute_type_setting if self.compute_type_setting != "auto" else "float16"
        elif self.device_setting == "cpu":
            dev = "cpu"
            ct = self.compute_type_setting if self.compute_type_setting != "auto" else "int8"
        else:
            # Auto-detection
            try:
                import ctranslate2
                cuda_available = ctranslate2.get_cuda_device_count() > 0
            except Exception:
                cuda_available = False

            if cuda_available:
                dev = "cuda"
                ct = "float16"
            else:
                dev = "cpu"
                ct = "int8"

        return dev, ct

    def load_model(self, model_name: Optional[str] = None) -> Any:
        """Load or switch the active faster-whisper model with automatic compute-type fallback."""
        if model_name:
            self.current_model_name = model_name

        with self._lock:
            if not FASTER_WHISPER_AVAILABLE:
                logger.warning("faster-whisper is not available in environment.")
                return None

            device, preferred_compute = self._determine_device_and_compute()
            os.makedirs(self.download_root, exist_ok=True)

            # Build prioritized list of (device, compute_type) candidates
            candidates: List[Tuple[str, str]] = []
            if device == "cuda":
                if preferred_compute != "auto":
                    candidates.append(("cuda", preferred_compute))
                candidates.extend([
                    ("cuda", "float16"),
                    ("cuda", "int8_float16"),
                    ("cuda", "int8"),
                    ("cuda", "float32"),
                    ("cpu", "int8"),
                    ("cpu", "float32"),
                ])
            else:
                if preferred_compute != "auto":
                    candidates.append(("cpu", preferred_compute))
                candidates.extend([
                    ("cpu", "int8"),
                    ("cpu", "float32"),
                ])

            # Deduplicate candidates while preserving order
            unique_candidates = []
            for d, ct in candidates:
                if (d, ct) not in unique_candidates:
                    unique_candidates.append((d, ct))

            last_err = None
            cpu_threads = max(1, os.cpu_count() or 4)

            for dev, ct in unique_candidates:
                try:
                    logger.info(
                        f"Attempting to load faster-whisper model '{self.current_model_name}' on {dev} ({ct})..."
                    )
                    self._model = WhisperModel(
                        self.current_model_name,
                        device=dev,
                        compute_type=ct,
                        download_root=self.download_root,
                        cpu_threads=cpu_threads,
                    )
                    self.active_device = dev
                    self.active_compute_type = ct
                    logger.info(f"Model '{self.current_model_name}' loaded successfully on {dev} ({ct}).")
                    return self._model
                except (ValueError, Exception) as err:
                    last_err = err
                    logger.warning(
                        f"Compute type '{ct}' on '{dev}' not supported ({err}). Trying next fallback..."
                    )

            raise RuntimeError(f"Could not load faster-whisper model '{self.current_model_name}': {last_err}")

    def get_model(self) -> Any:
        """Returns the loaded model, loading it if not yet initialized."""
        if self._model is None:
            return self.load_model(self.current_model_name)
        return self._model

    def transcribe(
        self,
        audio: Union[str, np.ndarray, io.BytesIO],
        language: Optional[str] = None,
        vad_filter: bool = True,
        beam_size: int = 5,
        word_timestamps: bool = False,
    ) -> Dict[str, Any]:
        """
        Transcribe audio input (file path, bytes buffer, or numpy array).
        Returns raw transcribed text and segment metadata.
        """
        if not FASTER_WHISPER_AVAILABLE:
            raise RuntimeError(
                "faster-whisper is not installed. Transcription cannot proceed. "
                "Please install faster-whisper (see setup instructions) and restart the app."
            )

        model = self.get_model()
        if model is None:
            raise RuntimeError("Failed to initialize faster-whisper model.")

        vad_params = {
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 400,
        } if vad_filter else None

        lang = None if (language in (None, "auto", "")) else language

        with self._lock:
            segments_gen, info = model.transcribe(
                audio,
                language=lang,
                vad_filter=vad_filter,
                vad_parameters=vad_params,
                beam_size=beam_size,
                word_timestamps=word_timestamps,
            )

            segments_list = []
            full_text_parts = []

            for seg in segments_gen:
                full_text_parts.append(seg.text.strip())
                seg_dict = {
                    "start": round(seg.start, 2),
                    "end": round(seg.end, 2),
                    "text": seg.text.strip(),
                }
                if word_timestamps and hasattr(seg, "words") and seg.words:
                    seg_dict["words"] = [
                        {"word": w.word, "start": round(w.start, 2), "end": round(w.end, 2), "probability": round(w.probability, 2)}
                        for w in seg.words
                    ]
                segments_list.append(seg_dict)

            full_text = " ".join(full_text_parts).strip()

            return {
                "text": full_text,
                "language": info.language,
                "language_probability": round(info.language_probability, 3),
                "duration": round(info.duration, 2),
                "segments": segments_list,
            }

    def decode_audio_bytes(self, audio_bytes: bytes, target_sample_rate: int = 16000) -> np.ndarray:
        """
        Decode raw audio bytes in any container/codec (WebM, Opus, MP4, AAC, WAV, MP3, OGG)
        into a 16kHz mono float32 numpy array.
        """
        if not audio_bytes:
            return np.array([], dtype=np.float32)

        # Primary: PyAV for universal container & codec decoding (WebM, Opus, MP4, AAC, etc.)
        if AV_AVAILABLE:
            try:
                bio = io.BytesIO(audio_bytes)
                with av.open(bio) as container:
                    stream = next((s for s in container.streams if s.type == "audio"), None)
                    if stream is not None:
                        resampler = av.AudioResampler(
                            format="fltp",
                            layout="mono",
                            rate=target_sample_rate,
                        )
                        frames = []
                        for frame in container.decode(stream):
                            for resampled in resampler.resample(frame):
                                frames.append(resampled.to_ndarray())
                        for resampled in resampler.resample(None):
                            frames.append(resampled.to_ndarray())

                        if frames:
                            audio_np = np.concatenate(frames, axis=1).squeeze(0)
                            return audio_np.astype(np.float32)
            except Exception as av_err:
                logger.debug(f"PyAV decode fallback: {av_err}")

        # Secondary: soundfile for standard WAV / FLAC / OGG
        if SOUNDFILE_AVAILABLE:
            try:
                bio = io.BytesIO(audio_bytes)
                data, samplerate = sf.read(bio, dtype="float32")
                if len(data.shape) > 1:
                    data = data.mean(axis=1)

                if samplerate != target_sample_rate and len(data) > 0:
                    target_len = int(len(data) * target_sample_rate / samplerate)
                    data = np.interp(
                        np.linspace(0, len(data), target_len, endpoint=False),
                        np.arange(len(data)),
                        data,
                    ).astype(np.float32)

                return data.astype(np.float32)
            except Exception as sf_err:
                logger.debug(f"soundfile decode fallback: {sf_err}")

        # Tertiary: Raw 16-bit 16000Hz PCM fallback
        even_len = len(audio_bytes) - (len(audio_bytes) % 2)
        if even_len > 0:
            return (np.frombuffer(audio_bytes[:even_len], dtype=np.int16).astype(np.float32) / 32768.0)

        return np.array([], dtype=np.float32)
