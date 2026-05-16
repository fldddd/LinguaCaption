"""
LinguaCaption 数据库模块
提供 SQLite 连接管理、表初始化、Session 工厂。
"""

import os
import logging
from contextlib import contextmanager
from pathlib import Path
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, Session
from sqlalchemy.pool import StaticPool

from .models import Base

logger = logging.getLogger(__name__)

# 默认数据库路径
DEFAULT_DB_DIR = Path(__file__).resolve().parent.parent / "data"
DEFAULT_DB_PATH = DEFAULT_DB_DIR / "linguacaption.db"

_engine = None
_SessionLocal = None


def get_db_path() -> str:
    """从环境变量读取数据库路径，默认使用项目 data 目录"""
    return os.environ.get("LINGUACAPTION_DB_PATH", str(DEFAULT_DB_PATH))


def init_db(db_path: str | None = None) -> None:
    """
    初始化数据库引擎和 Session 工厂。
    若表不存在则自动创建。
    """
    global _engine, _SessionLocal

    if db_path is None:
        db_path = get_db_path()

    db_dir = Path(db_path).parent
    db_dir.mkdir(parents=True, exist_ok=True)

    _engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=os.environ.get("DB_ECHO", "").lower() == "true",
    )

    # 启用 WAL 模式和外键约束
    @event.listens_for(_engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL;")
        cursor.execute("PRAGMA foreign_keys=ON;")
        cursor.close()

    _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)

    # 自动建表
    Base.metadata.create_all(bind=_engine)
    logger.info(f"数据库已初始化: {db_path}")


def get_session() -> Session:
    """获取一个新的数据库 Session（调用方负责关闭）"""
    if _SessionLocal is None:
        init_db()
    return _SessionLocal()


@contextmanager
def session_scope():
    """上下文管理器：自动 commit/rollback 和关闭 Session"""
    session = get_session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def get_engine():
    """获取当前数据库引擎"""
    global _engine
    if _engine is None:
        init_db()
    return _engine


def dispose_engine():
    """释放数据库连接"""
    global _engine, _SessionLocal
    if _engine:
        _engine.dispose()
        _engine = None
        _SessionLocal = None
