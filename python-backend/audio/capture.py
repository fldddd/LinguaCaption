"""
音频采集模块 — WASAPI Loopback 系统音频捕获 + 麦克风采集

使用 pyaudiowpatch 库实现 Windows WASAPI Loopback 捕获系统音频输出。
支持管理员权限检测和自动降级到麦克风采集。

输出格式: 16kHz 16bit mono PCM (Whisper 输入格式)
"""

import asyncio
import logging
import struct
import time
from pathlib import Path
from typing import Optional, Callable, Awaitable

import numpy as np

from config import settings

logger = logging.getLogger(__name__)

# ── 依赖检测 ───────────────────────────────────────────────

try:
    import pyaudio
    import pyaudiowpatch as pyaudiop
    HAS_PYAUDIOWPATCH = True
except ImportError:
    HAS_PYAUDIOWPATCH = False

HAS_PYAUDIO = False
try:
    import pyaudio  # noqa: F811
    HAS_PYAUDIO = True
except ImportError:
    pass

try:
    import sounddevice as sd
    HAS_SOUNDDEVICE = True
except ImportError:
    HAS_SOUNDDEVICE = False

# ── 常量 ───────────────────────────────────────────────────

TARGET_SAMPLE_RATE = 16000  # Whisper 需求
TARGET_CHANNELS = 1
TARGET_SAMPLE_WIDTH = 2  # 16bit
CHUNK_DURATION = settings.audio_chunk_duration  # 0.5s
FRAMES_PER_CHUNK = int(TARGET_SAMPLE_RATE * CHUNK_DURATION)  # 8000 frames


# ══════════════════════════════════════════════════════════════
# B2.1: 权限检测
# ══════════════════════════════════════════════════════════════

def is_admin() -> bool:
    """检测当前进程是否以管理员权限运行 (Windows)"""
    try:
        import ctypes
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except (ImportError, AttributeError):
        return False


def check_wasapi_loopback_available() -> tuple[bool, str]:
    """检测 WASAPI Loopback 功能是否可用

    Returns:
        (available, message) 元组
    """
    if not HAS_PYAUDIOWPATCH:
        return False, "pyaudiowpatch 未安装"

    if not is_admin():
        return False, "WASAPI Loopback 需要管理员权限运行"

    try:
        pa = pyaudio.PyAudio()
        try:
            # 尝试获取 WASAPI 主机 API 信息
            wasapi_info = pyaudiop.get_wasapi_device_info(pa)
            loopback = wasapi_info.get("loopback")
            if loopback:
                return True, "WASAPI Loopback 可用"
            return False, "未找到 WASAPI Loopback 设备"
        finally:
            pa.terminate()
    except Exception as e:
        return False, f"WASAPI 检测失败: {e}"


# ══════════════════════════════════════════════════════════════
# B2.1: 设备枚举
# ══════════════════════════════════════════════════════════════

class AudioDevice:
    """音频设备信息"""
    __slots__ = ("index", "name", "channels", "sample_rate", "is_loopback", "host_api", "is_default")

    def __init__(
        self,
        index: int,
        name: str,
        channels: int,
        sample_rate: float,
        is_loopback: bool = False,
        host_api: str = "",
        is_default: bool = False,
    ):
        self.index = index
        self.name = name
        self.channels = channels
        self.sample_rate = int(sample_rate)
        self.is_loopback = is_loopback
        self.host_api = host_api
        self.is_default = is_default

    def to_dict(self) -> dict:
        return {
            "id": self.index,
            "name": self.name,
            "channels": self.channels,
            "sample_rate": self.sample_rate,
            "is_loopback": self.is_loopback,
            "host_api": self.host_api,
            "is_default": self.is_default,
        }


