"""
Search & Provenance API — 单词/词组检索和原始转录来源追溯
"""
from fastapi import APIRouter, Depends, Query
from database.crud import get_fragments_by_word, search_fragments
from database.models import get_db
from services.nlp_service import nlp_service

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get("/provenance")
async def search_provenance(
    q: str = Query(..., description="单词/词组"),
    session_id: int = Query(None, description="会话ID(可选)"),
    limit: int = Query(20, le=100),
    offset: int = Query(0),
    db=Depends(get_db)
):
    """溯源搜索: 查找包含该单词的转录片段"""
    fragments = get_fragments_by_word(db, q, session_id)
    total = len(fragments)
    # 取分页
    page = fragments[offset:offset + limit]

    # 尝试获取该单词的NLP信息
    nlp_info = {}
    if nlp_service.is_available("en"):
        result = nlp_service.parse(q, "en")
        if result.tokens:
            tok = result.tokens[0]
            nlp_info = {"pos": tok.pos, "dep": tok.dep, "lemma": tok.lemma}

    matches = []
    for f in page:
        # 提取单词出现位置的上下文(前后各30字符)
        idx = f.text.lower().find(q.lower())
        context_before = f.text[max(0, idx - 30):idx] if idx >= 0 else ""
        context_after = f.text[idx + len(q):idx + len(q) + 30] if idx >= 0 else ""

        matches.append({
            "fragment_id": f.id,
            "session_id": f.session_id,
            "text": f.text[:200],
            "context_before": context_before,
            "context_after": context_after,
            "start_time": f.start_time,
            "end_time": f.end_time,
            "source_name": f.source_name,
            "source_video_id": f.source_video_id,
            "language": f.language,
        })

    return {
        "code": 200,
        "data": {
            "word": q,
            "total_matches": total,
            "nlp_info": nlp_info,
            "matches": matches,
        }
    }


@router.get("/fragments")
async def search_fragments_api(
    q: str = Query(..., description="搜索关键词"),
    language: str = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    db=Depends(get_db)
):
    """转录片段搜索"""
    fragments = search_fragments(db, q, language, limit, offset)
    return {
        "code": 200,
        "data": [{
            "id": f.id,
            "session_id": f.session_id,
            "text": f.text[:200],
            "language": f.language,
            "start_time": f.start_time,
            "end_time": f.end_time,
            "source_name": f.source_name,
        } for f in fragments],
    }


@router.get("/suggestions")
async def search_suggestions(
    q: str = Query(..., min_length=1, description="前缀"),
    limit: int = Query(10, le=50)
):
    """前缀搜索建议"""
    # 从活跃会话的词频缓存中搜索(简化版)
    suggestions = []
    try:
        from services.word_frequency import word_frequency_service
        # 遍历缓存中的词，匹配前缀
        all_words = word_frequency_service.get_all_words() if hasattr(word_frequency_service, 'get_all_words') else []
        if not all_words:
            suggestions = []
        else:
            suggestions = [w for w in list(all_words.keys())[:100] if w.lower().startswith(q.lower())][:limit]
    except Exception:
        suggestions = []

    return {
        "code": 200,
        "data": suggestions,
    }
