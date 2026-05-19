"""
Tests for SessionInfo, TranscriptFragment CRUD and Search/Provenance API.
"""
import pytest
from datetime import datetime, timezone
from database import get_db
from database.crud import (
    create_session, close_session, get_active_session, list_sessions,
    insert_fragment, get_fragments_by_session, search_fragments, get_fragments_by_word,
)
from database.models import SessionInfo


class TestSessionCRUD:
    """SessionInfo CRUD operations."""

    def test_create_session(self, test_db):
        """创建会话应返回 SessionInfo 对象并写入数据库."""
        db = next(get_db())
        try:
            session = create_session(db, session_type="test", language="en",
                                     source_type="url", source_name="test video",
                                     source_url="https://example.com/video")
            assert session.id is not None
            assert session.session_type == "test"
            assert session.language == "en"
            assert session.is_active is True
            assert session.started_at is not None
        finally:
            db.close()

    def test_close_session(self, test_db):
        """关闭会话应设置 is_active=False 和 ended_at."""
        db = next(get_db())
        try:
            session = create_session(db)
            session_id = session.id
            closed = close_session(db, session_id)
            assert closed is not None
            assert closed.is_active is False
            assert closed.ended_at is not None
        finally:
            db.close()

    def test_close_nonexistent_session(self, test_db):
        """关闭不存在的会话应返回 None."""
        db = next(get_db())
        try:
            result = close_session(db, 99999)
            assert result is None
        finally:
            db.close()

    def test_get_active_session(self, test_db):
        """获取活跃会话应返回最近创建的活跃会话."""
        db = next(get_db())
        try:
            # Create an old session and close it
            old = create_session(db)
            close_session(db, old.id)

            # Create a new active session
            new = create_session(db)

            active = get_active_session(db)
            assert active is not None
            assert active.id == new.id
            assert active.is_active is True
        finally:
            db.close()

    def test_no_active_session(self, test_db):
        """没有活跃会话时应返回 None."""
        db = next(get_db())
        try:
            # Close ALL active sessions from other tests first
            while True:
                existing = get_active_session(db)
                if not existing:
                    break
                close_session(db, existing.id)

            session = create_session(db)
            close_session(db, session.id)
            # Verify no active sessions remain
            active = get_active_session(db)
            assert active is None, f"Expected None but got session id={active.id if active else None}"
        finally:
            db.close()

    def test_list_sessions(self, test_db):
        """列出会话应返回按 ID 降序排列的会话列表."""
        db = next(get_db())
        try:
            for i in range(3):
                _ = create_session(db, source_name=f"video_{i}")
            sessions = list_sessions(db, limit=10)
            assert len(sessions) >= 3
            assert sessions[0].id > sessions[-1].id  # descending
        finally:
            db.close()


class TestFragmentCRUD:
    """TranscriptFragment CRUD operations."""

    @pytest.fixture
    def session(self, test_db):
        db = next(get_db())
        s = create_session(db)
        db.close()
        return s

    def test_insert_fragment(self, test_db, session):
        """插入片段应返回 TranscriptFragment 并更新会话计数."""
        db = next(get_db())
        try:
            frag = insert_fragment(db, session_id=session.id, text="Hello world",
                                   language="en", start_time=0.0, end_time=2.5,
                                   source_type="url", source_name="test.mp4",
                                   source_video_id="BV12345")
            assert frag.id is not None
            assert frag.text == "Hello world"
            assert frag.word_count == 2

            # 会话计数应更新
            updated = db.query(SessionInfo).filter(SessionInfo.id == session.id).first()
            assert updated.total_fragments >= 1
            assert updated.total_words >= 2
        finally:
            db.close()

    def test_insert_fragment_with_parsed_at(self, test_db, session):
        """插入片段时可以指定 parsed_at."""
        db = next(get_db())
        try:
            now = datetime.now(timezone.utc)
            frag = insert_fragment(db, session_id=session.id, text="Parsed text",
                                   parsed_at=now)
            assert frag.parsed_at is not None
            # SQLite stores datetime without tz — make frag.parsed_at aware
            parsed = frag.parsed_at
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            assert abs((parsed - now).total_seconds()) < 2
        finally:
            db.close()

    def test_get_fragments_by_session(self, test_db, session):
        """按会话ID获取片段应返回该会话的所有片段."""
        db = next(get_db())
        try:
            for text in ["First fragment", "Second fragment", "Third fragment"]:
                insert_fragment(db, session_id=session.id, text=text)
            fragments = get_fragments_by_session(db, session.id)
            assert len(fragments) == 3
        finally:
            db.close()

    def test_search_fragments(self, test_db, session):
        """搜索片段应返回包含关键词的片段."""
        db = next(get_db())
        try:
            insert_fragment(db, session_id=session.id, text="The quick brown fox")
            insert_fragment(db, session_id=session.id, text="Jumps over the lazy dog")
            insert_fragment(db, session_id=session.id, text="Quick brown fox jumps high")

            results = search_fragments(db, "fox")
            assert len(results) >= 2

            results = search_fragments(db, "lazy")
            assert len(results) == 1
        finally:
            db.close()

    def test_search_fragments_with_language(self, test_db, session):
        """搜索片段时可按语种过滤."""
        db = next(get_db())
        try:
            insert_fragment(db, session_id=session.id, text="Hello world", language="en")
            insert_fragment(db, session_id=session.id, text="你好世界", language="zh")
            results = search_fragments(db, "Hello", language="en")
            assert len(results) >= 1
            results = search_fragments(db, "Hello", language="zh")
            assert len(results) == 0
        finally:
            db.close()

    def test_get_fragments_by_word_sentence_start(self, test_db, session):
        """句首单词应能被查询到 (BUG-4 regression test)."""
        db = next(get_db())
        try:
            insert_fragment(db, session_id=session.id, text="Hello world")
            results = get_fragments_by_word(db, "Hello", session.id)
            assert len(results) >= 1, "句首单词 'Hello' 应被匹配"

            results = get_fragments_by_word(db, "world", session.id)
            assert len(results) >= 1, "句尾单词 'world' 应被匹配"
        finally:
            db.close()

    def test_get_fragments_by_word_case_insensitive(self, test_db, session):
        """单词匹配应不区分大小写."""
        db = next(get_db())
        try:
            insert_fragment(db, session_id=session.id, text="Hello World")
            results = get_fragments_by_word(db, "hello", session.id)
            assert len(results) >= 1
            results = get_fragments_by_word(db, "WORLD", session.id)
            assert len(results) >= 1
        finally:
            db.close()


