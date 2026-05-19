"""
pytest fixtures for LinguaCaption backend tests.

Provides:
- test_client: FastAPI TestClient with isolated temp database
- vocab_ids: list of created vocab IDs for cross-test sharing
"""
import os
import sys
import tempfile
from datetime import datetime, timezone
import pytest
from fastapi.testclient import TestClient

# Ensure project root is on sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


@pytest.fixture(scope="session")
def test_db():
    """Create a temporary database for the test session."""
    db_dir = tempfile.mkdtemp(prefix="linguacaption_test_")
    db_path = os.path.join(db_dir, "test.db")
    old_val = os.environ.get("LINGUACAPTION_DB_PATH")
    os.environ["LINGUACAPTION_DB_PATH"] = db_path

    # Also override settings.data_dir so main.py lifespan uses temp dir
    import config as cfg
    cfg.settings.data_dir = db_dir

    from database import init_db, dispose_engine
    from database.migrations import apply_migrations

    init_db(db_path)
    # Mark all existing migrations as applied so that main.py's lifespan
    # (which calls apply_migrations() during TestClient startup) won't
    # try to re-apply migrations that conflict with current models.
    from database.migrations import _get_migration_version, _discover_migrations
    import sqlite3
    conn = sqlite3.connect(db_path)
    _get_migration_version(conn)  # ensures schema_version table exists
    for version, name, path in _discover_migrations():
        conn.execute(
            "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)",
            (version, datetime.now(timezone.utc).isoformat()),
        )
    conn.commit()
    conn.close()

    yield db_path

    dispose_engine()

    # Cleanup
    import shutil
    try:
        shutil.rmtree(db_dir)
    except Exception:
        pass

    if old_val is None:
        os.environ.pop("LINGUACAPTION_DB_PATH", None)
    else:
        os.environ["LINGUACAPTION_DB_PATH"] = old_val


@pytest.fixture
def client(test_db):
    """Provide a TestClient bound to the app with the test database."""
    from main import app
    with TestClient(app) as c:
        yield c
