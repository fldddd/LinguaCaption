"""
Whisper 实时转录服务

功能:
  - 懒加载 Whisper 模型（按需加载，减少启动时间）
  - 接收 16kHz mono PCM/WAV 音频块
  - 带重叠的滑动窗口转录
  - 输出与模拟器兼容的字幕段格式
"""

import asyncio
import logging
import time
import io
import struct
from typing import Optional, AsyncGenerator, Callable, Awaitable
from datetime import datetime, timezone

from config import settings

logger = logging.getLogger(__name__)

# ── 类型别名 ───────────────────────────────────────────

TranscriptionCallback = Callable[[dict], Awaitable[None]]


# ── 音频缓冲器 ─────────────────────────────────────────

class AudioBuffer:
    """环形音频缓冲区，支持滑动窗口取块。"""

    def __init__(self, sample_rate: int = 16000, channels: int = 1):
        self.sample_rate = sample_rate
        self.channels = channels
        self._buffer: list[bytes] = []
        self._total_samples = 0
        self._lock = asyncio.Lock()

    @property
    def duration_seconds(self) -> float:
        """缓冲区总时长（秒）。"""
        if self.sample_rate == 0:
            return 0.0
        return self._total_samples / self.sample_rate

    async def append(self, wav_data: bytes):
        """追加 WAV 格式音频数据。"""
        async with self._lock:
            # 跳过 WAV 头（44 字节），取 PCM 数据
            pcm_data = self._strip_wav_header(wav_data)
            if pcm_data:
                self._buffer.append(pcm_data)
                # PCM16 = 2 bytes per sample
                self._total_samples += len(pcm_data) // 2

    async def pop_chunk(self, duration: float) -> Optional[bytes]:
        """弹出一个指定时长的音频块（PCM16），超时返回 None。"""
        target_samples = int(duration * self.sample_rate)
        target_bytes = target_samples * 2  # 16-bit PCM

        async with self._lock:
            if self._total_samples < target_samples:
                return None

            collected = b"".join(self._buffer)
            if len(collected) < target_bytes:
                return None

            chunk = collected[:target_bytes]
            remaining = collected[target_bytes:]

            # 更新缓冲区
            if remaining:
                self._buffer = [remaining]
            else:
                self._buffer = []

            self._total_samples = len(remaining) // 2
            return chunk

    async def peek_latest(self, duration: float) -> Optional[bytes]:
        """取最近 N 秒的音频（不弹出），用于重叠窗口。"""
        target_samples = int(duration * self.sample_rate)
        target_bytes = target_samples * 2

        async with self._lock:
            if self._total_samples < target_samples:
                return None
            collected = b"".join(self._buffer)
            if len(collected) < target_bytes:
                return None
            return collected[-target_bytes:]

    def _strip_wav_header(self, data: bytes) -> bytes:
        """从 WAV 容器中提取 PCM 数据。"""
        if len(data) < 44:
            return data
        if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
            return data[44:]
        return data

    async def trim_front(self, pop_bytes: int) -> bytes:
        """从缓冲区头部移除 pop_bytes 字节。返回被丢弃的数据。"""
        if pop_bytes <= 0:
            return b""
        async with self._lock:
            collected = b"".join(self._buffer)
            if len(collected) <= pop_bytes:
                result = collected
                self._buffer.clear()
                self._total_samples = 0
                return result
            result = collected[:pop_bytes]
            self._buffer = [collected[pop_bytes:]]
            self._total_samples = len(collected[pop_bytes:]) // 2
            return result

    async def clear(self):
        async with self._lock:
            self._buffer.clear()
            self._total_samples = 0

    async def flush(self) -> Optional[bytes]:
        """清空缓冲区并返回所有剩余 PCM 数据。"""
        async with self._lock:
            if not self._buffer:
                return None
            result = b"".join(self._buffer)
            self._buffer.clear()
            self._total_samples = 0
            return result


# ── Whisper 转录器 ─────────────────────────────────────

