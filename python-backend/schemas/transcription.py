"""
B4 转录管理 — Pydantic 请求/响应模型
"""

from typing import Optional
from pydantic import BaseModel, Field


# ══════════════════════════════════════════════════════════════
# 请求模型
# ══════════════════════════════════════════════════════════════

class TranscriptionCreate(BaseModel):
    """创建转录请求"""
    audio_id: int = Field(..., gt=0, description="关联音频ID")
    model: Optional[str] = Field(None, description="Whisper 模型名 (默认使用配置)")


# ══════════════════════════════════════════════════════════════
# 响应模型
# ══════════════════════════════════════════════════════════════

class TranscriptionResponse(BaseModel):
    """转录记录响应"""
    id: int
    audio_id: int
    status: str
    model: Optional[str] = None
    language: Optional[str] = None
    segments_count: Optional[int] = None
    error_message: Optional[str] = None
    duration_seconds: Optional[float] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None

    model_config = {"from_attributes": True}


class TranscriptionDetailResponse(TranscriptionResponse):
    """转录详情响应（含完整文本）"""
    full_text: Optional[str] = None
    segments: Optional[list[dict]] = None


class TranscriptionListResponse(BaseModel):
    """转录列表分页响应"""
    items: list[TranscriptionResponse]
    total: int
    page: int
    page_size: int
    total_pages: int
