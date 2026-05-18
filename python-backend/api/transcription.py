"""Transcription API — 模型管理 + 查询"""

import asyncio
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from enum import Enum
from threading import Lock
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
import httpx
import shutil
from pydantic import BaseModel

from config import settings
from transcription import WhisperEngine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/transcription", tags=["transcription"])

_engine: WhisperEngine | None = None
_executor = ThreadPoolExecutor(max_workers=2)
_tasks: dict[str, dict[str, Any]] = {}
_tasks_lock = Lock()


def _get_engine() -> WhisperEngine:
    global _engine
    if _engine is None:
        _engine = WhisperEngine(model_size=settings.whisper_model)
    return _engine


class TaskStatus(str, Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


class TranscriptionSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str


class TranscriptionWord(BaseModel):
    word: str
    start: float
    end: float
    probability: float | None = None


class TaskResult(BaseModel):
    task_id: str
    status: TaskStatus
    segments: list[TranscriptionSegment] | None = None
    words: list[TranscriptionWord] | None = None
    language: str | None = None
    duration: float | None = None
    message: str | None = None


@router.post("/upload", response_model=TaskResult)
async def upload_audio_for_transcription(file: UploadFile = File(...)):
    """上传音频文件进行转录"""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    task_id = str(uuid.uuid4())
    upload_dir = getattr(settings, 'audio_upload_dir', '/tmp/uploads')
    os.makedirs(upload_dir, exist_ok=True)

    audio_path = os.path.join(upload_dir, f"{task_id}_{file.filename}")

    try:
        content = await file.read()
        with open(audio_path, "wb") as f:
            f.write(content)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {exc}")

    with _tasks_lock:
        _tasks[task_id] = {
            "status": TaskStatus.PENDING,
            "audio_path": audio_path,
            "created_at": datetime.now(),
        }

    asyncio.create_task(_run_transcription(task_id, audio_path))

    return TaskResult(
        task_id=task_id,
        status=TaskStatus.PENDING,
        message="Transcription task created"
    )


class PathRequest(BaseModel):
    path: str
    filename: str | None = None


@router.post("/from-path", response_model=TaskResult)
async def transcribe_from_path(req: PathRequest):
    """根据路径转录音频文件（本地路径或网络URL）"""
    file_path = req.path.strip()
    filename = req.filename

    if not file_path:
        raise HTTPException(status_code=400, detail="Path is required")

    task_id = str(uuid.uuid4())
    upload_dir = getattr(settings, 'audio_upload_dir', '/tmp/uploads')
    os.makedirs(upload_dir, exist_ok=True)

    # 判断类型：本地文件 vs 网络 URL
    if file_path.startswith(('http://', 'https://')):
        # 网络 URL：下载到临时文件
        if not filename:
            filename = file_path.split('/')[-1].split('?')[0] or 'downloaded_audio'
        audio_path = os.path.join(upload_dir, f"{task_id}_{filename}")
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=120.0) as client:
                resp = await client.get(file_path)
                resp.raise_for_status()
                with open(audio_path, 'wb') as f:
                    f.write(resp.content)
            logger.info("Downloaded %s -> %s (%d bytes)", file_path, audio_path, len(resp.content))
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Download failed: {exc}")
    else:
        # 本地文件路径：支持 Windows 路径、file:// URL、/ 开头的路径
        local_path = file_path
        if local_path.startswith('file://'):
            local_path = local_path.replace('file:///', '').replace('file://', '')
        local_path = os.path.normpath(local_path)

        if not os.path.isfile(local_path):
            raise HTTPException(status_code=400, detail=f"File not found: {local_path}")

        if not filename:
            filename = os.path.basename(local_path)
        # 本地文件直接引用，不复制
        audio_path = local_path
        logger.info("Using local file: %s", audio_path)

    with _tasks_lock:
        _tasks[task_id] = {
            "status": TaskStatus.PENDING,
            "audio_path": audio_path,
            "created_at": datetime.now(),
        }

    asyncio.create_task(_run_transcription(task_id, audio_path))

    return TaskResult(
        task_id=task_id,
        status=TaskStatus.PENDING,
        message=f"Transcription task created from {filename}"
    )


async def _run_transcription(task_id: str, audio_path: str):
    """后台运行转录任务"""
    with _tasks_lock:
        _tasks[task_id]["status"] = TaskStatus.PROCESSING

    try:
        engine = _get_engine()
        loop = asyncio.get_event_loop()

        def do_transcribe():
            return engine.transcribe(audio_path, language=None)

        result = await loop.run_in_executor(_executor, do_transcribe)

        segments = [
            TranscriptionSegment(
                id=i,
                start=seg["start"],
                end=seg["end"],
                text=seg["text"]
            )
            for i, seg in enumerate(result.get("segments", []))
        ]

        words = []
        for seg in result.get("segments", []):
            if "words" in seg:
                for w in seg["words"]:
                    words.append(TranscriptionWord(
                        word=w.get("word", ""),
                        start=w.get("start", 0),
                        end=w.get("end", 0),
                        probability=w.get("probability")
                    ))

        with _tasks_lock:
            _tasks[task_id].update({
                "status": TaskStatus.COMPLETED,
                "result": {
                    "segments": segments,
                    "words": words,
                    "language": result.get("language"),
                    "duration": result.get("duration"),
                }
            })

        try:
            os.remove(audio_path)
        except Exception:
            pass

    except Exception as exc:
        logger.error(f"Transcription failed for task {task_id}: {exc}")
        with _tasks_lock:
            _tasks[task_id].update({
                "status": TaskStatus.FAILED,
                "error": str(exc)
            })


@router.get("/task/{task_id}", response_model=TaskResult)
def get_transcription_task(task_id: str):
    """查询转录任务状态和结果"""
    with _tasks_lock:
        task = _tasks.get(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    status = task["status"]
    result = task.get("result", {})

    return TaskResult(
        task_id=task_id,
        status=status,
        segments=result.get("segments"),
        words=result.get("words"),
        language=result.get("language"),
        duration=result.get("duration"),
        message=task.get("error")
    )


@router.get("/model/status")
def model_status():
    """查询当前 Whisper 模型状态"""
    engine = _get_engine()
    return {
        "current": engine.model_size,
        "available": list(WhisperEngine.VALID_MODELS),
        "loaded": engine.is_loaded,
    }


@router.post("/model/switch")
def switch_model(
    model_size: str = Query(
        "base",
        description="Whisper 模型大小",
        pattern=r"^(tiny|base|small|medium|large)$",
    ),
):
    """切换 Whisper 模型大小"""
    engine = _get_engine()
    try:
        engine.switch_model(model_size)
        return {
            "status": "ok",
            "model": model_size,
            "message": f"已切换到 {model_size} 模型",
        }
    except ValueError as exc:
        return {
            "status": "error",
            "model": model_size,
            "message": str(exc),
        }
