"""
B5 生词收藏 API — FastAPI Router
8 个端点覆盖生词的完整 CRUD + 复习 + 统计
"""

import logging

from fastapi import APIRouter, HTTPException, Query

from database.crud import (
    create_vocab, get_vocab, get_vocab_by_word, list_vocabs,
    update_vocab, delete_vocab,
    record_review, get_due_reviews, get_learning_stats,
)
from schemas.vocabulary import (
    VocabCreate, VocabUpdate, ReviewCreate,
    VocabListResponse, VocabResponse, VocabWithReviewResponse,
    LearningStatsResponse, ReviewResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/vocabulary", tags=["vocab"])


# ══════════════════════════════════════════════════════════════
# 生词 CRUD
# ══════════════════════════════════════════════════════════════

@router.get("", response_model=VocabListResponse, summary="分页列出生词")
def get_vocab_list(
    page: int = Query(1, ge=1, description="页码"),
    page_size: int = Query(20, ge=1, le=100, description="每页数量"),
    mastered: bool | None = Query(None, description="按掌握状态过滤"),
    search: str | None = Query(None, max_length=255, description="搜索关键词"),
):
    """分页列出生词列表，支持搜索和掌握状态过滤"""
    return list_vocabs(page=page, page_size=page_size, mastered=mastered, search=search)


@router.post("", response_model=VocabResponse, status_code=201, summary="添加生词")
def add_vocab(payload: VocabCreate):
    """添加新生词，自动创建关联的学习记录"""
    existing = get_vocab_by_word(payload.word)
    if existing:
        raise HTTPException(status_code=409, detail=f"生词已存在: {payload.word}")
    result = create_vocab(
        word=payload.word,
        translation=payload.translation,
        phonetic=payload.phonetic,
        part_of_speech=payload.part_of_speech,
        context=payload.context,
        source_subtitle_id=payload.source_subtitle_id,
    )
    if result is None:
        raise HTTPException(status_code=409, detail=f"生词已存在: {payload.word}")
    return result


@router.get("/{vocab_id}", response_model=VocabResponse, summary="获取生词详情")
def get_vocab_detail(vocab_id: int):
    """按 ID 获取生词详细信息"""
    vocab = get_vocab(vocab_id)
    if not vocab:
        raise HTTPException(status_code=404, detail=f"生词不存在: id={vocab_id}")
    return vocab


@router.put("/{vocab_id}", response_model=VocabResponse, summary="更新生词")
def update_vocab_detail(vocab_id: int, payload: VocabUpdate):
    """更新生词的字段（只传入需要修改的字段）"""
    updates = payload.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="没有提供需要更新的字段")
    result = update_vocab(vocab_id, **updates)
    if not result:
        raise HTTPException(status_code=404, detail=f"生词不存在: id={vocab_id}")
    return result


@router.delete("/{vocab_id}", status_code=204, summary="删除生词")
def delete_vocab_item(vocab_id: int):
    """删除生词（级联删除关联的学习记录）"""
    if not delete_vocab(vocab_id):
        raise HTTPException(status_code=404, detail=f"生词不存在: id={vocab_id}")
    return None


# ══════════════════════════════════════════════════════════════
# 复习 & 统计
# ══════════════════════════════════════════════════════════════

@router.post("/{vocab_id}/review", response_model=ReviewResponse, summary="记录复习结果")
def review_vocab(vocab_id: int, payload: ReviewCreate):
    """记录一次复习结果，更新间隔重复算法状态"""
    result = record_review(
        vocab_id=vocab_id,
        correct=payload.correct,
        difficulty=payload.difficulty,
    )
    if not result:
        raise HTTPException(status_code=404, detail=f"生词或学习记录不存在: vocab_id={vocab_id}")
    return result


@router.get("/due/list", response_model=list[VocabWithReviewResponse], summary="待复习列表")
def get_due_review_list(
    limit: int = Query(20, ge=1, le=100, description="最大返回数量"),
):
    """获取所有到期待复习的生词列表（含生词信息）"""
    return get_due_reviews(limit=limit)


@router.get("/stats/summary", response_model=LearningStatsResponse, summary="学习统计")
def get_learning_statistics():
    """获取学习总体统计：总词汇数、已掌握、待复习等"""
    return get_learning_stats()
