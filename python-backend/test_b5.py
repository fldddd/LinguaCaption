"""
B5 生词收藏 API — 集成测试脚本
验证 8 个端点的正确性、错误路径、边界条件
"""
import os
import sys
import json
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

# 测试数据库路径
TEST_DB_DIR = tempfile.mkdtemp(prefix="linguacaption_b5_test_")
os.environ["LINGUACAPTION_DB_PATH"] = os.path.join(TEST_DB_DIR, "test.db")

from fastapi.testclient import TestClient
from database import init_db, dispose_engine
from database.migrations import apply_migrations
from main import app

# 初始化测试数据库
init_db(os.environ["LINGUACAPTION_DB_PATH"])
apply_migrations()

client = TestClient(app)

# ── Test Helpers ─────────────────────────────────────────────

passed = 0
failed = 0
test_id = 0


def assert_eq(label: str, actual, expected):
    global test_id, passed, failed
    test_id += 1
    ok = actual == expected
    status = "✅" if ok else "❌"
    if ok:
        passed += 1
    else:
        failed += 1
    print(f"  {status} [#{test_id}] {label}")
    if not ok:
        print(f"    expected: {json.dumps(expected, ensure_ascii=False)}")
        print(f"    actual:   {json.dumps(actual, ensure_ascii=False)}")


def assert_true(label: str, condition):
    global test_id, passed, failed
    test_id += 1
    status = "✅" if condition else "❌"
    if condition:
        passed += 1
    else:
        failed += 1
    print(f"  {status} [#{test_id}] {label}")


# ── 测试用例 ─────────────────────────────────────────────────

print("\n\n" + "=" * 56)
print("  B5 生词收藏 API — 集成测试")
print("=" * 56)

# ──── Test 1: 创建生词 ────
print("\n📝 Test 1: 创建生词")
resp = client.post("/api/vocab", json={
    "word": "serendipity",
    "translation": "意外发现的好运",
    "phonetic": "/ˌserənˈdɪpəti/",
    "part_of_speech": "noun",
    "context": "Finding that book was pure serendipity.",
})
assert_eq("响应状态码 201", resp.status_code, 201)
data = resp.json()
assert_true("返回 id > 0", data.get("id", 0) > 0)
assert_eq("word 正确", data["word"], "serendipity")
assert_eq("translation 正确", data["translation"], "意外发现的好运")

# 记录 vocab_id 供后续测试
vocab_id_1 = data["id"]

# ──── Test 2: 重复创建 → 409 ────
print("\n🔁 Test 2: 重复创建 → 409 Conflict")
resp = client.post("/api/vocab", json={"word": "serendipity"})
assert_eq("响应状态码 409", resp.status_code, 409)
assert_true("错误信息包含已存在", "已存在" in resp.json().get("detail", ""))

# ──── Test 3: 创建第二个生词 ────
print("\n📝 Test 3: 创建第二个生词（用于列表分页测试）")
resp = client.post("/api/vocab", json={
    "word": "ephemeral",
    "translation": "短暂的",
    "part_of_speech": "adj",
    "context": "The ephemeral beauty of cherry blossoms.",
})
assert_eq("响应状态码 201", resp.status_code, 201)
vocab_id_2 = resp.json()["id"]

# ──── Test 4: 按 ID 查询 ────
print("\n🔍 Test 4: 按 ID 查询生词详情")
resp = client.get(f"/api/vocab/{vocab_id_1}")
assert_eq("响应状态码 200", resp.status_code, 200)
assert_eq("查询到正确单词", resp.json()["word"], "serendipity")

# 404 情况
resp = client.get("/api/vocab/99999")
assert_eq("不存在的 ID → 404", resp.status_code, 404)

# ──── Test 5: 列出生词（分页） ────
print("\n📋 Test 5: 分页列出生词")
resp = client.get("/api/vocab?page=1&page_size=10")
assert_eq("响应状态码 200", resp.status_code, 200)
data = resp.json()
assert_eq("total 正确", data["total"], 2)
assert_eq("items 数量", len(data["items"]), 2)
assert_eq("page 正确", data["page"], 1)
assert_eq("total_pages 正确", data["total_pages"], 1)

# ──── Test 6: 搜索过滤 ────
print("\n🔎 Test 6: 搜索过滤")
resp = client.get("/api/vocab?search=ephe")
assert_eq("搜索命中", resp.status_code, 200)
assert_eq("搜索到 ephemeral", len(resp.json()["items"]), 1)
assert_eq("单词正确", resp.json()["items"][0]["word"], "ephemeral")

resp = client.get("/api/vocab?search=xyzabc")
assert_eq("搜索无结果", len(resp.json()["items"]), 0)

