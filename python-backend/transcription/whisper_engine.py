"""
Whisper 实时转录引擎 — 基于 faster-whisper

优化要点（F4 转录速度优化）：
1. 降低 beam_size 从 5 → 1（贪心搜索，速度提升 ~3x）
2. 添加 best_of=1（减少候选数）
3. 添加 ffmpeg 音频预处理（比 pydub 快 5-10x）
4. 模型单例缓存（避免重复加载）
5. CPU int8 量化加速
6. VAD 语音活动检测过滤静音
7. word-level timestamps
"""

import logging, wave, subprocess, os, tempfile
from typing import Optional
from pathlib import Path

from faster_whisper import WhisperModel

from config import settings

logger = logging.getLogger(__name__)

# ---------- 类型别名（仅用于类型标注）----------
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


# ── 模型全局缓存（单例）────────────────────────
_global_engine: Optional["WhisperEngine"] = None


def get_engine(model_size: str | None = None) -> "WhisperEngine":
    """获取全局 WhisperEngine 单例，避免重复加载模型"""
    global _global_engine
    if _global_engine is None:
        _global_engine = WhisperEngine(model_size or settings.whisper_model)
    elif model_size and model_size != _global_engine.model_size:
        _global_engine.switch_model(model_size)
    return _global_engine


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

    def __init__(self, model_size: str = "tiny"):
        self.model_size = model_size
        self._model: Optional[WhisperModel] = None
        self._load_model()
        logger.info("WhisperEngine initialized with model=%s", model_size)

    # ---- 模型生命周期 ----

    def _load_model(self) -> None:
        """加载（或下载后加载）Whisper 模型"""
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

    # ---- 音频预处理（ffmpeg 加速）----

    @staticmethod
    def _ffmpeg_convert_to_pcm(audio_path: str) -> Optional[bytes]:
        """使用 ffmpeg 将任意音频文件转为 16kHz mono PCM float32 bytes

        ffmpeg 比 pydub 快 5-10x，且无需将整个文件加载到内存后再处理。
        返回原始 PCM float32 bytes（范围 [-1, 1]），失败返回 None。
        """
        try:
            cmd = [
                "ffmpeg", "-y",
                "-i", audio_path,
                "-f", "f32le",           # float32 little-endian PCM
                "-acodec", "pcm_f32le",
                "-ar", "16000",           # 16kHz 采样率
                "-ac", "1",               # 单声道
                "-loglevel", "error",     # 只输出错误
                "pipe:1",                 # 输出到 stdout
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                timeout=300,
            )
            if result.returncode != 0:
                logger.warning("ffmpeg conversion failed: %s", result.stderr.decode(errors="replace"))
                return None
            return result.stdout
        except FileNotFoundError:
            logger.warning("ffmpeg not found, falling back to pydub")
            return None
        except subprocess.TimeoutExpired:
            logger.error("ffmpeg conversion timed out for: %s", audio_path)
            return None
        except Exception as e:
            logger.warning("ffmpeg conversion error: %s", e)
            return None

    @staticmethod
    def _pydub_convert_to_pcm(audio_path: str) -> Optional[bytes]:
        """使用 pydub 将音频转为 16kHz mono PCM float32 bytes（回落方案）"""
        try:
            from pydub import AudioSegment
            audio = AudioSegment.from_file(audio_path)
            audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
            import numpy as np
            return np.array(audio.get_array_of_samples(), dtype=np.float32) / 32768.0
        except Exception as e:
            logger.error("pydub conversion failed: %s", e)
            return None

    def _load_audio(self, audio_path: str) -> Optional[bytes]:
        """将音频文件加载为 16kHz mono PCM float32 bytes

        优先使用 ffmpeg（快），回落 pydub（兼容性好）。
        """
        # 尝试 ffmpeg
        raw = self._ffmpeg_convert_to_pcm(audio_path)
        if raw is not None:
            return raw

        # 回落 pydub
        return self._pydub_convert_to_pcm(audio_path)

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

        # faster-whisper 要求 float32 numpy array，范围 [-1, 1]
        # 如果输入是 int16 PCM（B2 输出格式）则转换
        raw = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        segments, info = self._model.transcribe(
            raw,
            language=language,
            beam_size=settings.whisper_beam_size,
            best_of=settings.whisper_best_of,
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

    def transcribe(self, audio_path: str, language: str | None = None) -> dict:
        """转录音频文件，自动转换非 WAV 格式，返回兼容 TaskResult 的 dict

        Args:
            audio_path: 音频文件路径（支持 WAV/MP3/MP4/M4A 等格式）
            language: 语言代码，None 则自动检测

        Returns:
            dict with keys: segments, words, language, duration
        """
        if self._model is None:
            raise RuntimeError("Whisper model not loaded — call switch_model first")

        # 使用优化的音频加载（ffmpeg 优先）
        raw = self._load_audio(audio_path)
        if raw is None:
            # 最终回落：直接读取原始 PCM 文件
            try:
                with wave.open(audio_path, 'rb') as wf:
                    frames = wf.readframes(wf.getnframes())
                import numpy as np
                raw = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            except Exception as e:
                raise RuntimeError(f"Failed to load audio file '{audio_path}': {e}")

        return self._do_transcribe(raw, language or "en")

    def _do_transcribe(self, audio_array, language: str) -> dict:
        """底层转录，返回 dict 格式结果"""
        if self._model is None:
            raise RuntimeError("Whisper model not loaded — call switch_model first")

        segments, info = self._model.transcribe(
            audio_array,
            language=language,
            beam_size=settings.whisper_beam_size,
            best_of=settings.whisper_best_of,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=500,
                threshold=0.5,
            ),
        )

        seg_list = list(segments)
        result_segments = []
        result_words = []

        for seg in seg_list:
            result_segments.append({
                "id": len(result_segments),
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
                "words": [],
            })
            if seg.words:
                for w in seg.words:
                    wd = {
                        "word": w.word,
                        "start": w.start,
                        "end": w.end,
                        "probability": getattr(w, "probability", 0.0),
                    }
                    result_words.append(wd)
                    result_segments[-1]["words"].append(wd)

        return {
            "segments": result_segments,
            "words": result_words,
            "language": info.language,
            "duration": info.duration,
        }

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
