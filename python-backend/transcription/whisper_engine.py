import numpy as np
"""Whisper 瀹炴椂杞綍寮曟搸 鈥?鍩轰簬 faster-whisper"""

import logging, wave
from typing import Optional

from faster_whisper import WhisperModel

from config import settings

logger = logging.getLogger(__name__)

# ---------- 绫诲瀷鍒悕锛堜粎鐢ㄤ簬绫诲瀷鏍囨敞锛?----------
# faster-whisper 杩斿洖鐨?segments 鏄?Generator锛屽彧鑳借凯浠ｄ竴娆?
# 杩欓噷浠呬繚鐣欒繍琛屾椂瀹為檯缁撴瀯锛屼笉鍋?strict 鏍￠獙


class SegmentWord:
    """鍗曡瘝绾ф椂闂存埑"""
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
    """杞綍缁撴灉"""
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
    """Whisper 妯″瀷绠＄悊 + 杞綍寮曟搸

    灏佽 faster-whisper 鐨?WhisperModel锛屾彁渚涳細
    - 妯″瀷鎸夐渶鍔犺浇锛堥娆¤嚜鍔ㄤ笅杞界紦瀛橈級
    - 闊抽鍒嗘杞綍锛?6kHz mono WAV PCM bytes锛?
    - 妯″瀷鐑垏鎹紙涓嶅悓澶у皬锛?
    - CPU int8 閲忓寲鍔犻€?
    - VAD 璇煶娲诲姩妫€娴?
    - word-level timestamps
    """

    VALID_MODELS = ("tiny", "base", "small", "medium", "large")

    def __init__(self, model_size: str = "base"):
        self.model_size = model_size
        self._model: Optional[WhisperModel] = None
        self._load_model()
        logger.info("WhisperEngine initialized with model=%s", model_size)

    # ---- 妯″瀷鐢熷懡鍛ㄦ湡 ----

    def _load_model(self) -> None:
        """鍔犺浇锛堟垨涓嬭浇鍚庡姞杞斤級Whisper 妯″瀷"""
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
            compute_type="int8",  # CPU 閲忓寲鍔犻€?
            download_root=str(model_dir),
            cpu_threads=4,
            num_workers=1,
        )

        logger.info("Whisper model '%s' loaded successfully", self.model_size)

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    # ---- 杞綍 ----

    def transcribe_segment(
        self,
        audio_bytes: bytes,
        language: str = "en",
    ) -> TranscribeResult:
        """杞綍涓€娈?16kHz mono WAV 闊抽瀛楄妭娴?

        Args:
            audio_bytes: 鍘熷 PCM 瀛楄妭娴侊紙16kHz, mono, float32 or int16锛?
            language: 璇█浠ｇ爜锛堥粯璁?"en"锛?

        Returns:
            TranscribeResult 鍖呭惈鏂囨湰銆佹銆佸崟璇嶆椂闂存埑
        """
        if self._model is None:
            raise RuntimeError("Whisper model not loaded 鈥?call switch_model first")

        import numpy as np

        # fast whisper 瑕佹眰 float32 numpy array锛岃寖鍥?[-1, 1]
        # 濡傛灉杈撳叆鏄?int16 PCM锛圔2 杈撳嚭鏍煎紡锛夊垯杞崲
        raw = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        segments, info = self._model.transcribe(
            raw,
            language=language,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,  # 璇煶娲诲姩妫€娴嬭繃婊ら潤闊?
            vad_parameters=dict(
                min_silence_duration_ms=500,
                threshold=0.5,
            ),
        )

        seg_list = list(segments)  # 娑堣垂 generator
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

            # 杩樹繚鐣?segments 渚涘閮ㄤ娇鐢?
            result.segments.append(seg)

        result.text = " ".join(text_parts).strip()
        result.words = words

        return result

    def transcribe(self, audio_path: str, language: str | None = None) -> dict:
        """杞綍闊抽鏂囦欢锛岃嚜鍔ㄨ浆鎹㈤潪 WAV 鏍煎紡锛岃繑鍥炲吋瀹?TaskResult 鐨?dict

        Args:
            audio_path: 闊抽鏂囦欢璺緞锛堟敮鎸?WAV/MP3/MP4/M4A 绛夋牸寮忥級
            language: 璇█浠ｇ爜锛孨one 鍒欒嚜鍔ㄦ娴?

        Returns:
            dict with keys: segments, words, language, duration
        """
        import numpy as np

        # 灏濊瘯鐢?pydub 缁熶竴杞崲涓?WAV PCM锛堟敮鎸佸绉嶆牸寮忥級
        # 濡傛灉 pydub 涓嶅彲鐢紝鍥為€€鍒?wave 妯″潡锛堜粎 WAV锛?
        raw = None
        try:
            from pydub import AudioSegment
            audio = AudioSegment.from_file(audio_path)
            audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
            raw = np.array(audio.get_array_of_samples(), dtype=np.float32) / 32768.0
        except Exception:
            pass

        if raw is None:
            try:
                with wave.open(audio_path, 'rb') as wf:
                    frames = wf.readframes(wf.getnframes())
                    raw = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            except wave.Error:
                with open(audio_path, 'rb') as f:
                    raw_bytes = f.read()
                raw = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        return self._do_transcribe(raw, language or "en")

    def _do_transcribe(self, audio_array: np.ndarray, language: str) -> dict:
        """搴曞眰杞綍锛岃繑鍥?dict 鏍煎紡缁撴灉"""
        if self._model is None:
            raise RuntimeError("Whisper model not loaded 鈥?call switch_model first")

        segments, info = self._model.transcribe(
            audio_array,
            language=language,
            beam_size=5,
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
        """鍒囨崲鍒颁笉鍚屽ぇ灏忕殑 Whisper 妯″瀷

        Args:
            model_size: tiny / base / small / medium / large

        Raises:
            ValueError: 濡傛灉妯″瀷鍚嶇О鏃犳晥
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
        self._model = None  # 閲婃斁鏃фā鍨?
        self._load_model()
        logger.info("Model switched to '%s' successfully", model_size)
