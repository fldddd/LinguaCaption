"""
会话管理 API — Phase 4.4

提供三个端点：
1. GET /api/sessions/list       — 会话列表
2. GET /api/sessions/active     — 当前活跃会话
3. GET /api/sessions/{id}/fragments — 指定会话的片段列表
"""

import logging

from fastapi import APIRouter, Depends

from database.crud import (
    get_active_session,
    list_sessions,
    get_fragments_by_session,
)
from database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.get("/list")
async def get_sessions(limit: int = 20, offset: int = 0, db=Depends(get_db)):
    """获取会话列表（分页）"""
    sessions = list_sessions(db, limit, offset)
    return {
        "code": 200,
        "data": [
            {
                "id": s.id,
                "type": s.session_type,
                "language": s.language,
                "source_name": s.source_name,
                "started_at": s.started_at.isoformat() if s.started_at else None,
                "ended_at": s.ended_at.isoformat() if s.ended_at else None,
                "total_fragments": s.total_fragments,
                "total_words": s.total_words,
                "is_active": s.is_active,
            }
            for s in sessions
        ],
    }


@router.get("/active")
async def get_active(db=Depends(get_db)):
    """获取当前活跃会话"""
    session = get_active_session(db)
    if not session:
        return {"code": 404, "msg": "No active session"}
    return {
        "code": 200,
        "data": {
            "id": session.id,
            "type": session.session_type,
            "language": session.language,
            "source_name": session.source_name,
        },
    }


@router.get("/{session_id}/fragments")
async def get_fragments(
    session_id: int,
    limit: int = 100,
    offset: int = 0,
    db=Depends(get_db),
):
    """获取指定会话的转录片段列表"""
    fragments = get_fragments_by_session(db, session_id, limit, offset)
    return {
        "code": 200,
        "data": [
            {
                "id": f.id,
                "text": f.text[:200],
                "language": f.language,
                "start_time": f.start_time,
                "end_time": f.end_time,
                "source_name": f.source_name,
                "word_count": f.word_count,
            }
            for f in fragments
        ],
    }
