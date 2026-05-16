"""
LinguaCaption 数据库迁移系统
基于文件的轻量级迁移，无需 Alembic。
迁移文件放在 migrations/ 目录，按序号递增执行。
"""

import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from . import get_db_path, init_db

logger = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"


def _ensure_migrations_dir():
    MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)


def _get_migration_version(conn: sqlite3.Connection) -> int:
    """获取当前数据库 schema 版本号"""
    cursor = conn.cursor()
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    if not cursor.fetchone():
        cursor.execute(
            "CREATE TABLE schema_version (version INTEGER NOT NULL, applied_at TEXT NOT NULL)"
        )
        cursor.execute("INSERT INTO schema_version (version, applied_at) VALUES (0, ?)",
                       (datetime.now(timezone.utc).isoformat(),))
        conn.commit()
        return 0

    cursor.execute("SELECT MAX(version) FROM schema_version")
    row = cursor.fetchone()
    return row[0] if row[0] is not None else 0


def _discover_migrations() -> list[tuple[int, str, Path]]:
    """扫描 migrations/ 目录，返回 [(version, name, path), ...]"""
    _ensure_migrations_dir()
    migrations = []
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        # 文件名格式: 001_description.sql
        stem = f.stem
        parts = stem.split("_", 1)
        if len(parts) >= 1 and parts[0].isdigit():
            version = int(parts[0])
            name = parts[1] if len(parts) > 1 else ""
            migrations.append((version, name, f))
    return migrations


def apply_migrations(target_version: int | None = None) -> list[str]:
    """
    执行所有未应用的迁移脚本。
    返回已成功应用的迁移名称列表。
    """
    db_path = get_db_path()

    # 确保数据库已存在
    if not Path(db_path).exists():
        init_db(db_path)

    conn = sqlite3.connect(db_path)
    applied = []

    try:
        current = _get_migration_version(conn)
        migrations = _discover_migrations()

        pending = [(v, n, p) for v, n, p in migrations
                   if v > current and (target_version is None or v <= target_version)]

        if not pending:
            logger.info(f"数据库 schema 已是最新 (v{current})")
            return []

        for version, name, path in pending:
            logger.info(f"应用迁移 v{version}: {name}")
            sql = path.read_text(encoding="utf-8")

            try:
                conn.executescript(sql)
                conn.execute(
                    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
                    (version, datetime.now(timezone.utc).isoformat()),
                )
                conn.commit()
                applied.append(f"v{version}_{name}")
                logger.info(f"迁移完成: v{version}_{name}")
            except Exception as e:
                conn.rollback()
                logger.error(f"迁移失败 v{version}_{name}: {e}")
                raise MigrationError(f"迁移 v{version} 失败: {e}") from e

    finally:
        conn.close()

    return applied


def create_migration(name: str) -> Path:
    """创建新的迁移文件骨架"""
    _ensure_migrations_dir()
    migrations = _discover_migrations()
    next_version = max((v for v, _, _ in migrations), default=0) + 1

    safe_name = name.replace(" ", "_").lower()
    filename = f"{next_version:03d}_{safe_name}.sql"
    filepath = MIGRATIONS_DIR / filename

    content = f"""-- Migration: {name}
-- Version: {next_version}
-- Created: {datetime.now(timezone.utc).isoformat()}

-- TODO: write your migration SQL below
"""
    filepath.write_text(content, encoding="utf-8")
    logger.info(f"迁移文件已创建: {filepath}")
    return filepath


def get_version() -> int:
    """获取当前数据库版本号"""
    db_path = get_db_path()
    if not Path(db_path).exists():
        return 0
    conn = sqlite3.connect(db_path)
    try:
        return _get_migration_version(conn)
    finally:
        conn.close()


class MigrationError(Exception):
    """迁移错误"""
    pass


# ══════════════════════════════════════════════════════════════
# 内置默认迁移
# ══════════════════════════════════════════════════════════════

# 启动时自动创建初始迁移
INITIAL_MIGRATION_SQL = """-- 初始 schema: 生词表 + 字幕表 + 学习记录表

PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS subtitles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    language TEXT DEFAULT 'en',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vocab (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    translation TEXT,
    phonetic TEXT,
    part_of_speech TEXT,
    context TEXT,
    source_subtitle_id INTEGER REFERENCES subtitles(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vocab_word ON vocab(word);

CREATE TABLE IF NOT EXISTS learning_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vocab_id INTEGER NOT NULL REFERENCES vocab(id) ON DELETE CASCADE,
    review_count INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    last_reviewed_at TEXT,
    next_review_at TEXT,
    mastered INTEGER DEFAULT 0,
    difficulty INTEGER DEFAULT 3,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_learning_vocab ON learning_records(vocab_id);
CREATE INDEX IF NOT EXISTS idx_learning_mastered ON learning_records(mastered);
"""


def ensure_initial_migration():
    """确保初始迁移文件存在"""
    initial = MIGRATIONS_DIR / "001_initial_schema.sql"
    if not initial.exists():
        _ensure_migrations_dir()
        initial.write_text(INITIAL_MIGRATION_SQL, encoding="utf-8")
        logger.info("初始迁移文件已创建: 001_initial_schema.sql")
