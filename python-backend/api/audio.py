"""Audio upload and management API"""

from fastapi import APIRouter

router = APIRouter(prefix="/audio", tags=["audio"])


@router.get("")
def list_audio():
    """列表占位"""
    return {"items": [], "total": 0}
