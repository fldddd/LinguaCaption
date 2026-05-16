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

    # 支持的音频格式
    allowed_audio_extensions: list[str] = [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".wma"]

    @field_validator("allowed_audio_extensions", mode="before")
    @classmethod
    def deduplicate_extensions(cls, v):
        if isinstance(v, set):
            return sorted(v)
        if isinstance(v, list):
            return list(dict.fromkeys(v))
        return v

    # Whisper 模型
    whisper_model: str = "base"
    whisper_device: str = "cpu"

    # 音频采集参数
    audio_sample_rate: int = 16000       # Whisper 要求的采样率
    audio_channels: int = 1              # 单声道
    audio_chunk_seconds: float = 3.0     # 音频块时长 (秒)
    audio_chunk_overlap: float = 0.5     # 块重叠时长 (秒)

    # 跨域
    cors_origins: list[str] = ["*"]

    class Config:
        env_prefix = "LC_"
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
