"""
词频统计 API — FastAPI Router

6个端点:
1. POST /words/record — 记录单词出现（前端实时字幕触发）
2. GET  /words/frequency/{word} — 单个单词词频
3. GET  /words/top — 词频排行榜
4. GET  /words/occurrences/{word} — 单词来源追踪
5. POST /words/session/reset — 重置会话计数
6. POST /words/flush — 强制刷新缓存到数据库
"""

import logging

from fastapi import APIRouter, Query, Path

from services.word_frequency import get_word_frequency_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/words", tags=["words"])


# ══════════════════════════════════════════════════════════════
# Endpoints
# ══════════════════════════════════════════════════════════════


@router.post("/record", summary="记录单词出现")
def record_words(
    text: str = Query(..., min_length=1, max_length=1000, description="字幕文本"),
    source_type: str = Query("transcription", description="来源类型"),
    source_id: str = Query("", description="来源标识（任务ID/文件名）"),
    subtitle_text: str = Query("", description="上下文句子"),
    start_time: float = Query(0.0, description="开始时间"),
    end_time: float = Query(0.0, description="结束时间"),
):
    """
    记录一段字幕文本中所有单词的出现。
    前端实时字幕每次推送时调用此接口。
    """
    service = get_word_frequency_service()
    result = service.record_text(
        text=text,
        source_type=source_type,
        source_id=source_id,
        subtitle_text=subtitle_text or text,
        start_time=start_time,
        end_time=end_time,
    )
    return {
        "success": True,
        "recorded": result["recorded"],
        "words": result["words"],
    }


@router.get("/frequency/{word}", summary="获取单个单词词频")
def get_word_frequency(
    word: str = Path(..., min_length=1, max_length=255, description="单词"),
):
    """
    获取指定单词的累计词频和会话词频统计。
    优先读取内存缓存，缓存未命中时查询数据库。
    """
    service = get_word_frequency_service()
    result = service.get_frequency(word)
    if result is None:
        # 返回零值而不是 404（词频为0也是有效结果）
        return {
            "word": word.lower().strip(),
            "cumulative_count": 0,
            "session_count": 0,
            "first_seen_at": None,
            "last_seen_at": None,
        }
    return result


@router.get("/top", summary="词频排行榜")
def get_top_frequencies(
    limit: int = Query(50, ge=1, le=200, description="返回数量"),
    sort_by: str = Query("cumulative", regex="^(cumulative|session)$", description="排序维度"),
):
    """
    获取词频排行榜，按累计次数或会话次数排序。
    """
    service = get_word_frequency_service()
    return service.get_top_frequencies(limit=limit, sort_by=sort_by)


@router.get("/occurrences/{word}", summary="单词来源追踪")
def get_word_occurrences(
    word: str = Path(..., min_length=1, max_length=255, description="单词"),
    limit: int = Query(20, ge=1, le=100, description="返回数量"),
    offset: int = Query(0, ge=0, description="偏移量"),
):
    """
    获取单词的出现记录，包括来源文件、上下文句子、时间戳等。
    用于前端词频面板的「来源追踪」功能。
    """
    service = get_word_frequency_service()
    return service.get_word_occurrences(word=word, limit=limit, offset=offset)


@router.post("/session/reset", summary="重置会话计数")
def reset_session_count():
    """
    重置所有单词的会话计数。
    通常在新建转录会话时调用。
    """
    service = get_word_frequency_service()
    count = service.reset_session()
    return {
        "success": True,
        "reset_count": count,
        "message": f"已重置 {count} 个单词的会话计数",
    }


@router.post("/flush", summary="强制刷新缓存到数据库")
def flush_word_frequencies():
    """
    强制将内存中的词频缓存刷新到数据库。
    通常在应用关闭前或手动触发。
    """
    service = get_word_frequency_service()
    count = service.force_flush()
    return {
        "success": True,
        "flushed_count": count,
        "message": f"已刷新 {count} 个单词到数据库",
    }
