"""音频滑窗缓冲 — 用于流式转录的分段管理"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


class AudioBuffer:
    """音频滑窗缓冲区

    接收 B2 模块推送的连续 PCM chunk（16kHz mono），
    按滑窗策略切分出待转录的窗口段。

    滑窗示意::

        时间轴:  0s    15s    30s    45s    60s
        Chunk:   |####|####|####|####|####|####|...
                 |←── 转录窗口 30s ──→|
                         |←── 重叠 15s ──→|
                                 |←── 窗口 ──→|

    参数:
        window_size: 转录窗口长度（秒），默认 30s
        hop_size: 窗口步进（秒），默认 15s（50% 重叠）
        sample_rate: 音频采样率，默认 16000
    """

    def __init__(
        self,
        window_size: float = 30.0,
        hop_size: float = 15.0,
        sample_rate: int = 16000,
    ):
        if hop_size <= 0:
            raise ValueError("hop_size must be > 0")
        if window_size <= 0:
            raise ValueError("window_size must be > 0")
        if hop_size > window_size:
            raise ValueError("hop_size must be <= window_size")

        self.window_frames = int(window_size * sample_rate)
        self.hop_frames = int(hop_size * sample_rate)
        self.sample_rate = sample_rate

        # PCM 字节缓冲区（int16, 2 bytes per sample）
        self._buffer = bytearray()

        logger.debug(
            "AudioBuffer initialized: window=%ds(%d frames), hop=%ds(%d frames)",
            window_size,
            self.window_frames,
            hop_size,
            self.hop_frames,
        )

    @property
    def buffered_seconds(self) -> float:
        """当前缓冲区时长（秒）"""
        return len(self._buffer) / (self.sample_rate * 2)

    @property
    def buffered_bytes(self) -> int:
        return len(self._buffer)

    # ---- 公共 API ----

    def push(self, chunk: bytes) -> None:
        """添加一个音频块到缓冲区

        自动裁剪缓冲区上限为 2 个窗口大小以控制内存。
        B2 模块推送的 0.5s 16kHz mono PCM ≈ 16000 字节。
        """
        self._buffer.extend(chunk)

        # 限制最大缓冲区 = 2 * window_size，防止无限制增长
        max_buf = self.window_frames * 2 * 2  # 2 字节 per sample * 2倍
        if len(self._buffer) > max_buf:
            kept = self._buffer[-max_buf:]
            self._buffer = bytearray(kept)
            logger.debug("Buffer trimmed to %d bytes (max=%d)", len(kept), max_buf)

    def get_segment(self) -> Optional[bytes]:
        """获取下一个待转录的窗口数据

        当缓冲区 >= window_size 时，返回最前面 window_size 帧的字节，
        并将缓冲区向前移动 hop_size 帧（保留重叠部分）。

        Returns:
            如果缓冲区足够，返回窗口长度的 PCM bytes；否则返回 None
        """
        needed_bytes = self.window_frames * 2  # int16 = 2 bytes per sample

        if len(self._buffer) < needed_bytes:
            return None

        # 取最前面的一个窗口
        segment = bytes(self._buffer[:needed_bytes])

        # 向前移动 hop_size 帧（保留重叠）
        hop_bytes = self.hop_frames * 2
        self._buffer = bytearray(self._buffer[hop_bytes:])

        return segment

    def clear(self) -> None:
        """清空缓冲区"""
        self._buffer.clear()
        logger.debug("AudioBuffer cleared")

    def reset(self) -> None:
        """重置缓冲区（同 clear）"""
        self.clear()
