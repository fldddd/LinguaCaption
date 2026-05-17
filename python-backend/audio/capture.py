"""音频采集模块 — 系统音频捕获、麦克风采集、格式转换"""

import asyncio
import logging
import struct
import wave
import time
from pathlib import Path
from typing import Optional

from config import settings

logger = logging.getLogger(__name__)

# PyAudio 延迟导入（可能未安装）
try:
    import pyaudio
    HAS_PYAUDIO = True
except ImportError:
    HAS_PYAUDIO = False


class AudioDevice:
    """音频设备信息"""
    def __init__(self, index: int, name: str, channels: int, sample_rate: float, is_loopback: bool = False):
        self.index = index
        self.name = name
        self.channels = channels
        self.sample_rate = int(sample_rate)
        self.is_loopback = is_loopback

    def to_dict(self) -> dict:
        return {
            "id": self.index,
            "name": self.name,
            "channels": self.channels,
            "sample_rate": self.sample_rate,
            "is_loopback": self.is_loopback,
        }


class AudioCapture:
    """音频采集引擎 — 支持系统音频和麦克风"""

    def __init__(self):
        self._stream: Optional[pyaudio.Stream] = None
        self._pa: Optional[pyaudio.PyAudio] = None
        self._running = False
        self._source: str = ""
        self._device_id: int = -1
        self._input_rate: int = settings.audio_sample_rate
        self._input_channels: int = 1

    # ── B2.1: 音频设备枚举 ─────────────────────────────────

    def list_devices(self) -> list[dict]:
        """枚举所有可用的音频输入设备"""
        if not HAS_PYAUDIO:
            return self._mock_devices()

        devices = []
        pa = pyaudio.PyAudio()
        try:
            for i in range(pa.get_device_count()):
                info = pa.get_device_info_by_index(i)
                if info["maxInputChannels"] > 0:
                    name = info["name"]
                    is_loopback = "WASAPI" in name or "Loopback" in name or "Stereo Mix" in name
                    devices.append(AudioDevice(
                        index=i,
                        name=name,
                        channels=info["maxInputChannels"],
                        sample_rate=info["defaultSampleRate"],
                        is_loopback=is_loopback,
                    ))
        finally:
            pa.terminate()

        return [d.to_dict() for d in devices]

    def _mock_devices(self) -> list[dict]:
        """返回模拟设备列表（PyAudio 未安装时的后备）"""
        return [
            {"id": 0, "name": "系统音频 (WASAPI Loopback)", "channels": 2, "sample_rate": 48000, "is_loopback": True},
            {"id": 1, "name": "麦克风 (Realtek Audio)", "channels": 1, "sample_rate": 44100, "is_loopback": False},
            {"id": 2, "name": "无", "channels": 0, "sample_rate": 0, "is_loopback": False},
        ]

    # ── B2.2 / B2.3: 开始/停止采集 ─────────────────────────

    def start(self, source: str, device_id: int = -1) -> dict:
        """开始音频采集

        Args:
            source: "system" | "microphone" | "none"
            device_id: 指定设备ID（-1 表示自动选择）
        """
        if self._running:
            self.stop()

        self._source = source
        self._device_id = device_id

        if source == "none":
            return {"status": "ok", "source": "none", "message": "已停止采集"}

        if not HAS_PYAUDIO:
            return {"status": "warning", "source": source, "message": "PyAudio 未安装，使用模拟模式"}

        self._pa = pyaudio.PyAudio()
        devices = self._list_pa_devices()

        # 自动选择设备
        if device_id < 0:
            if source == "system":
                # 找 WASAPI Loopback 设备
                loopback = [d for d in devices if d.is_loopback]
                if loopback:
                    device_id = loopback[0].index
                else:
                    return {"status": "error", "message": "未找到系统音频设备 (WASAPI Loopback)"}
            else:
                # 找第一个可用麦克风
                mics = [d for d in devices if not d.is_loopback]
                if mics:
                    device_id = mics[0].index
                else:
                    return {"status": "error", "message": "未找到麦克风设备"}

        device_info = self._pa.get_device_info_by_index(device_id)
        sample_rate = int(device_info.get("defaultSampleRate", settings.audio_sample_rate))
        channels = min(device_info.get("maxInputChannels", 1), 2)
        self._input_rate = sample_rate
        self._input_channels = channels

        self._stream = self._pa.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=sample_rate,
            input=True,
            input_device_index=device_id,
            frames_per_buffer=1024,
            stream_callback=None,
        )

        self._running = True
        return {
            "status": "ok",
            "source": source,
            "device_id": device_id,
            "device_name": device_info["name"],
            "sample_rate": sample_rate,
            "channels": channels,
        }

    def stop(self) -> dict:
        """停止音频采集"""
        self._running = False
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
        return {"status": "ok", "message": "音频采集已停止"}

    @property
    def is_running(self) -> bool:
        return self._running

    @property
    def device_id(self) -> int:
        return self._device_id

    @property
    def source(self) -> str:
        return self._source

    @property
    def input_rate(self) -> int:
        """当前音频源采样率"""
        return self._input_rate

    @property
    def input_channels(self) -> int:
        """当前音频源声道数"""
        return self._input_channels

    # ── B2.4: 音频格式转换 ─────────────────────────────────

    def convert_to_whisper_format(self, raw_data: bytes, src_rate: int, src_channels: int) -> bytes:
        """将原始音频数据转换为 Whisper 要求的 16kHz mono WAV

        Args:
            raw_data: PCM 原始音频数据
            src_rate: 原始采样率
            src_channels: 原始声道数

        Returns:
            WAV 格式的二进制数据 (16kHz, 16bit, mono)
        """
        import numpy as np

        # 解析 PCM 数据
        samples = np.frombuffer(raw_data, dtype=np.int16).astype(np.float32)

        # 多声道混音为单声道
        if src_channels > 1:
            samples = samples.reshape(-1, src_channels).mean(axis=1)

        # 重采样到 16kHz
        if src_rate != settings.audio_sample_rate:
            old_len = len(samples)
            new_len = int(old_len * settings.audio_sample_rate / src_rate)
            samples = np.interp(
                np.linspace(0, old_len - 1, new_len),
                np.arange(old_len),
                samples,
            )

        # 转回 int16
        samples = np.clip(samples, -32768, 32767).astype(np.int16)

        # 写入 WAV 到内存
        import io
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)  # 16bit
            wf.setframerate(settings.audio_sample_rate)
            wf.writeframes(samples.tobytes())
        return buf.getvalue()

    def save_chunk(self, wav_data: bytes, filename: Optional[str] = None) -> str:
        """保存音频块到文件

        Args:
            wav_data: WAV 格式的音频数据
            filename: 文件名（默认自动生成时间戳）

        Returns:
            文件路径
        """
        out_dir = Path(settings.audio_upload_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

        if not filename:
            filename = f"chunk_{int(time.time())}.wav"
        filepath = out_dir / filename

        with open(filepath, "wb") as f:
            f.write(wav_data)

        return str(filepath)

    # ── B2.5: 音频流读取 ────────────────────────────────────

    def read_chunk(self, chunk_duration: float = 3.0) -> Optional[bytes]:
        """读取一个音频块（约3秒）

        Returns:
            PCM 原始音频数据，或 None（已停止）
        """
        if not self._running or not self._stream:
            return None

        try:
            rate = self._input_rate
            frames_to_read = int(rate * chunk_duration)
            frames = []
            for _ in range(0, frames_to_read, 1024):
                if not self._running:
                    break
                data = self._stream.read(min(1024, frames_to_read - len(frames) * 1024), exception_on_overflow=False)
                frames.append(data)

            return b"".join(frames)
        except Exception as e:
            logger.error("[AudioCapture] 读取音频块失败: %s", e)
            return None

    # ── 内部方法 ──────────────────────────────────────────

    def _list_pa_devices(self) -> list[AudioDevice]:
        """通过 PyAudio 枚举设备"""
        if not self._pa:
            return []
        devices = []
        for i in range(self._pa.get_device_count()):
            try:
                info = self._pa.get_device_info_by_index(i)
                if info["maxInputChannels"] > 0:
                    name = info["name"]
                    is_loopback = "WASAPI" in name or "Loopback" in name or "Stereo Mix" in name
                    devices.append(AudioDevice(
                        index=i, name=name,
                        channels=info["maxInputChannels"],
                        sample_rate=info["defaultSampleRate"],
                        is_loopback=is_loopback,
                    ))
            except Exception:
                continue
        return devices


# 全局单例
capture_engine = AudioCapture()
