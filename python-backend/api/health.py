"""Health check API"""

import time
import logging

from fastapi import APIRouter
from database import session_scope
from config import settings

# Import active_connections from websocket module
from api.websocket import active_connections

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/health", tags=["health"])

# Track server start time
_start_time = time.time()


@router.get("")
def health_check():
    """服务健康检查 — 返回详细状态"""
    uptime_seconds = time.time() - _start_time

    # Check database connectivity
    db_connected = False
    try:
        with session_scope() as session:
            session.execute(
                __import__("sqlalchemy").text("SELECT 1")
            )
            db_connected = True
    except Exception as exc:
        logger.warning("Health check — DB not reachable: %s", exc)

    # Check WebSocket connectivity (at least one active client)
    ws_connected = len(active_connections) > 0

    return {
        "status": "ok",
        "version": settings.version,
        "uptime": uptime_seconds,
        "db_connected": db_connected,
        "ws_connected": ws_connected,
    }
