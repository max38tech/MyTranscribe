"""
FastAPI Backend Server for MyTranscribe Desktop & PWA.
Provides REST and WebSocket endpoints for speech transcription,
disfluency cleaning, model management, history storage, and global dictation.
"""

from __future__ import annotations
import os
import io
import uuid
import socket
import logging
import asyncio
from typing import Optional, List, Dict, Any
import numpy as np

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .transcriber import Transcriber, AVAILABLE_MODELS
from .cleaner import DisfluencyCleaner
from .dictation import DictationService, HOTKEY_PRESETS
from .database import (
    init_db,
    save_transcript,
    list_transcripts,
    delete_transcript,
    toggle_favorite,
    clear_all,
)

from contextlib import asynccontextmanager

# Global instances
transcriber = Transcriber(default_model="base")
init_db()

# Active WebSocket connections for broadcasting
active_websockets: List[WebSocket] = []


def broadcast_event(data: Dict[str, Any]):
    """Helper to broadcast dictation events to all connected UI clients."""
    import json
    msg = json.dumps(data)
    for ws in list(active_websockets):
        try:
            asyncio.create_task(ws.send_text(msg))
        except Exception:
            pass


# Global Dictation Service instance
dictation_service = DictationService(
    transcriber=transcriber,
    hotkey="<ctrl>+<alt>+<space>",
    enable_sound_chimes=True,
    on_transcription_callback=broadcast_event,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown."""
    dictation_service.start()
    yield
    dictation_service.stop()


logger = logging.getLogger("mytranscribe.server")
app = FastAPI(title="MyTranscribe API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_local_ips() -> List[str]:
    """Retrieve local network IP addresses for LAN / PWA access."""
    ips = []
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    if not ips:
        ips.append("127.0.0.1")
    return ips


class CleanRequest(BaseModel):
    text: str
    remove_vocal_fillers: bool = True
    remove_verbal_crutches: bool = False
    remove_repetitions: bool = True
    remove_stutters: bool = True
    custom_fillers: Optional[List[str]] = None
    custom_preserve: Optional[List[str]] = None


class ModelSelectRequest(BaseModel):
    model_id: str
    device: Optional[str] = "auto"
    compute_type: Optional[str] = "auto"


class SaveHistoryRequest(BaseModel):
    title: str
    raw_text: str
    cleaned_text: str
    removed_count: int = 0
    removed_items: Optional[List[Dict[str, Any]]] = None
    duration_seconds: float = 0.0
    model_name: str = "base"
    language: str = "auto"


class DictationConfigRequest(BaseModel):
    hotkey: Optional[str] = None
    enable_sound_chimes: Optional[bool] = None
    enabled: Optional[bool] = None


@app.get("/api/info")
async def get_server_info():
    """Return server status and local network connection info for PWA devices."""
    return {
        "status": "online",
        "active_model": transcriber.current_model_name,
        "device": transcriber.active_device,
        "compute_type": transcriber.active_compute_type,
        "dictation": {
            "hotkey": dictation_service.hotkey_str,
            "is_recording": dictation_service.is_recording,
            "sound_chimes": dictation_service.enable_sound_chimes,
        },
        "local_ips": get_local_ips(),
        "port": 8000,
    }


@app.get("/api/dictation/status")
async def get_dictation_status():
    """Get system-wide dictation state and hotkey settings."""
    return {
        "enabled": dictation_service._hotkey_listener is not None,
        "is_recording": dictation_service.is_recording,
        "is_processing": dictation_service.is_processing,
        "hotkey": dictation_service.hotkey_str,
        "sound_chimes": dictation_service.enable_sound_chimes,
        "presets": HOTKEY_PRESETS,
    }


@app.post("/api/dictation/config")
async def configure_dictation(req: DictationConfigRequest):
    """Update global dictation hotkey and settings."""
    if req.enable_sound_chimes is not None:
        dictation_service.enable_sound_chimes = req.enable_sound_chimes

    if req.hotkey:
        dictation_service.set_hotkey(req.hotkey)

    if req.enabled is not None:
        if req.enabled:
            dictation_service.start()
        else:
            dictation_service.stop()

    return {
        "success": True,
        "hotkey": dictation_service.hotkey_str,
        "sound_chimes": dictation_service.enable_sound_chimes,
        "enabled": dictation_service._hotkey_listener is not None,
    }


@app.post("/api/dictation/toggle")
async def toggle_dictation():
    """Programmatically toggle dictation start/stop."""
    dictation_service._on_hotkey_triggered()
    return {
        "success": True,
        "is_recording": dictation_service.is_recording,
    }


@app.get("/api/models")
async def get_models():
    """Return available Whisper models and current configuration."""
    return {
        "models": AVAILABLE_MODELS,
        "current_model": transcriber.current_model_name,
        "device": transcriber.active_device,
        "compute_type": transcriber.active_compute_type,
    }


@app.post("/api/models/select")
async def select_model(req: ModelSelectRequest):
    """Switch active faster-whisper model."""
    try:
        transcriber.device_setting = req.device or "auto"
        transcriber.compute_type_setting = req.compute_type or "auto"
        transcriber.load_model(req.model_id)
        return {
            "success": True,
            "model": transcriber.current_model_name,
            "device": transcriber.active_device,
            "compute_type": transcriber.active_compute_type,
        }
    except Exception as e:
        logger.error(f"Error loading model {req.model_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/clean")
async def clean_text_endpoint(req: CleanRequest):
    """Clean disfluency and filler words from raw text."""
    cleaner = DisfluencyCleaner(
        remove_vocal_fillers=req.remove_vocal_fillers,
        remove_verbal_crutches=req.remove_verbal_crutches,
        remove_repetitions=req.remove_repetitions,
        remove_stutters=req.remove_stutters,
        custom_fillers=req.custom_fillers,
        custom_preserve=req.custom_preserve,
    )
    result = cleaner.clean(req.text)
    return result


@app.post("/api/transcribe")
async def transcribe_audio_file(
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    remove_vocal_fillers: bool = Form(True),
    remove_verbal_crutches: bool = Form(False),
    remove_repetitions: bool = Form(True),
    remove_stutters: bool = Form(True),
    custom_fillers: Optional[str] = Form(None),
    custom_preserve: Optional[str] = Form(None),
    save_to_history: bool = Form(True),
    title: Optional[str] = Form(None),
):
    """Transcribe an audio file and clean filler words."""
    try:
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty audio file provided.")

        # Decode audio bytes into numpy array
        audio_np = transcriber.decode_audio_bytes(content)

        # Transcribe with faster-whisper
        transcribe_res = transcriber.transcribe(audio_np, language=language)
        raw_text = transcribe_res["text"]

        # Parse custom lists
        custom_fillers_list = [w.strip() for w in custom_fillers.split(",") if w.strip()] if custom_fillers else []
        custom_preserve_list = [w.strip() for w in custom_preserve.split(",") if w.strip()] if custom_preserve else []

        # Clean filler words
        cleaner = DisfluencyCleaner(
            remove_vocal_fillers=remove_vocal_fillers,
            remove_verbal_crutches=remove_verbal_crutches,
            remove_repetitions=remove_repetitions,
            remove_stutters=remove_stutters,
            custom_fillers=custom_fillers_list,
            custom_preserve=custom_preserve_list,
        )
        clean_res = cleaner.clean(raw_text)

        # Save to database if requested
        saved_record = None
        if save_to_history and (clean_res["cleaned_text"] or raw_text):
            record_id = str(uuid.uuid4())
            record_title = title or (clean_res["cleaned_text"][:40] + ("..." if len(clean_res["cleaned_text"]) > 40 else "")) or "Voice Recording"
            saved_record = save_transcript(
                item_id=record_id,
                title=record_title,
                raw_text=raw_text,
                cleaned_text=clean_res["cleaned_text"],
                removed_count=clean_res["removed_count"],
                removed_items=clean_res["removed_items"],
                duration_seconds=transcribe_res["duration"],
                model_name=transcriber.current_model_name,
                language=transcribe_res["language"],
            )

        return {
            "success": True,
            "raw_text": raw_text,
            "cleaned_text": clean_res["cleaned_text"],
            "diff_html": clean_res["diff_html"],
            "removed_count": clean_res["removed_count"],
            "removed_items": clean_res["removed_items"],
            "duration": transcribe_res["duration"],
            "language": transcribe_res["language"],
            "language_probability": transcribe_res["language_probability"],
            "segments": transcribe_res["segments"],
            "saved_record": saved_record,
        }
    except Exception as e:
        logger.error(f"Error in /api/transcribe: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/history")
async def get_history(search: Optional[str] = None, limit: int = 50, offset: int = 0):
    """Retrieve saved transcripts history."""
    items = list_transcripts(search=search, limit=limit, offset=offset)
    return {"items": items, "count": len(items)}


@app.post("/api/history")
async def add_history(req: SaveHistoryRequest):
    """Manually save a transcript to history."""
    record_id = str(uuid.uuid4())
    record = save_transcript(
        item_id=record_id,
        title=req.title,
        raw_text=req.raw_text,
        cleaned_text=req.cleaned_text,
        removed_count=req.removed_count,
        removed_items=req.removed_items,
        duration_seconds=req.duration_seconds,
        model_name=req.model_name,
        language=req.language,
    )
    return record


@app.delete("/api/history/{item_id}")
async def delete_history_item(item_id: str):
    """Delete a transcript item."""
    deleted = delete_transcript(item_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"success": True, "id": item_id}


@app.post("/api/history/{item_id}/favorite")
async def toggle_item_favorite(item_id: str):
    """Toggle favorite status of a transcript."""
    new_fav = toggle_favorite(item_id)
    if new_fav is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return {"success": True, "is_favorite": new_fav}


@app.delete("/api/history")
async def clear_history():
    """Clear all transcript history."""
    count = clear_all()
    return {"success": True, "deleted_count": count}


@app.websocket("/api/ws/stream")
async def websocket_stream_endpoint(websocket: WebSocket):
    """
    WebSocket endpoint for real-time chunked audio streaming and event broadcasting.
    """
    await websocket.accept()
    active_websockets.append(websocket)
    logger.info("WebSocket client connected.")

    audio_buffer = bytearray()
    cleaner = DisfluencyCleaner()
    language = None

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                chunk = message["bytes"]
                audio_buffer.extend(chunk)

                if len(audio_buffer) >= 80000:
                    try:
                        audio_np = transcriber.decode_audio_bytes(bytes(audio_buffer))
                        if len(audio_np) > 8000:
                            transcribe_res = transcriber.transcribe(audio_np, language=language)
                            raw_text = transcribe_res["text"]
                            clean_res = cleaner.clean(raw_text)

                            await websocket.send_json({
                                "type": "partial",
                                "raw_text": raw_text,
                                "cleaned_text": clean_res["cleaned_text"],
                                "diff_html": clean_res["diff_html"],
                                "removed_count": clean_res["removed_count"],
                                "removed_items": clean_res["removed_items"],
                            })
                    except Exception as err:
                        logger.warning(f"Error transcribing stream chunk: {err}")

            elif "text" in message and message["text"]:
                import json
                data = json.loads(message["text"])
                action = data.get("action")

                if action == "config":
                    settings = data.get("settings", {})
                    language = settings.get("language")
                    cleaner = DisfluencyCleaner(
                        remove_vocal_fillers=settings.get("remove_vocal_fillers", True),
                        remove_verbal_crutches=settings.get("remove_verbal_crutches", False),
                        remove_repetitions=settings.get("remove_repetitions", True),
                        remove_stutters=settings.get("remove_stutters", True),
                        custom_fillers=settings.get("custom_fillers", []),
                        custom_preserve=settings.get("custom_preserve", []),
                    )
                    await websocket.send_json({"type": "config_ack", "success": True})

                elif action == "flush":
                    if len(audio_buffer) > 0:
                        try:
                            audio_np = transcriber.decode_audio_bytes(bytes(audio_buffer))
                            transcribe_res = transcriber.transcribe(audio_np, language=language)
                            raw_text = transcribe_res["text"]
                            clean_res = cleaner.clean(raw_text)
                            await websocket.send_json({
                                "type": "final",
                                "raw_text": raw_text,
                                "cleaned_text": clean_res["cleaned_text"],
                                "diff_html": clean_res["diff_html"],
                                "removed_count": clean_res["removed_count"],
                                "removed_items": clean_res["removed_items"],
                                "duration": transcribe_res["duration"],
                            })
                        except Exception as err:
                            logger.error(f"Error finalizing audio stream: {err}")
                        audio_buffer.clear()

                elif action == "clear":
                    audio_buffer.clear()
                    await websocket.send_json({"type": "cleared"})

    except (WebSocketDisconnect, RuntimeError):
        logger.info("WebSocket client disconnected.")
    except Exception as e:
        logger.error(f"WebSocket error: {e}", exc_info=True)
    finally:
        if websocket in active_websockets:
            active_websockets.remove(websocket)


# Mount static frontend directory
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