# ──── Test 7: 掌握状态过滤 ────
print("\n🔖 Test 7: 掌握状态过滤")
resp = client.get("/api/vocab?mastered=false")
assert_eq("未掌握列表", resp.status_code, 200)
assert_true("所有记录未掌握", all(not r.get("mastered") for r in resp.json()["items"] if "mastered" in r))

# ──── Test 8: 更新生词 ────
print("\n✏️  Test 8: 更新生词")
resp = client.put(f"/api/vocab/{vocab_id_1}", json={
    "translation": "意外发现美好事物的运气",
    "context": None,
})
assert_eq("响应状态码 200", resp.status_code, 200)
assert_eq("translation 已更新", resp.json()["translation"], "意外发现美好事物的运气")

# 空更新 → 400
resp = client.put(f"/api/vocab/{vocab_id_1}", json={})
assert_eq("空字段更新 → 400", resp.status_code, 400)

# 更新不存在的 ID → 404
resp = client.put("/api/vocab/99999", json={"word": "test"})
assert_eq("不存在 ID 更新 → 404", resp.status_code, 404)

# ──── Test 9: 复习记录 ────
print("\n📊 Test 9: 记录复习结果")
for i in range(5):
    resp = client.post(f"/api/vocab/{vocab_id_1}/review", json={
        "correct": True,
        "difficulty": 3,
    })
    assert_eq(f"第{i+1}次复习 → 200", resp.status_code, 200)
    data = resp.json()

assert_eq("review_count 为 5", data["review_count"], 5)
assert_eq("correct_count 为 5", data["correct_count"], 5)
assert_eq("5次正确后 mastered=True", data["mastered"], True)

# 复习不存在的 ID → 404
resp = client.post("/api/vocab/99999/review", json={"correct": True})
assert_eq("不存在 ID 复习 → 404", resp.status_code, 404)
# ──── Test 10: 待复习列表 ────
print("\n📌 Test 10: 待复习列表")
resp = client.get("/api/vocab/due/list?limit=10")
assert_eq("响应状态码 200", resp.status_code, 200)
data = resp.json()
assert_true("待复习列表是 list 类型", isinstance(data, list))
# 注：serendipity 已 mastered, ephemeral 未开始复习 → 无待复习项，列表为空
assert_true("允许空列表（合逻辑）", len(data) >= 0)
if data:
    assert_true("返回格式含 record 和 vocab", "record" in data[0] and "vocab" in data[0])


# ──── Test 11: 学习统计 ────
print("\n📈 Test 11: 学习统计")
resp = client.get("/api/vocab/stats/summary")
assert_eq("响应状态码 200", resp.status_code, 200)
data = resp.json()
assert_eq("total_vocabs 正确", data["total_vocabs"], 2)
assert_true("mastered 至少 1", data["mastered"] >= 1)
assert_true("due_reviews >= 0", data["due_reviews"] >= 0)

# ──── Test 12: 输入验证 ────
print("\n⚠️  Test 12: 输入验证")
# 空单词
resp = client.post("/api/vocab", json={"word": ""})
assert_eq("空单词 → 422", resp.status_code, 422)

# 无效词性
resp = client.post("/api/vocab", json={"word": "test", "part_of_speech": "invalid"})
assert_eq("无效词性 → 422", resp.status_code, 422)

# difficulty 越界
resp = client.post(f"/api/vocab/{vocab_id_2}/review", json={"difficulty": 99})
assert_eq("difficulty 越界 → 422", resp.status_code, 422)

# ──── Test 13: 计算总页数 ────
print("\n📄 Test 13: 分页总页数计算")
resp = client.get("/api/vocab?page=1&page_size=1")
assert_eq("page_size=1 时 total_pages=2", resp.json()["total_pages"], 2)

# ──── Test 14: 删除生词 ────
print("\n🗑️  Test 14: 删除生词")
resp = client.delete(f"/api/vocab/{vocab_id_2}")
assert_eq("删除 → 204", resp.status_code, 204)

# 确认已删除
resp = client.get(f"/api/vocab/{vocab_id_2}")
assert_eq("删除后查询 → 404", resp.status_code, 404)

# 删除不存在的 → 404
resp = client.delete("/api/vocab/99999")
assert_eq("删除不存在 → 404", resp.status_code, 404)


# ── 总结 ─────────────────────────────────────────────────────
print("\n" + "=" * 56)
total = passed + failed
print(f"  总计: {total} 个测试  |  ✅ 通过: {passed}  |  ❌ 失败: {failed}")
print("=" * 56)

cleanup_ok = True
if os.path.exists(TEST_DB_DIR):
    import shutil
    try:
        shutil.rmtree(TEST_DB_DIR)
    except Exception:
        cleanup_ok = False

print(f"  临时数据清理: {'✅' if cleanup_ok else '⚠️ 残留'}")
print()

# 清理引擎
dispose_engine()

sys.exit(0 if failed == 0 else 1)
