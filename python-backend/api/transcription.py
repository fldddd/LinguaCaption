"""Transcription API — 模型管理 + 查询

优化（F4）：
- 添加进度百分比跟踪（基于 VAD 分段进度）
- 支持上传时指定模型大小
- 支持查询转录进度

集成 Phase 4.3 NLP 解析和会话生命周期管理
"""
import asyncio
import logging
import os
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from enum import Enum
from threading import Lock
from typing import Any

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
import httpx
import shutil
from pydantic import BaseModel
from werkzeug.utils import secure_filename

from config import settings
from transcription.whisper_engine import get_engine, WhisperEngine
from database.crud import create_session, close_session, insert_fragment
from database import get_session
from services.nlp_service import nlp_service

# 允许的音频/视频 MIME 类型（Whisper 可从视频中提取音频）
ALLOWED_AUDIO_TYPES = {
    "audio/mpeg",
    "audio/wav",
    "audio/x-wav",
    "audio/mp3",
    "audio/mp4",
    "audio/flac",
    "audio/ogg",
    "audio/x-m4a",
    "audio/aac",
    "video/mp4",
    "video/webm",
    "video/x-matroska",
    "video/quicktime",
    "video/avi",
    "application/octet-stream",  # 浏览器可能未正确设置 MIME 类型
}

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/transcription", tags=["transcription"])

# 全局引擎（通过 get_engine() 懒加载，单例）
_executor = ThreadPoolExecutor(max_workers=2)
_tasks: dict[str, dict[str, Any]] = {}
_tasks_lock = Lock()


def _get_engine() -> WhisperEngine:
    """获取全局 WhisperEngine 单例（复用模型，避免重复加载）"""
    return get_engine()


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
    progress: float | None = None       # 进度百分比 0-100
    message: str | None = None


