"""Transcription module — Whisper real-time speech recognition"""

from .whisper_engine import WhisperEngine
from .audio_buffer import AudioBuffer

__all__ = [
    "WhisperEngine",
    "AudioBuffer",
]
