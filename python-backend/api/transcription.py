"""Transcription API"""

from fastapi import APIRouter

router = APIRouter(prefix="/transcription", tags=["transcription"])


@router.get("")
def list_transcriptions():
    """列表占位"""
    return {"items": [], "total": 0}
