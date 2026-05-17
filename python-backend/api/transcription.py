"""Transcription API — 模型管理 + 查询"""

import logging

from fastapi import APIRouter, Query

from transcription import WhisperEngine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/transcription", tags=["transcription"])

# 全局引擎实例（单例，在首次调用时延迟初始化）
_engine: WhisperEngine | None = None


def _get_engine() -> WhisperEngine:
    """获取或创建全局 WhisperEngine 实例"""
    global _engine
    if _engine is None:
        from config import settings
        _engine = WhisperEngine(model_size=settings.whisper_model)
    return _engine


# ====================================================================
# 列表端点（占位保留）
# ====================================================================


@router.get("")
def list_transcriptions():
    """列表占位"""
    return {"items": [], "total": 0}


# ====================================================================
# 模型管理
# ====================================================================


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
    """切换 Whisper 模型大小

    支持模型: tiny, base, small, medium, large
    切换会重新加载模型（耗时数秒），推荐仅用于开发调试。
    """
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
