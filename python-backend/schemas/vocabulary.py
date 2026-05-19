"""
B5 生词收藏 API — Pydantic 请求/响应模型
"""

from typing import Optional
from pydantic import BaseModel, Field, field_validator


# ══════════════════════════════════════════════════════════════
# 请求模型
# ══════════════════════════════════════════════════════════════

class VocabCreate(BaseModel):
    """创建生词请求"""
    word: str = Field(..., min_length=1, max_length=255, description="单词原文")
    translation: Optional[str] = Field(None, max_length=500, description="中文翻译")
    phonetic: Optional[str] = Field(None, max_length=255, description="音标")
    part_of_speech: Optional[str] = Field(None, max_length=50, description="词性")
    context: Optional[str] = Field(None, description="上下文句子")
    source_subtitle_id: Optional[int] = Field(None, description="来源字幕ID")

    @field_validator("word")
    @classmethod
    def word_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("单词不能为空")
        return v

    @field_validator("part_of_speech")
    @classmethod
    def validate_pos(cls, v: Optional[str]) -> Optional[str]:
        valid_pos = {"noun", "verb", "adj", "adv", "pron", "prep", "conj", "interj", "num", "art"}
        if v and v.lower() not in valid_pos:
            raise ValueError(f"无效词性: {v}，有效值: {', '.join(sorted(valid_pos))}")
        return v.lower() if v else v


class VocabUpdate(BaseModel):
    """更新生词请求"""
    word: Optional[str] = Field(None, min_length=1, max_length=255, description="单词原文")
    translation: Optional[str] = Field(None, max_length=500, description="中文翻译")
    phonetic: Optional[str] = Field(None, max_length=255, description="音标")
    part_of_speech: Optional[str] = Field(None, max_length=50, description="词性")
    context: Optional[str] = Field(None, description="上下文句子")
    source_subtitle_id: Optional[int] = Field(None, description="来源字幕ID")

    @field_validator("part_of_speech")
    @classmethod
    def validate_pos(cls, v: Optional[str]) -> Optional[str]:
        valid_pos = {"noun", "verb", "adj", "adv", "pron", "prep", "conj", "interj", "num", "art"}
        if v and v.lower() not in valid_pos:
            raise ValueError(f"无效词性: {v}")
        return v.lower() if v else v


class ReviewCreate(BaseModel):
    """记录复习结果请求"""
    correct: bool = Field(True, description="是否正确")
    difficulty: int = Field(3, ge=1, le=5, description="难度评级 (1-5)")


class VocabListParams(BaseModel):
    """生词列表查询参数"""
    page: int = Field(1, ge=1, description="页码")
    page_size: int = Field(20, ge=1, le=100, description="每页数量")
    mastered: Optional[bool] = Field(None, description="按掌握状态过滤")
    search: Optional[str] = Field(None, max_length=255, description="搜索关键词")


# ══════════════════════════════════════════════════════════════
# 响应模型
# ══════════════════════════════════════════════════════════════

class VocabResponse(BaseModel):
    """生词响应"""
    id: int
    word: str
    translation: Optional[str] = None
    phonetic: Optional[str] = None
    part_of_speech: Optional[str] = None
    context: Optional[str] = None
    familiarity: int = 0
    source_subtitle_id: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

    model_config = {"from_attributes": True}


class VocabListResponse(BaseModel):
    """生词列表分页响应"""
    items: list[VocabResponse]
    total: int
    page: int
    page_size: int
    total_pages: int


class VocabWithReviewResponse(BaseModel):
    """生词+学习记录（待复习列表用）"""
    record: dict
    vocab: VocabResponse


class LearningStatsResponse(BaseModel):
    """学习统计响应"""
    total_vocabs: int
    mastered: int
    learning: int
    due_reviews: int


class ReviewResponse(BaseModel):
    """复习记录响应"""
    id: int
    vocab_id: int
    review_count: int
    correct_count: int
    last_reviewed_at: Optional[str] = None
    next_review_at: Optional[str] = None
    mastered: bool
    difficulty: int
    created_at: Optional[str] = None
