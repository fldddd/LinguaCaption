"""
LinguaCaption 数据库备份与恢复
支持自动备份到 backups 目录，以及从备份文件恢复。
"""

import gzip
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from . import get_db_path

logger = logging.getLogger(__name__)

BACKUP_DIR = Path(__file__).resolve().parent.parent / "backups"
MAX_BACKUPS = 10  # 保留最近 N 份备份


def _ensure_backup_dir():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def backup(tag: str = "auto") -> str:
    """
    备份当前数据库。
    使用 SQLite 的 .backup API 确保一致性。
    返回备份文件路径。
    """
    _ensure_backup_dir()

    db_path = get_db_path()
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    backup_name = f"linguacaption_{timestamp}_{tag}.db.gz"
    backup_path = BACKUP_DIR / backup_name

    # 使用 sqlite3 的 backup API
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(":memory:")

    try:
        src.backup(dst)
    finally:
        src.close()

    # 压缩到文件
    with gzip.open(backup_path, "wb") as f:
        for line in dst.iterdump():
            f.write((line + "\n").encode("utf-8"))
    dst.close()

    logger.info(f"数据库已备份: {backup_path} ({backup_path.stat().st_size} bytes)")

    # 清理旧备份
    _cleanup_old_backups()

    return str(backup_path)


def restore(backup_path: str) -> bool:
    """
    从 .db.gz 备份文件恢复数据库。
    恢复前会自动创建当前数据库的紧急备份。
    """
    backup_file = Path(backup_path)
    if not backup_file.exists():
        logger.error(f"备份文件不存在: {backup_path}")
        return False

    db_path = get_db_path()
    db_file = Path(db_path)

    # 恢复前紧急备份
    if db_file.exists():
        emergency = backup(tag="pre_restore")
        logger.warning(f"恢复前紧急备份: {emergency}")

    # 创建新数据库并导入
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    try:
        with gzip.open(backup_file, "rt", encoding="utf-8") as f:
            sql = f.read()
        cursor.executescript(sql)
        conn.commit()
        logger.info(f"数据库已从备份恢复: {backup_path}")
        return True
    except Exception as e:
        conn.rollback()
        logger.error(f"恢复失败: {e}")
        return False
    finally:
        conn.close()


def list_backups() -> list[dict]:
    """列出所有备份文件"""
    _ensure_backup_dir()
    backups = []
    for f in sorted(BACKUP_DIR.glob("*.db.gz"), reverse=True):
        stat = f.stat()
        backups.append({
            "name": f.name,
            "path": str(f),
            "size": stat.st_size,
            "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })
    return backups


def _cleanup_old_backups():
    """保留最近 MAX_BACKUPS 份，删除更早的"""
    _ensure_backup_dir()
    all_backups = sorted(BACKUP_DIR.glob("linguacaption_*.db.gz"))
    if len(all_backups) > MAX_BACKUPS:
        for old in all_backups[:-MAX_BACKUPS]:
            old.unlink()
            logger.info(f"已清理旧备份: {old.name}")
