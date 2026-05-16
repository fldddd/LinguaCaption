"""
健康检查 API
提供 /api/health 端点用于服务监控。
"""
from fastapi import APIRouter
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import settings

router = APIRouter()


@router.get("/health")
async def health_check():
    """返回服务健康状态"""
    return {
        "status": "ok",
        "app": settings.APP_NAME,
        "version": settings.APP_VERSION,
    }
