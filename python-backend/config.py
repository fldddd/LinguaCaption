"""
LinguaCaption 配置模块
加载 .env 环境变量，集中管理应用配置。
"""
import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    """应用配置"""
    APP_NAME: str = "LinguaCaption"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = os.getenv("DEBUG", "false").lower() == "true"
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "sqlite:///./data/linguacaption.db"
    )


settings = Settings()
