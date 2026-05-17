"""
音频源管理器 — 统一接口管理三种音频源

提供统一的接口管理：
- 系统音频 (WASAPI Loopback)
- 麦克风
- 文件

让 Whisper 转录模块无需修改即可接收新源的数据。
"""

import asyncio
import logging
import time
from enum import Enum
from typing import Optional, Callable, Awaitable

from config import settings
from audio.capture import (
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
    AudioDevice,
    TARGET_SAMPLE_RATE,
    CHUNK_DURATION,
)

logger = logging.getLogger(__name__)


class AudioSource(str, Enum):
    """音频源类型"""
    SYSTEM = "system"       # WASAPI Loopback
    MICROPHONE = "microphone"
    FILE = "file"
    NONE = "none"


# ══════════════════════════════════════════════════════════════
# B2.2/B2.3: 音频源管理器
# ══════════════════════════════════════════════════════════════


class AudioSourceManager:
    """音频源管理器 — 统一接口

    管理四种音频源的状态切换、数据流、音量电平。
    数据输出: 16kHz 16bit mono PCM bytes（Whisper 兼容格式）
    """

    def __init__(self):
        self._source: AudioSource = AudioSource.NONE
        self._wasapi_capture = WasapiLoopbackCapture()
        self._mic_capture = MicrophoneCapture()
        self._running = False
        self._current_rate = 0
        self._current_channels = 0
        self._current_device_name = ""
        self._current_device_id = -1
        self._volume_level = 0.0
        self._last_chunk_time = 0.0
        self._loop_task: Optional[asyncio.Task] = None
        self._on_chunk_callback: Optional[Callable[[bytes], None]] = None
        self._on_status_callback: Optional[Callable[[dict], Awaitable[None]]] = None

    # ── 属性 ─────────────────────────────────────────

    @property
    def source(self) -> str:
        return self._source.value

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def volume_level(self) -> float:
        return self._volume_level

    @property
    def device_name(self) -> str:
        return self._current_device_name

    @property
    def sample_rate(self) -> int:
        return self._current_rate or TARGET_SAMPLE_RATE

    @property
    def channels(self) -> int:
        return self._current_channels or 1

    def get_status(self) -> dict:
        """获取当前音频源状态"""
        admin = is_admin()
        return {
            "source": self._source.value,
            "is_running": self._running,
            "device_id": self._current_device_id,
            "device_name": self._current_device_name,
            "sample_rate": self._current_rate or TARGET_SAMPLE_RATE,
            "channels": self._current_channels or 1,
            "volume_level": self._volume_level,
            "is_admin": admin,
            "message": "",
        }

    # ── 音频源信息查询 ──────────────────────────────

    @staticmethod
    def get_available_sources() -> dict:
        """获取系统音频源可用性信息"""
        admin = is_admin()
        devices, msg = enumerate_audio_devices()

        loopback_devices = [d.to_dict() for d in devices if d.is_loopback]
        mic_devices = [d.to_dict() for d in devices if not d.is_loopback]

        # 检测 WASAPI Loopback 可用性
        wasapi_ok, wasapi_msg = check_wasapi_loopback_available() if admin else (False, "需要管理员权限")
        has_wasapi = wasapi_ok or (admin and len(loopback_devices) > 0)

        return {
            "has_wasapi_loopback": has_wasapi,
            "has_microphone": len(mic_devices) > 0 or HAS_PYAUDIO or HAS_SOUNDDEVICE,
            "is_admin": admin,
            "loopback_devices": loopback_devices,
            "microphone_devices": mic_devices,
            "current_source": "",
            "message": wasapi_msg if not admin else msg,
        }

    @staticmethod
    def list_devices() -> dict:
        """枚举所有可用音频设备"""
        devices, msg = enumerate_audio_devices()
        return {
            "devices": [d.to_dict() for d in devices],
            "message": msg,
            "is_admin": is_admin(),
        }

    # ── 回调注册 ────────────────────────────────────

    def set_on_chunk(self, callback: Callable[[bytes], None]) -> None:
        """注册数据块回调（每 0.5s 收到 16kHz mono PCM 数据）

        Args:
            callback: 接收 pcm_bytes 的可调用对象
        """
        self._on_chunk_callback = callback

    def set_on_status(self, callback: Callable[[dict], Awaitable[None]]) -> None:
        """注册状态推送回调（异步）

        Args:
            callback: async 函数，接收状态 dict
        """
        self._on_status_callback = callback

    # ── 音频源切换 ─────────────────────────────────

    async def switch_source(self, source: str, device_id: int = -1) -> dict:
        """切换音频源

        Args:
            source: "system" | "microphone" | "file" | "none"
            device_id: 指定设备 ID（-1 自动选择）

        Returns:
            dict: 切换结果
        """
        # 停止当前采集
        await self.stop()

        self._source = AudioSource(source)

        if source == AudioSource.NONE.value:
            self._running = False
            logger.info("[SourceManager] 切换到无音频源")
            return {"status": "ok", "source": "none", "message": "已停止采集"}

        result = {}

        if source == AudioSource.SYSTEM.value:
            # 尝试 WASAPI Loopback
            if HAS_PYAUDIOWPATCH and is_admin():
                result = self._wasapi_capture.start(device_id)
            else:
                reason = "pyaudiowpatch 未安装" if not HAS_PYAUDIOWPATCH else "需要管理员权限"
                # 降级到麦克风
                logger.warning("[SourceManager] WASAPI 不可用 (%s)，降级到麦克风", reason)
                self._source = AudioSource.MICROPHONE
                result = self._mic_capture.start(device_id)
                result["degraded_from_wasapi"] = reason

        elif source == AudioSource.MICROPHONE.value:
            result = self._mic_capture.start(device_id)

        else:
            return {"status": "error", "message": f"未知音频源: {source}"}

        if result.get("status") == "ok":
            self._running = True
            self._current_rate = result.get("sample_rate", 0)
            self._current_channels = result.get("channels", 0)
            self._current_device_name = result.get("device_name", "")
            self._current_device_id = result.get("device_id", -1)

            # 启动采集循环（异步）
            self._loop_task = asyncio.create_task(self._capture_loop())

            logger.info(
                "[SourceManager] 切换到 %s: %s (%s Hz, %s ch)",
                self._source.value,
                self._current_device_name,
                self._current_rate,
                self._current_channels,
            )
        else:
            self._reset_state()

        return result

    async def stop(self) -> dict:
        """停止当前音频采集"""
        self._running = False

        if self._loop_task:
            self._loop_task.cancel()
            try:
                await asyncio.wait_for(self._loop_task, timeout=2.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            self._loop_task = None

        self._wasapi_capture.stop()
        self._mic_capture.stop()
        self._reset_state()

        logger.info("[SourceManager] 采集已停止")
        return {"status": "ok", "message": "音频采集已停止"}

    def _reset_state(self) -> None:
        """重置内部状态"""
        self._current_rate = 0
        self._current_channels = 0
        self._current_device_name = ""
        self._current_device_id = -1
        self._volume_level = 0.0

    # ── 采集循环 ───────────────────────────────────

    async def _capture_loop(self) -> None:
        """后台采集循环

        每 CHUNK_DURATION 秒从当前源读取 PCM 数据，
        转换为 16kHz mono 格式，推送给注册的回调。
        """
        logger.info("[SourceManager] 采集循环启动")

        # 状态推送间隔（每 0.5s 推送一次状态）
        status_interval = 0.5
        last_status_time = 0.0

        while self._running:
            try:
                raw_data = None

                if self._source == AudioSource.SYSTEM:
                    raw_data = self._wasapi_capture.read_chunk()
                elif self._source == AudioSource.MICROPHONE:
                    raw_data = self._mic_capture.read_chunk()

                if raw_data is None or len(raw_data) == 0:
                    await asyncio.sleep(0.05)
                    continue

                # 计算音量电平
                self._volume_level = compute_volume_level(raw_data)

                # 转换为 Whisper 格式 (16kHz mono PCM)
                converted = convert_to_whisper_format(
                    raw_data,
                    self._current_rate or 48000,
                    self._current_channels or 2,
                )

                if converted and len(converted) > 0:
                    self._last_chunk_time = time.time()

                    # 推送给注册回调（同步）
                    if self._on_chunk_callback:
                        try:
                            self._on_chunk_callback(converted)
                        except Exception as e:
                            logger.error("[SourceManager] chunk callback error: %s", e)

                # 状态推送
                now = time.time()
                if self._on_status_callback and (now - last_status_time) >= status_interval:
                    last_status_time = now
                    try:
                        await self._on_status_callback(self.get_status())
                    except Exception as e:
                        logger.error("[SourceManager] status callback error: %s", e)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.exception("[SourceManager] 采集循环异常: %s", e)
                await asyncio.sleep(0.1)

        logger.info("[SourceManager] 采集循环结束")
        self._running = False


# ── 全局单例 ─────────────────────────────────────────────

source_manager = AudioSourceManager()