def enumerate_audio_devices() -> tuple[list[AudioDevice], str]:
    """枚举所有可用的音频设备（输入 + Loopback）

    Returns:
        (devices_list, message)
    """
    devices: list[AudioDevice] = []
    message = ""

    if HAS_PYAUDIOWPATCH and is_admin():
        # 使用 pyaudiowpatch 枚举（可检测 WASAPI Loopback）
        try:
            pa = pyaudio.PyAudio()
            try:
                # 用 pyaudiowpatch 获取 WASAPI 设备
                wasapi_info = pyaudiop.get_wasapi_device_info(pa)

                # 添加 Loopback 设备
                loopback = wasapi_info.get("loopback")
                if loopback:
                    devices.append(AudioDevice(
                        index=0,
                        name=loopback.get("name", "System Audio (WASAPI Loopback)"),
                        channels=loopback.get("maxInputChannels", 2),
                        sample_rate=loopback.get("defaultSampleRate", 48000),
                        is_loopback=True,
                        host_api="WASAPI",
                        is_default=True,
                    ))

                # 添加普通输入设备
                default_input = wasapi_info.get("default_input")
                for i in range(pa.get_device_count()):
                    try:
                        info = pa.get_device_info_by_index(i)
                        if info.get("maxInputChannels", 0) > 0:
                            name = info.get("name", f"Device {i}")
                            is_def = (
                                default_input is not None
                                and info.get("index") == default_input.get("index")
                            )
                            devices.append(AudioDevice(
                                index=i,
                                name=name,
                                channels=int(info.get("maxInputChannels", 1)),
                                sample_rate=info.get("defaultSampleRate", 44100),
                                is_loopback=False,
                                host_api=info.get("hostApiName", ""),
                                is_default=is_def,
                            ))
                    except Exception:
                        continue

                message = f"发现 {len(devices)} 个音频设备（含 WASAPI Loopback）"
            finally:
                pa.terminate()
        except Exception as e:
            logger.warning("pyaudiowpatch 枚举失败，降级到 sounddevice: %s", e)
            message = f"pyaudiowpatch 枚举失败: {e}"
            devices = _enumerate_sounddevice()

    elif HAS_SOUNDDEVICE:
        # 使用 sounddevice 枚举（无管理员权限时的后备）
        devices = _enumerate_sounddevice()
        message = f"使用 sounddevice 枚举: {len(devices)} 个设备"

    elif HAS_PYAUDIO:
        # 使用普通 PyAudio
        try:
            pa = pyaudio.PyAudio()
            try:
                for i in range(pa.get_device_count()):
                    try:
                        info = pa.get_device_info_by_index(i)
                        if info.get("maxInputChannels", 0) > 0:
                            name = info.get("name", f"Device {i}")
                            is_loopback = any(
                                kw in name
                                for kw in ("WASAPI", "Loopback", "Stereo Mix", "What U Hear", "立体声混音")
                            )
                            devices.append(AudioDevice(
                                index=i,
                                name=name,
                                channels=int(info.get("maxInputChannels", 1)),
                                sample_rate=info.get("defaultSampleRate", 44100),
                                is_loopback=is_loopback,
                                host_api="MME",
                                is_default=(i == pa.get_default_input_device_info().get("index")),
                            ))
                    except Exception:
                        continue
                message = f"使用 PyAudio 枚举: {len(devices)} 个设备"
            finally:
                pa.terminate()
        except Exception as e:
            message = f"设备枚举失败: {e}"
    else:
        message = "未安装音频库 (pyaudio/sounddevice)"

    return devices, message


def _enumerate_sounddevice() -> list[AudioDevice]:
    """使用 sounddevice 枚举设备"""
    devices = []
    try:
        default_input = sd.default.device[0]
        device_list = sd.query_devices()
        for i in range(len(device_list)):
            try:
                info = sd.query_devices(i)
                if info["max_input_channels"] > 0:
                    name = str(info["name"])
                    is_loopback = any(
                        kw in name
                        for kw in ("WASAPI", "Loopback", "Stereo Mix", "What U Hear", "立体声混音")
                    )
                    devices.append(AudioDevice(
                        index=i,
                        name=name,
                        channels=int(info["max_input_channels"]),
                        sample_rate=int(info["default_samplerate"]),
                        is_loopback=is_loopback,
                        host_api=str(info.get("hostapi", "")),
                        is_default=(i == default_input),
                    ))
            except Exception:
                continue
    except Exception as e:
        logger.error("sounddevice 枚举失败: %s", e)
    return devices


# ══════════════════════════════════════════════════════════════
# B2.1: WASAPI Loopback 采集引擎
# ══════════════════════════════════════════════════════════════

