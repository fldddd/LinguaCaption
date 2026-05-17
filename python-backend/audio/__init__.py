"""
音频处理模块 — WASAPI Loopback / 麦克风 / 文件音频采集
"""

from .capture import (
    AudioDevice,
    WasapiLoopbackCapture,
    MicrophoneCapture,
    convert_to_whisper_format,
    compute_volume_level,
    is_admin,
    check_wasapi_loopback_available,
    enumerate_audio_devices,
    HAS_PYAUDIOWPATCH,
    HAS_PYAUDIO,
    HAS_SOUNDDEVICE,
)
from .source_manager import AudioSourceManager, AudioSource, source_manager

__all__ = [
    "AudioDevice",
    "WasapiLoopbackCapture",
    "MicrophoneCapture",
    "convert_to_whisper_format",
    "compute_volume_level",
    "is_admin",
    "check_wasapi_loopback_available",
    "enumerate_audio_devices",
    "HAS_PYAUDIOWPATCH",
    "HAS_PYAUDIO",
    "HAS_SOUNDDEVICE",
    "AudioSourceManager",
    "AudioSource",
    "source_manager",
]
