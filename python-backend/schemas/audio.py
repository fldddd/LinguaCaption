"""
B2 音频上传管理 — Pydantic 请求/响应模型
"""

from typing import Optional
from pydantic import BaseModel, Field


# ══════════════════════════════════════════════════════════════
# 响应模型
# ══════════════════════════════════════════════════════════════

class AudioResponse(BaseModel):
    """音频记录响应"""
    id: int
    filename: str
    filepath: str
    filesize: int
    duration: Optional[float] = None
    format: str
    created_at: Optional[str] = None

    model_config = {"from_attributes": True}


class AudioListResponse(BaseModel):
    """音频列表分页响应"""
    items: list[AudioResponse]
    total: int
    page: int
    page_size: int
    total_pages: int