class WhisperTranscriber:
    """Whisper 模型实时转录服务。"""

    def __init__(self):
        self._model = None
        self._model_name = settings.whisper_model  # "base", "small", etc.
        self._device = settings.whisper_device      # "cpu" or "cuda"
        self._loaded = False
        self._buffer = AudioBuffer(
            sample_rate=settings.audio_sample_rate,
            channels=1,
        )

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @property
    def model_name(self) -> str:
        return self._model_name

    async def load_model(self):
        """懒加载 Whisper 模型（异步线程池中加载）。"""
        if self._loaded:
            return

        logger.info("加载 Whisper 模型: %s (device=%s)", self._model_name, self._device)
        loop = asyncio.get_event_loop()

        def _load():
            import whisper
            model = whisper.load_model(self._model_name, device=self._device)
            return model

        self._model = await loop.run_in_executor(None, _load)
        self._loaded = True
        logger.info("Whisper 模型加载完成: %s", self._model_name)

    async def feed_audio(self, wav_data: bytes):
        """输入音频数据（WAV 格式，16kHz mono）。"""
        await self._buffer.append(wav_data)

    async def transcribe_chunk(
        self,
        chunk_duration: float = 3.0,
        overlap: float = 0.5,
    ) -> Optional[list[dict]]:
        """尝试转录一个音频块。

        Args:
            chunk_duration: 每个块时长（秒）
            overlap: 块间重叠（秒）

        Returns:
            字幕段列表，如果缓冲区不足返回 None
        """
        # 检查缓存是否够一个完整块
        if self._buffer.duration_seconds < chunk_duration:
            return None

        # 搭配合之前重叠段的尾部，避免切词
        if self._buffer.duration_seconds >= chunk_duration + overlap:
            # 有重叠数据，取最新 chunk_duration 秒
            chunk_pcm = await self._buffer.peek_latest(chunk_duration)
        else:
            chunk_pcm = await self._buffer.pop_chunk(chunk_duration)

        if not chunk_pcm:
            return None

        # 转换为 numpy
        import numpy as np
        samples = np.frombuffer(chunk_pcm, dtype=np.int16).astype(np.float32) / 32768.0

        # 异步执行转录
        loop = asyncio.get_event_loop()

        def _transcribe(audio_array):
            result = self._model.transcribe(
                audio_array,
                language="en",
                task="transcribe",
                fp16=False,
                condition_on_previous_text=False,
            )
            return result

        try:
            result = await loop.run_in_executor(None, _transcribe, samples)
        except Exception as e:
            logger.error("Whisper 转录失败: %s", e)
            return None

        # 格式化输出（与模拟器格式兼容）
        segments = []
        base_time = self._get_base_time()
        for seg in result.get("segments", []):
            segments.append({
                "type": "subtitle",
                "data": {
                    "text": seg.get("text", "").strip(),
                    "start_time": round(base_time + seg.get("start", 0), 2),
                    "end_time": round(base_time + seg.get("end", 0), 2),
                    "is_final": True,
                    "segment_index": seg.get("id", 0),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "confidence": round(seg.get("avg_logprob", 0), 3),
                },
            })

        # 弹出已处理的数据（保留重叠部分，仅在 peek 模式需要）
        pop_duration = chunk_duration - overlap
        if pop_duration > 0 and self._buffer.duration_seconds >= chunk_duration + overlap:
            pop_bytes = int(pop_duration * settings.audio_sample_rate) * 2
            await self._buffer.trim_front(pop_bytes)

        return segments

    def _get_base_time(self) -> float:
        """返回当前时间偏移（用于时间戳计算）。"""
        return time.time()

    async def transcribe_file(self, audio_path: str) -> list[dict]:
        """转录整个音频文件（离线模式）。"""
        if not self._loaded:
            await self.load_model()

        loop = asyncio.get_event_loop()

        def _transcribe_file():
            result = self._model.transcribe(
                audio_path,
                language="en",
                task="transcribe",
                fp16=False,
            )
            return [
                {
                    "type": "subtitle",
                    "data": {
                        "text": seg.get("text", "").strip(),
                        "start_time": round(seg.get("start", 0), 2),
                        "end_time": round(seg.get("end", 0), 2),
                        "is_final": True,
                        "segment_index": seg.get("id", 0),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    },
                }
                for seg in result.get("segments", [])
            ]

        return await loop.run_in_executor(None, _transcribe_file)


# ── 全局实例 ───────────────────────────────────────────

transcriber = WhisperTranscriber()