@router.post("/upload", response_model=TaskResult)
async def upload_audio_for_transcription(
    file: UploadFile = File(...),
    model: str = Query(None, description="Whisper 模型大小: tiny/base/small/medium/large"),
):
    """上传音频文件进行转录

    - 支持通过 model 参数指定模型（默认使用 config 中的设置）
    - 返回 task_id，前端轮询 /task/{task_id} 获取进度和结果
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    # 校验音频 MIME 类型
    if file.content_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Invalid file type '{file.content_type}'. "
                f"Only audio files are allowed: "
                f"{', '.join(sorted(ALLOWED_AUDIO_TYPES))}"
            )
        )

    task_id = str(uuid.uuid4())
    upload_dir = getattr(settings, 'audio_upload_dir', '/tmp/uploads')
    os.makedirs(upload_dir, exist_ok=True)

    # 安全文件名，防止路径穿越
    safe_name = secure_filename(file.filename)
    audio_path = os.path.join(upload_dir, f"{task_id}_{safe_name}")

    try:
        # ✅ 按块异步写入，避免大文件损坏
        with open(audio_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                f.write(chunk)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {exc}")

    with _tasks_lock:
        _tasks[task_id] = {
            "status": TaskStatus.PENDING,
            "audio_path": audio_path,
            "created_at": datetime.now(),
            "progress": 0.0,
            "model": model or settings.whisper_model,
        }

    asyncio.create_task(_run_transcription(task_id, audio_path, model))

    return TaskResult(
        task_id=task_id,
        status=TaskStatus.PENDING,
        progress=0.0,
        message="Transcription task created"
    )


class PathRequest(BaseModel):
    path: str
    filename: str | None = None


@router.post("/from-path", response_model=TaskResult)
async def transcribe_from_path(
    req: PathRequest,
    model: str = Query(None, description="Whisper 模型大小: tiny/base/small/medium/large"),
):
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
            "progress": 0.0,
            "model": model or settings.whisper_model,
        }

    asyncio.create_task(_run_transcription(task_id, audio_path, model))

    return TaskResult(
        task_id=task_id,
        status=TaskStatus.PENDING,
        progress=0.0,
        message=f"Transcription task created from {filename}"
    )


async def _run_transcription(task_id: str, audio_path: str, model: str | None = None):
    """后台运行转录任务，带进度跟踪 + 会话管理 + NLP 解析"""
    with _tasks_lock:
        _tasks[task_id]["status"] = TaskStatus.PROCESSING
        _tasks[task_id]["progress"] = 5.0  # 开始处理

    # ---- 创建会话 ----
    db = get_session()
    try:
        session_obj = create_session(
            db=db,
            session_type="file_transcribe",
            language="en",
            source_type="file",
            source_name=os.path.basename(audio_path),
            source_url=audio_path,
        )
        session_id = session_obj.id
        logger.info("File transcription session created: id=%d, file=%s", session_id, os.path.basename(audio_path))
    finally:
        db.close()

    try:
        # 如果指定了模型且与当前不同，先切换
        if model:
            engine = get_engine(model)
        else:
            engine = _get_engine()

        loop = asyncio.get_event_loop()

        # 更新进度：文件已加载完成
        with _tasks_lock:
            _tasks[task_id]["progress"] = 10.0

        def do_transcribe():
            return engine.transcribe(audio_path, language=None)

        result = await loop.run_in_executor(_executor, do_transcribe)

        # 转录完成，更新进度
        with _tasks_lock:
            _tasks[task_id]["progress"] = 90.0

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

        # ---- NLP 解析 + 片段存储 ----
        detected_language = result.get("language", "en") or "en"
        for seg_data in result.get("segments", []):
            seg_text = seg_data.get("text", "").strip()
            if not seg_text:
                continue
            seg_start = seg_data.get("start", 0)
            seg_end = seg_data.get("end", 0)

            try:
                # NLP 解析（同步但非阻塞整体流程）
                parsed = nlp_service.parse(seg_text, detected_language)
                logger.debug(
                    "NLP parsed segment: %d tokens, %d phrases",
                    len(parsed.tokens),
                    len(parsed.phrases),
                )
                parsed_at = datetime.now(timezone.utc)
            except Exception:
                logger.debug("NLP parsing skipped for segment (model unavailable)")
                parsed_at = None

            # 存储片段
            db = get_session()
            try:
                insert_fragment(
                    db=db,
                    session_id=session_id,
                    text=seg_text,
                    language=detected_language,
                    start_time=seg_start,
                    end_time=seg_end,
                    source_type="file",
                    source_name=os.path.basename(audio_path),
                    parsed_at=parsed_at,
                )
            finally:
                db.close()

        # 关闭会话
        db = get_session()
        try:
            close_session(db, session_id)
            logger.info("File transcription session %d closed", session_id)
        finally:
            db.close()

        with _tasks_lock:
            _tasks[task_id].update({
                "status": TaskStatus.COMPLETED,
                "progress": 100.0,
                "result": {
                    "segments": segments,
                    "words": words,
                    "language": detected_language,
                    "duration": result.get("duration"),
                }
            })

        try:
            os.remove(audio_path)
        except Exception:
            pass

    except Exception as exc:
        logger.error(f"Transcription failed for task {task_id}: {exc}")
        # 确保会话关闭
        if session_id is not None:
            db = get_session()
            try:
                close_session(db, session_id)
            finally:
                db.close()
        with _tasks_lock:
            _tasks[task_id].update({
                "status": TaskStatus.FAILED,
                "progress": 0.0,
                "error": str(exc)
            })


@router.get("/task/{task_id}", response_model=TaskResult)
def get_transcription_task(task_id: str):
    """查询转录任务状态和结果（支持进度查询）"""
    with _tasks_lock:
        task = _tasks.get(task_id)

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    status = task["status"]
    result = task.get("result", {})
    progress = task.get("progress", 0.0)

    return TaskResult(
        task_id=task_id,
        status=status,
        progress=progress,
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
        "tiny",
        description="Whisper 模型大小",
        pattern=r"^(tiny|base|small|medium|large)$",
    ),
):
    """切换 Whisper 模型大小（热切换，复用全局引擎）"""
    get_engine(model_size)
    return {
        "status": "ok",
        "model": model_size,
        "message": f"已切换到 {model_size} 模型",
    }
