"""B6 数据库模块验证脚本"""
import os
import sys
from pathlib import Path

# 设置测试数据库路径
os.environ["LINGUACAPTION_DB_PATH"] = str(
    Path(__file__).resolve().parent / "data" / "test_verify.db"
)

print("=== Test 1: Init & Migration ===")
from database import init_db, dispose_engine
from database.migrations import ensure_initial_migration, apply_migrations

init_db()
ensure_initial_migration()
migrated = apply_migrations()
print(f"  ✅ 迁移完成: {migrated}")

print("\n=== Test 2: Vocab CRUD ===")
from database.crud import (
    create_vocab, get_vocab, get_vocab_by_word,
    list_vocabs, update_vocab, delete_vocab, count_vocabs,
)

v1 = create_vocab("serendipity", translation="意外发现", phonetic="/ˌserənˈdɪpəti/", part_of_speech="noun")
v2 = create_vocab("ephemeral", translation="短暂的", part_of_speech="adj")
v3 = create_vocab("ubiquitous", translation="无处不在的", part_of_speech="adj")
print(f"  ✅ 创建 3 生词: {v1['word']}, {v2['word']}, {v3['word']}")

vocab = get_vocab(v1["id"])
assert vocab["translation"] == "意外发现"
print(f"  ✅ 按ID查询: {vocab['word']} → {vocab['translation']}")

by_word = get_vocab_by_word("ephemeral")
assert by_word["part_of_speech"] == "adj"
print(f"  ✅ 按单词查询: {by_word['word']}")

updated = update_vocab(v2["id"], context="Life is ephemeral.")
assert updated["context"] == "Life is ephemeral."
print(f"  ✅ 更新上下文: {updated['context']}")

all_v = list_vocabs()
assert all_v["total"] == 3
print(f"  ✅ 列表: {all_v['total']} 个, page={all_v['page']}/{all_v['total_pages']}")

assert count_vocabs() == 3
print(f"  ✅ 统计: {count_vocabs()}")

print("\n=== Test 3: Subtitle CRUD ===")
from database.crud import create_subtitle, bulk_create_subtitles, search_subtitles, list_subtitles

s1 = create_subtitle("Hello, how are you today?", 0.5, 2.3)
bulk = bulk_create_subtitles([
    {"text": "What about you?", "start_time": 4.2, "end_time": 5.0},
    {"text": "I am fine as well.", "start_time": 5.2, "end_time": 6.5},
])
assert list_subtitles()["total"] == 3
print(f"  ✅ 字幕列表: {list_subtitles()['total']} 条")

results = search_subtitles("fine")
assert len(results) == 1
print(f"  ✅ 搜索 'fine': {len(results)} 条")

print("\n=== Test 4: Learning Records ===")
from database.crud import record_review, get_record_by_vocab, get_learning_stats

rec = get_record_by_vocab(v1["id"])
assert rec["review_count"] == 0
print(f"  ✅ 初始记录: count={rec['review_count']}, mastered={rec['mastered']}")

for i in range(5):
    record_review(v1["id"], correct=True)

rec = get_record_by_vocab(v1["id"])
assert rec["mastered"] is True
assert rec["correct_count"] == 5
print(f"  ✅ 5次正确 → mastered={rec['mastered']}")

record_review(v2["id"], correct=False, difficulty=4)
rec2 = get_record_by_vocab(v2["id"])
assert rec2["mastered"] is False
print(f"  ✅ 答错后 mastered={rec2['mastered']}")

stats = get_learning_stats()
assert stats["mastered"] == 1
print(f"  ✅ 统计: {stats}")

print("\n=== Test 5: Backup ===")
from database.backup import backup, list_backups

bp = backup(tag="test")
bp_path = Path(bp)
assert bp_path.exists()
print(f"  ✅ 备份文件: {bp_path.name} ({bp_path.stat().st_size} bytes)")

backups = list_backups()
assert len(backups) >= 1
print(f"  ✅ 备份列表: {len(backups)} 个")

print("\n=== Test 6: Delete ===")
assert count_vocabs() == 3
delete_vocab(v3["id"])
assert count_vocabs() == 2
print(f"  ✅ 删除后剩余: {count_vocabs()} 个")

dispose_engine()
print("\n🎉 B6 数据库模块全部测试通过！")
