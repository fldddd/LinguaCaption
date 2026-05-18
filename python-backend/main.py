"""LinguaCaption 鍚庣涓诲叆鍙?

闆嗘垚 B2-UPGRADE: WASAPI Loopback 绯荤粺闊抽閲囬泦
"""

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
from api.words import router as words_router

logger = logging.getLogger(__name__)

from audio.source_manager import source_manager
from audio.capture import is_admin, check_wasapi_loopback_available


@asynccontextmanager
async def lifespan(app: FastAPI):
    """搴旂敤鐢熷懡鍛ㄦ湡锛氬垵濮嬪寲鏁版嵁搴?+ 鍒涘缓蹇呰鐩綍 + 妫€娴嬮煶棰戠幆澧?""
    import os
    from database import init_db
    from database.migrations import apply_migrations

    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.audio_upload_dir, exist_ok=True)
    os.makedirs(settings.transcription_cache_dir, exist_ok=True)
    os.makedirs(settings.whisper_model_dir, exist_ok=True)

    # 鍒濆鍖栨暟鎹簱骞舵墽琛岃縼绉?
    db_path = os.path.join(settings.data_dir, "linguacaption.db")
    os.environ.setdefault("LINGUACAPTION_DB_PATH", db_path)
    init_db(db_path)
    apply_migrations()

    # 鈹€鈹€ B2-UPGRADE: 闊抽鐜妫€娴?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    logger.info("[LinguaCaption v%s] 鍚庣鍚姩", settings.version)
    logger.info("  鏁版嵁鐩綍: %s", settings.data_dir)
    logger.info("  闊抽鐩綍: %s", settings.audio_upload_dir)
    logger.info("  鏁版嵁搴? %s", db_path)
    logger.info("  Whisper妯″瀷: %s", settings.whisper_model)

    # 妫€娴嬬鐞嗗憳鏉冮檺
    admin = is_admin()
    logger.info("  绠＄悊鍛樻潈闄? %s", '鉁?鏄? if admin else '鉂?鍚?)
    if not admin:
        logger.warning("  WASAPI Loopback 闇€瑕佺鐞嗗憳鏉冮檺锛屽皢闄嶇骇浣跨敤楹﹀厠椋庨噰闆?)

    # 妫€娴?WASAPI Loopback
    wasapi_ok, wasapi_msg = check_wasapi_loopback_available() if admin else (False, "闇€瑕佺鐞嗗憳鏉冮檺")
    if wasapi_ok:
        logger.info("  WASAPI Loopback: 鉁?鍙敤")
    else:
        logger.warning("  WASAPI Loopback: 鉂?%s", wasapi_msg)

    # 妫€娴嬪彲鐢ㄩ煶棰戣澶?
    from audio.capture import enumerate_audio_devices
    devices, _ = enumerate_audio_devices()
    loopback_count = sum(1 for d in devices if d.is_loopback)
    mic_count = sum(1 for d in devices if not d.is_loopback)
    logger.info("  闊抽璁惧: %d 涓?(Loopback: %d, 楹﹀厠椋? %d)", len(devices), loopback_count, mic_count)

    yield

    # 鈹€鈹€ 鍏抽棴娓呯悊 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    await source_manager.stop()
    logger.info("[LinguaCaption] 鍚庣鍏抽棴")


app = FastAPI(
    title="LinguaCaption API",
    version=settings.version,
    description="鑻辫瀛楀箷瀛︿範宸ュ叿鍚庣鏈嶅姟 鈥?WASAPI Loopback 绯荤粺闊抽閲囬泦",
    lifespan=lifespan,
)

# CORS 涓棿浠?
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 鏃ュ織涓棿浠?
app.add_middleware(LoggerMiddleware)

# 娉ㄥ唽璺敱
app.include_router(health_router, prefix="/api")
app.include_router(audio_router, prefix="/api")
app.include_router(transcription_router, prefix="/api")
app.include_router(vocabulary_router, prefix="/api")
app.include_router(websocket_router, prefix="/api")
app.include_router(video_router, prefix="/api")
app.include_router(words_router, prefix="/api")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
    )
