"""Audio upload and management API + B2-UPGRADE 音频源管理"""

import os
import io
import logging

from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import Response

from pydub import AudioSegment

from config import settings
from audio.source_manager import source_manager
from schemas.audio import (
    AudioSourceStatus,
    AudioSourceSwitch,
    AudioSourceInfo,
    AudioDeviceInfo,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/audio", tags=["audio"])


# ══════════════════════════════════════════════════════════════
# 旧 B2: 音频文件管理（保留兼容）
# ══════════════════════════════════════════════════════════════

@router.get("")
def list_audio():
    """列表占位"""
    return {"items": [], "total": 0}


@router.get("/segment")
def get_audio_segment(
    word: str = Query(..., description="The word to look up (for logging / future use)"),
    source_audio: str = Query(..., description="Filename of the source recording in the uploads directory"),
    start: float = Query(0.0, ge=0.0, description="Start time in seconds"),
    end: float = Query(0.0, ge=0.0, description="End time in seconds"),
):
    """
    Extract and return a short audio segment from a recording file.

    - Looks up `source_audio` in the configured audio upload directory.
    - Cuts the segment from `start` to `end` (seconds).
    - Converts to 16 kHz mono WAV before returning.
    - Returns 404 if the source file does not exist.
    """
    audio_path = os.path.join(settings.audio_upload_dir, source_audio)

    if not os.path.isfile(audio_path):
        raise HTTPException(status_code=404, detail=f"Audio file not found: {source_audio}")

    try:
        # Load source audio (pydub supports most common formats)
        audio = AudioSegment.from_file(audio_path)

        # Cut segment (pydub uses milliseconds)
        start_ms = int(start * 1000)
        end_ms = int(end * 1000) if end > 0 else len(audio)

        if start_ms >= len(audio):
            raise HTTPException(
                status_code=400,
                detail=f"Start time ({start}s) exceeds audio duration ({len(audio) / 1000:.2f}s)"
            )
        if end_ms > len(audio):
            end_ms = len(audio)

        segment = audio[start_ms:end_ms]

        # Normalise to 16 kHz mono WAV
        segment = segment.set_frame_rate(16000).set_channels(1)

        # Export to in-memory bytes
        buf = io.BytesIO()
        segment.export(buf, format="wav")
        wav_bytes = buf.getvalue()

    except HTTPException:
        raise  # Re-raise validation errors as-is
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to process audio segment: {exc}")

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "Content-Disposition": f'attachment; filename="{word}_segment.wav"',
            "X-Word": word,
        },
    )


# ══════════════════════════════════════════════════════════════
# B2-UPGRADE: 音频源管理 API
# ══════════════════════════════════════════════════════════════

@router.get("/sources", response_model=AudioSourceInfo)
async def get_audio_sources():
    """获取系统音频源可用性信息"""
    info = source_manager.get_available_sources()
    # 附加当前源
    info["current_source"] = source_manager.source
    return info


@router.get("/devices")
async def list_audio_devices():
    """枚举所有可用音频设备"""
    return source_manager.list_devices()


@router.get("/source/status", response_model=AudioSourceStatus)
async def get_audio_source_status():
    """获取当前音频源状态"""
    return source_manager.get_status()


@router.post("/source/switch", response_model=AudioSourceStatus)
async def switch_audio_source(switch: AudioSourceSwitch):
    """切换音频源

    支持三种源:
    - system: WASAPI Loopback（需要管理员权限）
    - microphone: 麦克风
    - none: 停止采集
    """
    result = await source_manager.switch_source(switch.source, switch.device_id)
    status = source_manager.get_status()
    status.message = result.get("message", "")
    if result.get("status") == "error":
        status.message = result.get("message", "切换失败")
        raise HTTPException(status_code=400, detail=status.message)
    return status


@router.post("/source/stop", response_model=AudioSourceStatus)
async def stop_audio_source():
    """停止音频采集"""
    await source_manager.stop()
    return source_manager.get_status()
