"""Health check API"""

from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
def health_check():
    """服务健康检查"""
    return {"status": "ok", "version": "0.1.0"}