class WasapiLoopbackCapture:
    """WASAPI Loopback 系统音频采集引擎

    使用 pyaudiowpatch 捕获系统所有音频输出。
    输出: 16kHz 16bit mono PCM 块（0.5s/块）
    """

    def __init__(self):
        self._pa: Optional[pyaudio.PyAudio] = None
        self._stream: Optional[pyaudio.Stream] = None
        self._running = False
        self._device_name = ""
        self._input_rate = 48000  # WASAPI 默认
        self._input_channels = 2  # WASAPI 输出默认立体声

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def device_name(self) -> str:
        return self._device_name

    def start(self, device_index: int = -1) -> dict:
        """启动 WASAPI Loopback 采集

        Args:
            device_index: 设备索引（-1 自动选择默认 Loopback）

        Returns:
            dict: 启动结果
        """
        if not HAS_PYAUDIOWPATCH:
            return {"status": "error", "message": "pyaudiowpatch 未安装"}

        if not is_admin():
            return {"status": "error", "message": "需要管理员权限运行 WASAPI Loopback"}

        self.stop()

        try:
            self._pa = pyaudio.PyAudio()
            wasapi_info = pyaudiop.get_wasapi_device_info(self._pa)
            loopback_info = wasapi_info.get("loopback")

            if not loopback_info:
                self._pa.terminate()
                self._pa = None
                return {"status": "error", "message": "未找到 WASAPI Loopback 设备"}

            loopback_index = loopback_info["index"]
            loopback_name = loopback_info.get("name", "System Audio")
            loopback_rate = int(loopback_info.get("defaultSampleRate", 48000))
            loopback_channels = int(loopback_info.get("maxInputChannels", 2))

            self._device_name = loopback_name
            self._input_rate = loopback_rate
            self._input_channels = loopback_channels

            logger.info(
                "[WasapiLoopback] 打开设备: %s (%d Hz, %d ch)",
                loopback_name, loopback_rate, loopback_channels,
            )

            self._stream = self._pa.open(
                format=pyaudio.paInt16,
                channels=loopback_channels,
                rate=loopback_rate,
                input=True,
                input_device_index=loopback_index,
                frames_per_buffer=FRAMES_PER_CHUNK,
                stream_callback=None,
            )

            self._running = True
            return {
                "status": "ok",
                "source": "system",
                "device_name": loopback_name,
                "device_id": loopback_index,
                "sample_rate": loopback_rate,
                "channels": loopback_channels,
            }

        except Exception as e:
            logger.exception("[WasapiLoopback] 启动失败: %s", e)
            self._cleanup()
            return {"status": "error", "message": f"WASAPI Loopback 启动失败: {e}"}

    def stop(self) -> None:
        """停止采集"""
        self._running = False
        self._cleanup()

    def _cleanup(self) -> None:
        """清理资源"""
        if self._stream:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._pa:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None

    def read_chunk(self) -> Optional[bytes]:
        """读取一个音频块

        Returns:
            原始 PCM 数据 (原始采样率/声道)，或 None
        """
        if not self._running or not self._stream:
            return None

        try:
            frames_to_read = int(self._input_rate * CHUNK_DURATION)
            data = self._stream.read(frames_to_read, exception_on_overflow=False)
            return data
        except OSError as e:
            if "input overflowed" in str(e).lower():
                # overflow 可以继续，返回空数据
                logger.warning("[WasapiLoopback] input overflow")
                return None
            logger.error("[WasapiLoopback] 读取失败: %s", e)
            return None
        except Exception as e:
            logger.error("[WasapiLoopback] 读取异常: %s", e)
            return None


# ══════════════════════════════════════════════════════════════
# B2.1: 麦克风采集引擎
# ══════════════════════════════════════════════════════════════

