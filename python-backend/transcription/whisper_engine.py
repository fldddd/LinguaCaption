"""Whisper 实时转录引擎 — 基于 faster-whisper"""

import logging
from typing import Optional

from faster_whisper import WhisperModel

from config import settings

logger = logging.getLogger(__name__)

# ---------- 类型别名（仅用于类型标注） ----------
# faster-whisper 返回的 segments 是 Generator，只能迭代一次
# 这里仅保留运行时实际结构，不做 strict 校验


class SegmentWord:
    """单词级时间戳"""
    __slots__ = ("word", "start", "end", "probability")

    def __init__(self, word: str, start: float, end: float, probability: float = 0.0):
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability

    def to_dict(self) -> dict:
        return {
            "word": self.word,
            "start": self.start,
            "end": self.end,
            "probability": self.probability,
        }


class TranscribeResult:
    """转录结果"""
    __slots__ = ("text", "segments", "words", "duration", "language")

    def __init__(
        self,
        text: str = "",
        segments: Optional[list] = None,
        words: Optional[list[SegmentWord]] = None,
        duration: float = 0.0,
        language: str = "en",
    ):
        self.text = text
        self.segments = segments or []
        self.words = words or []
        self.duration = duration
        self.language = language

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "segments": [
                {
                    "id": getattr(s, "id", 0),
                    "start": getattr(s, "start", 0.0),
                    "end": getattr(s, "end", 0.0),
                    "text": getattr(s, "text", ""),
                }
                for s in self.segments
            ],
            "words": [w.to_dict() for w in self.words],
            "duration": self.duration,
            "language": self.language,
        }


class WhisperEngine:
    """Whisper 模型管理 + 转录引擎

    封装 faster-whisper 的 WhisperModel，提供：
    - 模型按需加载（首次自动下载缓存）
    - 音频分段转录（16kHz mono WAV PCM bytes）
    - 模型热切换（不同大小）
    - CPU int8 量化加速
    - VAD 语音活动检测
    - word-level timestamps
    """

    VALID_MODELS = ("tiny", "base", "small", "medium", "large")

    def __init__(self, model_size: str = "base"):
        self.model_size = model_size
        self._model: Optional[WhisperModel] = None
        self._load_model()
        logger.info("WhisperEngine initialized with model=%s", model_size)

    # ---- 模型生命周期 ----

    def _load_model(self) -> None:
        """加载（或下载后加载）Whisper 模型"""
        from pathlib import Path

        model_dir = Path(settings.whisper_model_dir)
        model_dir.mkdir(parents=True, exist_ok=True)

        logger.info(
            "Loading Whisper model '%s' (download_root=%s, device=%s, compute_type=int8)...",
            self.model_size,
            model_dir,
            settings.whisper_device,
        )

        self._model = WhisperModel(
            model_size_or_path=self.model_size,
            device=settings.whisper_device,
            compute_type="int8",  # CPU 量化加速
            download_root=str(model_dir),
            cpu_threads=4,
            num_workers=1,
        )

        logger.info("Whisper model '%s' loaded successfully", self.model_size)

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    # ---- 转录 ----

    def transcribe_segment(
        self,
        audio_bytes: bytes,
        language: str = "en",
    ) -> TranscribeResult:
        """转录一段 16kHz mono WAV 音频字节流

        Args:
            audio_bytes: 原始 PCM 字节流（16kHz, mono, float32 or int16）
            language: 语言代码（默认 "en"）

        Returns:
            TranscribeResult 包含文本、段、单词时间戳
        """
        if self._model is None:
            raise RuntimeError("Whisper model not loaded — call switch_model first")

        import numpy as np

        # fast whisper 要求 float32 numpy array，范围 [-1, 1]
        # 如果输入是 int16 PCM（B2 输出格式）则转换
        raw = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        segments, info = self._model.transcribe(
            raw,
            language=language,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,  # 语音活动检测过滤静音
            vad_parameters=dict(
                min_silence_duration_ms=500,
                threshold=0.5,
            ),
        )

        seg_list = list(segments)  # 消费 generator
        result = TranscribeResult(
            duration=info.duration,
            language=info.language,
        )

        words: list[SegmentWord] = []
        text_parts: list[str] = []

        for seg in seg_list:
            text_parts.append(seg.text)

            if seg.words:
                for w in seg.words:
                    words.append(
                        SegmentWord(
                            word=w.word,
                            start=w.start,
                            end=w.end,
                            probability=getattr(w, "probability", 0.0),
                        )
                    )

            # 还保留 segments 供外部使用
            result.segments.append(seg)

        result.text = " ".join(text_parts).strip()
        result.words = words

        return result

    # ---- 模型切换 ----

    def switch_model(self, model_size: str) -> None:
        """切换到不同大小的 Whisper 模型

        Args:
            model_size: tiny / base / small / medium / large

        Raises:
            ValueError: 如果模型名称无效
        """
        if model_size not in self.VALID_MODELS:
            raise ValueError(
                f"Invalid model size '{model_size}'. "
                f"Must be one of: {', '.join(self.VALID_MODELS)}"
            )

        if model_size == self.model_size and self._model is not None:
            logger.info("Model '%s' already loaded, skipping switch", model_size)
            return

        logger.info("Switching Whisper model from '%s' to '%s'...", self.model_size, model_size)
        self.model_size = model_size
        self._model = None  # 释放旧模型
        self._load_model()
        logger.info("Model switched to '%s' successfully", model_size)