class TestSearchAPI:
    """Search/Provenance API endpoints via TestClient."""

    def test_search_provenance(self, client, test_db):
        """GET /api/search/provenance 应返回单词的溯源信息."""
        # 先创建会话和片段
        db = next(get_db())
        session = create_session(db, source_name="test video")
        insert_fragment(db, session_id=session.id, text="Hello world from transcript",
                        start_time=0.0, end_time=2.0, source_name="test.mp4")
        insert_fragment(db, session_id=session.id, text="Hello again from another fragment",
                        start_time=3.0, end_time=5.0, source_name="test.mp4")
        db.close()

        resp = client.get("/api/search/provenance?q=Hello&limit=10")
        assert resp.status_code == 200
        data = resp.json()
        assert data["code"] == 200
        assert data["data"]["word"] == "Hello"
        assert len(data["data"]["matches"]) >= 1

    def test_search_provenance_no_results(self, client):
        """不存在单词应返回空结果."""
        resp = client.get("/api/search/provenance?q=zzzznonexistent&limit=10")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["data"]["matches"]) == 0

    def test_search_fragments_api(self, client, test_db):
        """GET /api/search/fragments 应返回匹配的片段."""
        db = next(get_db())
        session = create_session(db)
        insert_fragment(db, session_id=session.id, text="Quick brown fox")
        insert_fragment(db, session_id=session.id, text="Lazy dog")
        db.close()

        resp = client.get("/api/search/fragments?q=fox")
        assert resp.status_code == 200
        data = resp.json()
        assert data["code"] == 200
        assert len(data["data"]) >= 1

    def test_search_suggestions(self, client):
        """GET /api/search/suggestions 应返回前缀建议."""
        resp = client.get("/api/search/suggestions?q=he")
        # 即使没有数据也不应报错
        assert resp.status_code == 200


class TestSessionAPI:
    """Session API endpoints via TestClient."""

    def test_list_sessions_api(self, client, test_db):
        """GET /api/sessions/list 应返回会话列表."""
        db = next(get_db())
        create_session(db, source_name="session1")
        create_session(db, source_name="session2")
        db.close()

        resp = client.get("/api/sessions/list")
        assert resp.status_code == 200
        data = resp.json()
        assert data["code"] == 200
        assert len(data["data"]) >= 2

    def test_get_active_session_api(self, client, test_db):
        """GET /api/sessions/active 应返回活跃会话."""
        db = next(get_db())
        session = create_session(db, source_name="active session")
        db.close()

        resp = client.get("/api/sessions/active")
        assert resp.status_code == 200
        data = resp.json()
        assert data["code"] == 200
        assert data["data"]["id"] == session.id

    def test_get_session_fragments(self, client, test_db):
        """GET /api/sessions/{id}/fragments 应返回会话片段."""
        db = next(get_db())
        session = create_session(db)
        session_id = session.id  # capture before db.close()
        insert_fragment(db, session_id=session_id, text="fragment one")
        insert_fragment(db, session_id=session_id, text="fragment two")
        db.close()

        resp = client.get(f"/api/sessions/{session_id}/fragments")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["data"]) == 2
