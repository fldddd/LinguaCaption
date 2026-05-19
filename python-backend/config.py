"""LinguaCaption 后端配置"""

from pydantic_settings import BaseSettings
from pathlib import Path
from pydantic import field_validator


class Settings(BaseSettings):
    """应用配置，支持环境变量覆盖"""

    # 服务
    host: str = "127.0.0.1"
    port: int = 8000
    debug: bool = True
    version: str = "0.1.0"

    # 路径
    data_dir: str = str(Path(__file__).parent / "data")
    audio_upload_dir: str = str(Path(__file__).parent / "data" / "audio")
    transcription_cache_dir: str = str(Path(__file__).parent / "data" / "transcriptions")

    # 文件大小限制 (100MB)
    max_upload_size: int = 100 * 1024 * 1024

    # 支持的音频格式（Pydantic v2 原生不支持 set[str]，改用 list + validator）
    allowed_audio_extensions: list[str] = [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".wma"]

    @field_validator("allowed_audio_extensions", mode="before")
    @classmethod
    def deduplicate_extensions(cls, v):
        """去重并转为列表（兼容 set 输入）"""
        if isinstance(v, set):
            return sorted(v)
        if isinstance(v, list):
            return list(dict.fromkeys(v))  # 保持顺序去重
        return v

    # Whisper 模型
    whisper_model: str = "tiny"  # tiny / base / small / medium / large（tiny 最快）
    whisper_model_dir: str = str(Path(__file__).parent / "data" / "whisper_models")
    whisper_device: str = "cpu"  # cpu / cuda
    whisper_beam_size: int = 1   # 波束搜索宽度（1=贪心，最快；5=更准但慢）
    whisper_best_of: int = 1     # 候选数（1=最快）

    # 音频采集
    audio_sample_rate: int = 16000  # Whisper 输入采样率
    audio_channels: int = 1  # mono
    audio_chunk_duration: float = 0.5  # 采集块时长（秒）
    audio_buffer_seconds: float = 3.0  # 默认缓冲时长
    default_audio_source: str = "system"  # system / microphone / file / none

    # 间隔重复算法 (1d, 3d, 7d, 14d, 30d)
    srs_intervals: list[int] = [1, 3, 7, 14, 30]
    srs_mastered_threshold: int = 5  # 连续正确 N 次标记为已掌握

    # 跨域
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    class Config:
        env_prefix = "LC_"
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
