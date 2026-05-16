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
    whisper_model: str = "base"  # tiny / base / small / medium / large
    whisper_device: str = "cpu"  # cpu / cuda

    # 跨域
    cors_origins: list[str] = ["*"]

    class Config:
        env_prefix = "LC_"
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
