"""LinguaCaption 后端主入口"""

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from middleware.logger import LoggerMiddleware
from api.health import router as health_router
from api.audio import router as audio_router
from api.transcription import router as transcription_router
from api.vocabulary import router as vocabulary_router
from api.websocket import router as websocket_router
from api.video import router as video_router

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：初始化数据库 + 创建必要目录"""
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

    logger.info("LinguaCaption v%s 后端启动", settings.version)
    logger.debug("数据目录: %s", settings.data_dir)
    logger.debug("音频目录: %s", settings.audio_upload_dir)
    logger.debug("数据库: %s", db_path)
    logger.debug("Whisper模型: %s", settings.whisper_model)
    yield
    logger.info("LinguaCaption 后端关闭")


app = FastAPI(
    title="LinguaCaption API",
    version=settings.version,
    description="英语字幕学习工具后端服务",
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
