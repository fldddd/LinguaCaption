"""
PR #44: 词汇 API 路径从 /api/vocabulary 改为 /api/vocab

测试词汇 API 所有端点 — CRUD、复习、收藏、统计。

覆盖:
- 正常路径：创建 / 查询 / 更新 / 删除 / 复习 / 统计
- 错误边界：404（不存在）、409（重复）、400（空字段）、422（校验失败）
- 分页、搜索、状态过滤
"""
import pytest


class TestVocabAPI:
    """词汇 API 完整测试套件 — 每个类方法使用唯一单词名避免冲突"""

    # ──────────────────────────────────────────────
    # 创建生词 (POST /api/vocab)
    # ──────────────────────────────────────────────

    def test_create_vocab_success(self, client):
        """创建生词 → 201 + 返回正确字段"""
        resp = client.post("/api/vocab", json={
            "word": "serendipity1",
            "translation": "意外发现的好运",
            "phonetic": "/ˌserənˈdɪpəti/",
            "part_of_speech": "noun",
            "context": "Finding that book was pure serendipity.",
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["id"] > 0
        assert data["word"] == "serendipity1"
        assert data["translation"] == "意外发现的好运"

    def test_create_vocab_duplicate(self, client):
        """重复创建相同单词 → 409 Conflict"""
        resp = client.post("/api/vocab", json={"word": "dup_word", "translation": "第一"})
        assert resp.status_code == 201

        resp2 = client.post("/api/vocab", json={"word": "dup_word"})
        assert resp2.status_code == 409
        assert "已存在" in resp2.json()["detail"]

    def test_create_vocab_empty_word(self, client):
        """空单词 → 422 校验错误"""
        resp = client.post("/api/vocab", json={"word": ""})
        assert resp.status_code == 422

    def test_create_vocab_invalid_pos(self, client):
        """无效词性 → 422 校验错误"""
        resp = client.post("/api/vocab", json={
            "word": "pos_test_word",
            "part_of_speech": "invalid_xxx",
        })
        assert resp.status_code == 422

    def test_create_vocab_minimal(self, client):
        """仅必填字段创建 → 201 成功"""
        resp = client.post("/api/vocab", json={"word": "minimal_word_only"})
        assert resp.status_code == 201
        assert resp.json()["word"] == "minimal_word_only"

    # ──────────────────────────────────────────────
    # 查询生词 (GET /api/vocab/{id})
    # ──────────────────────────────────────────────

    def test_get_vocab_by_id(self, client):
        """按 ID 查询 → 返回正确单词"""
        # Create first
        resp = client.post("/api/vocab", json={"word": "get_by_id_test"})
        assert resp.status_code == 201
        cid = resp.json()["id"]

        # Then get by ID
        resp = client.get(f"/api/vocab/{cid}")
        assert resp.status_code == 200
        assert resp.json()["word"] == "get_by_id_test"

    def test_get_vocab_not_found(self, client):
        """查不存在的 ID → 404"""
        resp = client.get("/api/vocab/99999")
        assert resp.status_code == 404

    # ──────────────────────────────────────────────
    # 生词列表 (GET /api/vocab)
    # ──────────────────────────────────────────────

    def test_list_vocab_pagination(self, client):
        """分页列出生词"""
        for w in ["alpha_list", "beta_list", "gamma_list"]:
            client.post("/api/vocab", json={"word": w})

        resp = client.get("/api/vocab?page=1&page_size=2")
        assert resp.status_code == 200
        data = resp.json()
        assert data["page"] == 1
        assert data["page_size"] == 2
        assert len(data["items"]) <= 2
        assert data["total"] >= 3
        assert data["total_pages"] >= 2

    def test_list_vocab_search(self, client):
        """搜索过滤 → 只返回匹配项"""
        client.post("/api/vocab", json={"word": "abandon"})
        client.post("/api/vocab", json={"word": "ability"})
        client.post("/api/vocab", json={"word": "zebra"})

        resp = client.get("/api/vocab?search=ab")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert len(items) >= 2  # abandon, ability
        assert all("ab" in it["word"].lower() for it in items)

    def test_list_vocab_search_no_match(self, client):
        """搜索无结果 → 空列表"""
        resp = client.get("/api/vocab?search=zzzxyzzy_unlikely")
        assert resp.status_code == 200
        assert resp.json()["items"] == []
        assert resp.json()["total"] == 0

    def test_list_vocab_mastered_filter(self, client):
        """掌握状态过滤 → 仅返回对应状态的记录"""
        # Create a word and review it 5 times to mark as mastered
        resp = client.post("/api/vocab", json={"word": "master_me_filter"})
        assert resp.status_code == 201
        cid = resp.json()["id"]
        for _ in range(5):
            client.post(f"/api/vocab/{cid}/review", json={"correct": True, "difficulty": 3})

        # Filter mastered=true
        resp = client.get("/api/vocab?mastered=true")
        assert resp.status_code == 200
        assert any(it["word"] == "master_me_filter" for it in resp.json()["items"])

    # ──────────────────────────────────────────────
    # 更新生词 (PUT /api/vocab/{id})
    # ──────────────────────────────────────────────

    def test_update_vocab_success(self, client):
        """更新生词 → 200 + 字段正确更新"""
        cid = client.post("/api/vocab", json={"word": "update_test_word"}).json()["id"]

        resp = client.put(f"/api/vocab/{cid}", json={
            "translation": "更新后的翻译",
            "context": None,
        })
        assert resp.status_code == 200
        assert resp.json()["translation"] == "更新后的翻译"

    def test_update_vocab_empty_payload(self, client):
        """空更新 → 400"""
        cid = client.post("/api/vocab", json={"word": "empty_update_word"}).json()["id"]
        resp = client.put(f"/api/vocab/{cid}", json={})
        assert resp.status_code == 400

    def test_update_vocab_not_found(self, client):
        """更新不存在的 ID → 404"""
        resp = client.put("/api/vocab/99999", json={"word": "newword"})
        assert resp.status_code == 404

    # ──────────────────────────────────────────────
    # 删除生词 (DELETE /api/vocab/{id})
    # ──────────────────────────────────────────────

    def test_delete_vocab_success(self, client):
        """删除生词 → 204 + 后续查询返回 404"""
        cid = client.post("/api/vocab", json={"word": "delete_me_word"}).json()["id"]

        resp = client.delete(f"/api/vocab/{cid}")
        assert resp.status_code == 204

        # Verify deletion
        resp2 = client.get(f"/api/vocab/{cid}")
        assert resp2.status_code == 404

    def test_delete_vocab_not_found(self, client):
        """删除不存在的 ID → 404"""
        resp = client.delete("/api/vocab/99999")
        assert resp.status_code == 404

    # ──────────────────────────────────────────────
    # 复习记录 (POST /api/vocab/{id}/review)
    # ──────────────────────────────────────────────

    def test_review_vocab_success(self, client):
        """记录复习 → 200 + 正确返回复习计数"""
        cid = client.post("/api/vocab", json={"word": "review_word1"}).json()["id"]

        resp = client.post(f"/api/vocab/{cid}/review", json={
            "correct": True,
            "difficulty": 3,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["review_count"] == 1
        assert data["correct_count"] == 1

    def test_review_to_mastered(self, client):
        """连续正确 5 次后 mastered=True"""
        cid = client.post("/api/vocab", json={"word": "to_mastered_word"}).json()["id"]

        for i in range(5):
            resp = client.post(f"/api/vocab/{cid}/review", json={
                "correct": True,
                "difficulty": 3,
            })
            assert resp.status_code == 200

        data = client.post(f"/api/vocab/{cid}/review", json={
            "correct": True,
            "difficulty": 3,
        }).json()
        assert data["review_count"] == 6
        assert data["mastered"] is True

    def test_review_difficulty_out_of_range(self, client):
        """difficulty 越界（>5）→ 422"""
        cid = client.post("/api/vocab", json={"word": "diff_out_of_range"}).json()["id"]
        resp = client.post(f"/api/vocab/{cid}/review", json={
            "correct": True,
            "difficulty": 99,
        })
        assert resp.status_code == 422

    def test_review_not_found(self, client):
        """复习不存在的 ID → 404"""
        resp = client.post("/api/vocab/99999/review", json={"correct": True})
        assert resp.status_code == 404

    # ──────────────────────────────────────────────
    # 待复习列表 (GET /api/vocab/due/list)
    # ──────────────────────────────────────────────

    def test_due_reviews_list(self, client):
        """待复习列表 → 200 + 返回列表（可能为空）"""
        resp = client.get("/api/vocab/due/list?limit=10")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        if data:
            assert "record" in data[0]
            assert "vocab" in data[0]

    def test_due_reviews_invalid_limit(self, client):
        """limit 越界（>100）→ 422"""
        resp = client.get("/api/vocab/due/list?limit=999")
        assert resp.status_code == 422

    # ──────────────────────────────────────────────
    # 学习统计 (GET /api/vocab/stats/summary)
    # ──────────────────────────────────────────────

    def test_learning_stats(self, client):
        """学习统计 → 返回正确的汇总数据"""
        resp = client.get("/api/vocab/stats/summary")
        assert resp.status_code == 200
        data = resp.json()
        assert "total_vocabs" in data
        assert "mastered" in data
        assert "learning" in data
        assert "due_reviews" in data
        assert data["total_vocabs"] >= 0
        assert data["mastered"] >= 0
        assert data["due_reviews"] >= 0

    # ──────────────────────────────────────────────
    # 边界条件：非法 ID
    # ──────────────────────────────────────────────

    def test_negative_id(self, client):
        """负数 ID → 404 或 422"""
        resp = client.get("/api/vocab/-1")
        assert resp.status_code in (404, 422)

    def test_non_integer_id(self, client):
        """非整数 ID → 422"""
        resp = client.get("/api/vocab/abc")
        assert resp.status_code == 422