class MicrophoneCapture:
    """麦克风音频采集引擎（无管理员权限时的降级方案）

    使用 PyAudio 或 sounddevice 采集麦克风输入。
    输出: 16kHz 16bit mono PCM 块（0.5s/块）
    """

    def __init__(self):
        self._pa: Optional[pyaudio.PyAudio] = None
        self._stream: Optional[pyaudio.Stream] = None
        self._sd_stream: Optional[sd.InputStream] = None
        self._running = False
        self._device_name = ""
        self._input_rate = 44100
        self._input_channels = 1
        self._using_sounddevice = False

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def device_name(self) -> str:
        return self._device_name

    def start(self, device_index: int = -1) -> dict:
        """启动麦克风采集

        Args:
            device_index: 设备索引（-1 自动选择默认麦克风）

        Returns:
            dict: 启动结果
        """
        self.stop()

        # 优先使用 PyAudio
        if HAS_PYAUDIO:
            try:
                return self._start_pyaudio(device_index)
            except Exception as e:
                logger.warning("PyAudio 麦克风启动失败，尝试 sounddevice: %s", e)

        # 降级到 sounddevice
        if HAS_SOUNDDEVICE:
            try:
                return self._start_sounddevice(device_index)
            except Exception as e:
                return {"status": "error", "message": f"麦克风启动失败: {e}"}

        return {"status": "error", "message": "未安装音频库"}

    def _start_pyaudio(self, device_index: int = -1) -> dict:
        """使用 PyAudio 启动麦克风"""
        self._pa = pyaudio.PyAudio()

        if device_index < 0:
            default_info = self._pa.get_default_input_device_info()
            device_index = default_info["index"]
            device_name = default_info["name"]
        else:
            device_info = self._pa.get_device_info_by_index(device_index)
            device_name = device_info["name"]

        device_info = self._pa.get_device_info_by_index(device_index)
        sample_rate = int(device_info.get("defaultSampleRate", 44100))
        channels = min(int(device_info.get("maxInputChannels", 1)), 2)

        self._device_name = device_name
        self._input_rate = sample_rate
        self._input_channels = channels

        self._stream = self._pa.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            input_device_index=device_index,
            frames_per_buffer=FRAMES_PER_CHUNK,
            stream_callback=None,
        )

        self._running = True
        self._using_sounddevice = False
        return {
            "status": "ok",
            "source": "microphone",
            "device_name": device_name,
            "device_id": device_index,
            "sample_rate": sample_rate,
            "channels": channels,
        }

    def _start_sounddevice(self, device_index: int = -1) -> dict:
        """使用 sounddevice 启动麦克风"""
        if device_index < 0:
            device_index = sd.default.device[0]

        info = sd.query_devices(device_index)
        device_name = str(info["name"])
        sample_rate = int(info["default_samplerate"])
        channels = min(int(info["max_input_channels"]), 2)

        self._device_name = device_name
        self._input_rate = sample_rate
        self._input_channels = channels

        self._sd_stream = sd.InputStream(
            device=device_index,
            samplerate=sample_rate,
            channels=channels,
            dtype="int16",
            blocksize=FRAMES_PER_CHUNK,
        )
        self._sd_stream.start()

        self._running = True
        self._using_sounddevice = True
        return {
            "status": "ok",
            "source": "microphone",
            "device_name": device_name,
            "device_id": device_index,
            "sample_rate": sample_rate,
            "channels": channels,
        }

    def stop(self) -> None:
        """停止采集"""
        self._running = False
        if self._stream:
            try:
                self._stream.stop_stream()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        if self._sd_stream:
            try:
                self._sd_stream.stop()
                self._sd_stream.close()
            except Exception:
                pass
            self._sd_stream = None
        if self._pa:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None

    def read_chunk(self) -> Optional[bytes]:
        """读取一个音频块

        Returns:
            原始 PCM 数据，或 None
        """
        if not self._running:
            return None

        try:
            if self._using_sounddevice and self._sd_stream:
                frames_to_read = int(self._input_rate * CHUNK_DURATION)
                data, _ = self._sd_stream.read(frames_to_read)
                return data.tobytes()
            elif self._stream:
                frames_to_read = int(self._input_rate * CHUNK_DURATION)
                data = self._stream.read(frames_to_read, exception_on_overflow=False)
                return data
        except Exception as e:
            logger.error("[MicrophoneCapture] 读取失败: %s", e)
            return None

        return None


# ══════════════════════════════════════════════════════════════
# B2.4: 音频格式转换
# ══════════════════════════════════════════════════════════════

def convert_to_whisper_format(
    raw_data: bytes,
    src_rate: int,
    src_channels: int,
    target_rate: int = TARGET_SAMPLE_RATE,
) -> bytes:
    """将原始 PCM 音频数据转换为 Whisper 要求的 16kHz mono PCM

    纯 in-memory 处理，不写磁盘。

    Args:
        raw_data: PCM int16 原始音频数据
        src_rate: 原始采样率
        src_channels: 原始声道数
        target_rate: 目标采样率（默认 16000）

    Returns:
        转换后的 PCM int16 bytes (16kHz, mono)
    """
    if src_rate <= 0 or src_channels <= 0 or not raw_data:
        return b""

    samples = np.frombuffer(raw_data, dtype=np.int16).astype(np.float32)

    # 多声道混音为单声道（平均）
    if src_channels > 1:
        try:
            samples = samples.reshape(-1, src_channels).mean(axis=1)
        except ValueError:
            # 数据不足 reshape，补零
            total = len(samples)
            needed = ((total + src_channels - 1) // src_channels) * src_channels
            padded = np.pad(samples, (0, needed - total), mode="constant")
            samples = padded.reshape(-1, src_channels).mean(axis=1)

    # 重采样到 target_rate
    if src_rate != target_rate and len(samples) > 1:
        old_len = len(samples)
        new_len = max(1, int(old_len * target_rate / src_rate))
        samples = np.interp(
            np.linspace(0, old_len - 1, new_len),
            np.arange(old_len),
            samples,
        )

    # 裁剪并转回 int16
    samples = np.clip(samples, -32768, 32767).astype(np.int16)

    return samples.tobytes()


def compute_volume_level(pcm_data: bytes) -> float:
    """计算 PCM 数据的 RMS 音量电平 (0.0 - 1.0)

    Args:
        pcm_data: PCM int16 bytes

    Returns:
        归一化音量电平
    """
    if not pcm_data or len(pcm_data) < 2:
        return 0.0

    try:
        samples = np.frombuffer(pcm_data, dtype=np.int16).astype(np.float32)
        if len(samples) == 0:
            return 0.0
        rms = np.sqrt(np.mean(samples ** 2))
        # 归一化到 0-1 (int16 最大 32768)
        level = min(rms / 32768.0, 1.0)
        return round(level, 4)
    except Exception:
        return 0.0
