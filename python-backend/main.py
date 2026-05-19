"""LinguaCaption 后端主入口

集成 B2-UPGRADE: WASAPI Loopback 系统音频采集
"""

import os
import sys

# Windows 控制台默认 GBK 编码无法输出 emoji，强制使用 UTF-8
if sys.platform == "win32":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import logging
import traceback
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from middleware.logger import LoggerMiddleware
from api.health import router as health_router
from api.audio import router as audio_router
from api.transcription import router as transcription_router
from api.vocabulary import router as vocabulary_router
from api.websocket import router as websocket_router
from api.video import router as video_router

logger = logging.getLogger(__name__)

from audio.source_manager import source_manager
from audio.capture import is_admin, check_wasapi_loopback_available


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：初始化数据库 + 创建必要目录 + 检测音频环境"""
    import os
    from database import init_db
    from database.migrations import apply_migrations

    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.audio_upload_dir, exist_ok=True)
    os.makedirs(settings.transcription_cache_dir, exist_ok=True)
    os.makedirs(settings.whisper_model_dir, exist_ok=True)

    # 初始化数据库并执行迁移
    db_path = os.path.join(settings.data_dir, "linguacaption.db")
    os.environ.setdefault("LINGUACAPTION_DB_PATH", db_path)
    init_db(db_path)
    apply_migrations()

    # ── B2-UPGRADE: 音频环境检测 ─────────────────────────
    logger.info("[LinguaCaption v%s] 后端启动", settings.version)
    logger.info("  数据目录: %s", settings.data_dir)
    logger.info("  音频目录: %s", settings.audio_upload_dir)
    logger.info("  数据库: %s", db_path)
    logger.info("  Whisper模型: %s", settings.whisper_model)

    # 检测管理员权限
    admin = is_admin()
    logger.info("  管理员权限: %s", '✅ 是' if admin else '❌ 否')
    if not admin:
        logger.warning("  WASAPI Loopback 需要管理员权限，将降级使用麦克风采集")

    # 检测 WASAPI Loopback
    wasapi_ok, wasapi_msg = check_wasapi_loopback_available() if admin else (False, "需要管理员权限")
    if wasapi_ok:
        logger.info("  WASAPI Loopback: ✅ 可用")
    else:
        logger.warning("  WASAPI Loopback: ❌ %s", wasapi_msg)

    # 检测可用音频设备
    from audio.capture import enumerate_audio_devices
    devices, _ = enumerate_audio_devices()
    loopback_count = sum(1 for d in devices if d.is_loopback)
    mic_count = sum(1 for d in devices if not d.is_loopback)
    logger.info("  音频设备: %d 个 (Loopback: %d, 麦克风: %d)", len(devices), loopback_count, mic_count)

    yield

    # ── 关闭清理 ──────────────────────────────────────────
    await source_manager.stop()
    logger.info("[LinguaCaption] 后端关闭")


app = FastAPI(
    title="LinguaCaption API",
    version=settings.version,
    description="英语字幕学习工具后端服务 — WASAPI Loopback 系统音频采集",
    lifespan=lifespan,
)

# CORS 中间件
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 全局异常处理：确保异常响应也携带 CORS 头
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # HTTPException 直接让 FastAPI 处理，不包装
    if isinstance(exc, HTTPException):
        raise exc
    logger.error("Unhandled exception on %s %s: %s", request.method, request.url.path, traceback.format_exc())
    origin = request.headers.get("origin", "")
    headers = {}
    if origin in settings.cors_origins:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=500,
        content={"detail": f"服务器内部错误: {type(exc).__name__}: {str(exc)}"},
        headers=headers,
    )

# 日志中间件
app.add_middleware(LoggerMiddleware)

# 注册路由
app.include_router(health_router, prefix="/api")
app.include_router(audio_router, prefix="/api")
app.include_router(transcription_router, prefix="/api")
app.include_router(vocabulary_router, prefix="/api")
app.include_router(websocket_router, prefix="/api")
app.include_router(video_router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )
