"""上传修复验证测试 — 覆盖 health + upload 3 个必现 Bug"""
import os
import sys
import tempfile

# === 必须在任何项目 import 之前设置 env ===
TEST_DIR = tempfile.mkdtemp(prefix="linguacaption_upload_test_")
TEST_UPLOAD_DIR = os.path.join(TEST_DIR, "uploads")
os.environ["LC_AUDIO_UPLOAD_DIR"] = TEST_UPLOAD_DIR
os.environ["LINGUACAPTION_DB_PATH"] = os.path.join(TEST_DIR, "test.db")

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

import json
import struct
import math
import wave

from fastapi.testclient import TestClient
from database import init_db, dispose_engine
from database.migrations import apply_migrations
from main import app

# 确认 env 生效
from config import settings
assert settings.audio_upload_dir == TEST_UPLOAD_DIR, \
    f"期望 {TEST_UPLOAD_DIR}, 实际 {settings.audio_upload_dir}"

# 初始化数据库
init_db(os.environ["LINGUACAPTION_DB_PATH"])
apply_migrations()

client = TestClient(app)

# ── Test Helpers ─────────────────────────────────────────────

passed = 0
failed = 0
test_id = 0


def gen_wav(duration_sec=1, sample_rate=16000):
    """生成一个真实的 WAV 音频字节"""
    num_samples = int(duration_sec * sample_rate)
    buf_parts = []
    for i in range(num_samples):
        sample = int(32767 * 0.3 * math.sin(2 * math.pi * 440.0 * i / sample_rate))
        buf_parts.append(struct.pack('<h', sample))
    raw_data = b''.join(buf_parts)
    wav_io = tempfile.SpooledTemporaryFile()
    with wave.open(wav_io, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(raw_data)
    wav_io.seek(0)
    return wav_io.read()


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
print("  上传修复验证测试 — Bug #1, #2, #3")
print("=" * 56)

# ──── Test 1: Health Check ────
print("\n🏥 Test 1: Health Check (健康检查)")
resp = client.get("/api/health")
assert_eq("响应状态码 200", resp.status_code, 200)
data = resp.json()
assert_eq("status = ok", data.get("status"), "ok")
assert_eq("version = 0.1.0", data.get("version"), "0.1.0")

# ──── Test 2: 真实 WAV 上传 ────
print("\n🎵 Test 2: 真实 WAV 音频上传（验证 chunked 写入不损坏）")
wav_bytes = gen_wav(duration_sec=0.5)
assert_true(f"WAV 数据大小 > 0 ({len(wav_bytes)} bytes)", len(wav_bytes) > 0)

resp = client.post(
    "/api/transcription/upload",
    files={"file": ("test_audio.wav", wav_bytes, "audio/wav")},
)
assert_eq("响应状态码 200", resp.status_code, 200)
data = resp.json()
assert_eq("返回 task_id 非空", bool(data.get("task_id")), True)
assert_eq("状态为 pending", data.get("status"), "pending")
task_id1 = data["task_id"]

# ──── Test 3: 验证文件已写入且大小正确 ────
print("\n📁 Test 3: 验证文件已写入且大小正确")
assert_true(f"upload_dir 存在: {TEST_UPLOAD_DIR}", os.path.isdir(TEST_UPLOAD_DIR))
uploaded_files = os.listdir(TEST_UPLOAD_DIR)
task_file = [f for f in uploaded_files if task_id1 in f]
assert_eq(f"找到 task_id({task_id1[:8]}...) 对应的文件", len(task_file), 1)
file_path = os.path.join(TEST_UPLOAD_DIR, task_file[0])
file_size = os.path.getsize(file_path)
assert_true(f"文件大小 > 0 ({file_size} bytes)", file_size > 0)
# Bug #1 验证: 文件大小必须与上传完全一致（否则说明 chunked 写入损坏）
assert_eq("✅ Bug#1 修复: 文件大小与上传完全一致", file_size, len(wav_bytes))

# ──── Test 4: 大文件上传（验证 chunked 逐块写入不损坏） ────
print("\n📦 Test 4: 大文件上传（测试 chunked 逐块写入）")
large_wav = gen_wav(duration_sec=30)  # ~960KB
assert_true(f"大文件大小 > 100KB ({len(large_wav)} bytes)", len(large_wav) > 100_000)

resp = client.post(
    "/api/transcription/upload",
    files={"file": ("large_test.wav", large_wav, "audio/wav")},
)
assert_eq("大文件上传 → 200", resp.status_code, 200)
data2 = resp.json()
task_id2 = data2["task_id"]
assert_true("大文件返回 task_id", bool(task_id2))

# 验证大文件写入完整性
large_files = [f for f in os.listdir(TEST_UPLOAD_DIR) if task_id2 in f]
assert_eq("找到大文件", len(large_files), 1)
large_path = os.path.join(TEST_UPLOAD_DIR, large_files[0])
assert_eq("✅ Bug#1 修复: 大文件大小完全一致（chunked 写入正确）",
           os.path.getsize(large_path), len(large_wav))

# ──── Test 5: 文件类型校验 ────
print("\n🚫 Test 5: 文件类型校验（拒绝非音频）")
resp = client.post(
    "/api/transcription/upload",
    files={"file": ("malware.exe", b"MZ\x90\x00\x03\x00\x00\x00\x04\x00", "application/x-msdownload")},
)
assert_eq("exe 文件 → 400", resp.status_code, 400)
assert_true("✅ Bug#2 修复: 错误信息含 'audio'",
             "audio" in resp.json().get("detail", "").lower())

resp = client.post(
    "/api/transcription/upload",
    files={"file": ("notes.txt", b"hello", "text/plain")},
)
assert_eq("txt 文件 → 400", resp.status_code, 400)

# ──── Test 6: 空文件名 → FastAPI 返回 422 验证错误 ────
print("\n📛 Test 6: 上传空文件名（FastAPI 返回 422）")
resp = client.post(
    "/api/transcription/upload",
    files={"file": ("", b"some bytes", "audio/mpeg")},
)
# FastAPI 先于代码校验空文件名，返回 422
assert_eq("空文件名 → 422（FastAPI 校验拦截）", resp.status_code, 422)

# ──── Test 7: 安全文件名（路径穿越防护） ────
print("\n🛡️  Test 7: 安全文件名（路径穿越防护）")
resp = client.post(
    "/api/transcription/upload",
    files={"file": ("../../etc/passwd", b"fake audio", "audio/wav")},
)
assert_eq("路径穿越文件名 → 200（被 secure_filename 净化）", resp.status_code, 200)
all_files = os.listdir(TEST_UPLOAD_DIR)
# secure_filename("../../etc/passwd") → "etc_passwd" — 路径分隔符被移除
traversal_attempts = [f for f in all_files if '..' in f or os.sep in f]
assert_eq("✅ Bug#2 修复: 所有文件名不含路径穿越字符", len(traversal_attempts), 0)
# 验证确实是净化后的文件名
has_clean_name = any('etc_passwd' in f for f in all_files)
assert_true("文件名被安全净化（含 etc_passwd）", has_clean_name)

# ──── Test 8: 查询任务状态 ────
print("\n🔍 Test 8: 查询上传后的任务状态")
resp = client.get(f"/api/transcription/task/{task_id1}")
assert_eq("任务查询 → 200", resp.status_code, 200)
data3 = resp.json()
assert_true("status 是有效值", data3.get("status") in ("pending", "processing", "completed", "failed"))
assert_eq("task_id 一致", data3.get("task_id"), task_id1)

# 不存在的任务
resp = client.get("/api/transcription/task/nonexistent-task-id")
assert_eq("不存在任务 → 404", resp.status_code, 404)

# ──── Test 9: 并发上传 ────
print("\n⚡ Test 9: 并发上传（多文件测试 key 不冲突）")
results = []
for i in range(5):
    r = client.post(
        "/api/transcription/upload",
        files={"file": (f"concurrent_{i}.wav", gen_wav(0.1), "audio/wav")},
    )
    results.append(r)
all_ok = all(r.status_code == 200 for r in results)
assert_true("5 个并发上传全部成功", all_ok)
task_ids = set(r.json()["task_id"] for r in results)
assert_eq("5 个唯一 task_id", len(task_ids), 5)


# ── 总结 ─────────────────────────────────────────────────────
print("\n" + "=" * 56)
total = passed + failed
print(f"  总计: {total} 个测试  |  ✅ 通过: {passed}  |  ❌ 失败: {failed}")
print("=" * 56)

# 清理
cleanup_ok = True
import shutil
try:
    shutil.rmtree(TEST_DIR)
except Exception as e:
    cleanup_ok = False
    print(f"  清理失败: {e}")

print(f"  临时数据清理: {'✅' if cleanup_ok else '⚠️ 残留'}")
print()

dispose_engine()

sys.exit(0 if failed == 0 else 1)
