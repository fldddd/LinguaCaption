# LinguaCaption 代码审查报告

审查日期: 2026-05-18
审查范围: electron/ (前端) + python-backend/ (后端)
审查深度: 全量文件通读

---

## Critical (严重)

### CRIT-1: 前后端 API 路径不匹配 — `/api/vocabulary` vs `/api/vocab` (全局性 Bug)

前端 `api.js` 的所有 Vocabulary API 调用使用 `/api/vocabulary` 路径：

```js
// api.js 第 88 行
return request('GET', `/api/vocabulary${qs ? '?' + qs : ''}`);
// 第 97 行
return request('POST', '/api/vocabulary', word);
// 第 105 行
return request('DELETE', `/api/vocabulary/${wordId}`);
// 第 114 行
return request('POST', `/api/vocabulary/${wordId}/favorite`);
```

但后端 `vocabulary.py` 的 router prefix 是 `"/vocab"`（第 22 行），在 `main.py` 中以 `prefix="/api"` 注册（第 102 行），实际路径为 **`/api/vocab/...`**。

**影响范围：** 
- `getVocabulary()` → GET `/api/vocabulary` → **404**
- `addWord()` → POST `/api/vocabulary` → **404**
- `removeWord()` → DELETE `/api/vocabulary/{id}` → **404**
- `toggleFavorite()` → POST `/api/vocabulary/{id}/favorite` → **404**（且后端根本没有此端点）
- `storage.js` 的 `getFavorites()`, `saveFavorite()`, `deleteFavorite()`, `fullSync()` 全部依赖上述函数 → **整体离线同步机制完全失效**

**修复建议：** 统一使用 `/api/vocab`（后端现有路径），修改 `api.js` 中的路径；或修改后端 prefix 为 `"/vocabulary"`。

### CRIT-2: toggleFavorite() 调用不存在的后端端点

前端 `api.js` 第 114 行：
```js
export async function toggleFavorite(wordId) {
  return request('POST', `/api/vocabulary/${wordId}/favorite`);
}
```

后端 `vocabulary.py` 中没有 `/favorite` 端点。删除生词应使用 `DELETE /api/vocab/{id}`，收藏/取消收藏没有独立 API。

**修复建议：** 移除前端 `toggleFavorite` 调用，改用 `removeWord` (DELETE) 取消收藏；若需要独立收藏功能，后端需新增端点。

### CRIT-3: Word Frequency Service 缓存刷新存在数据丢失 Race Condition

`word_frequency.py` `_flush_to_db()` 方法（第 219-288 行）：

1. 先获取缓存快照 `cache_snapshot = dict(self._cache)`（第 227 行）
2. 然后将快照写入数据库
3. 最后将缓存计数清零：`self._cache[word]["cumulative"] = 0`（第 266 行）

**Bug：** 如果在步骤 1 和步骤 3 之间，`record_text()` 被并发调用增加了某个单词的计数，则这些新增的计数会被步骤 3 意外清零（而非减去已刷新的部分）。

**影响：** 词频数据的累计计数会随机丢失，且难以复现。

**修复建议：** 使用 `self._cache[word]["cumulative"] -= entry["cumulative"]`（减法）替代直接置零，或使用原子操作。

### CRIT-4: overlay.js 拖拽系统使用 screenX/clientX 混算导致位置偏移

`electron/src/scripts/overlay.js` 拖拽计算：

- mousedown（第 138 行）：`dragOffsetX = e.clientX - rect.left`（使用 clientX）
- mousemove（第 149 行）：`newX = e.screenX - dragOffsetX`（使用 screenX）

**Bug：** `screenX` 和 `clientX` 的原点不同。`screenX` 以屏幕左上角为原点，`clientX` 以视口左上角为原点。在非 0,0 位置的窗口上拖拽时，计算结果会多出一个 `window.screenX` 的固定偏移量，导致拖拽位置不准确。

**修复建议：** 统一使用 `screenX`（第 138 行改为 `e.screenX - rect.left`）。

---

## Major (重要)

### MAJ-1: video.py 路由前缀双重不一致

`video.py` 第 17 行：`router = APIRouter(prefix="/api/video")` — 已经硬编码了 `/api` 前缀。

`main.py` 第 104 行：`app.include_router(video_router)` — 不加 prefix。
其他所有 router 都是 `app.include_router(xxx_router, prefix="/api")`。

虽然当前工作正常，但：
- `main.py` 中 video_router 的注册方式与其他 router 不一致，容易在后续修改中出错
- 如果有人改为 `app.include_router(video_router, prefix="/api")`，所有 video 路径会变成 `/api/api/video/...`

**影响：** 代码可维护性风险。

### MAJ-2: transcriptions.py 中 download_bilibili_audio 阻塞事件循环

`video.py` 第 352 行在 async 端点中直接调用同步函数：
```python
result = download_bilibili_audio(url, output_dir=output_dir, quality=quality)
```

这会在 FastAPI 的事件循环中执行阻塞的音频下载操作，导致整个服务器响应延迟。

**修复建议：** 使用 `asyncio.to_thread()` 或在 `run_in_executor` 中执行。

### MAJ-3: transcriptions.py MIME 类型校验不可靠

`transcription.py` 第 88 行：
```python
if file.content_type not in ALLOWED_AUDIO_TYPES:
```

`file.content_type` 由客户端发送，可以被伪造，且在部分浏览器中可能为空。这既不是可靠的校验方式，而且更严重的是——它拒绝了一些常见的 MIME 类型（如 `audio/x-m4a` 已被列出，但 `audio/mp4` 可能在一些浏览器中作为视频类型发送）。

**修复建议：** 应同时检查文件扩展名作为备选验证，或使用 `python-magic` 检测实际文件类型。

### MAJ-4: readTextFile 在 Electron 中使用 `file://` 协议可能出错

`player.js` 第 928 行：
```js
const resp = await fetch(`file://${path}`);
```

Windows 路径如 `C:\Users\YOGA\file.srt` 拼接后变成 `file://C:\Users\YOGA\file.srt`，但正确的 `file://` URL 在 Windows 上应为 `file:///C:/Users/YOGA/file.srt`（缺少一个 `/` 且反斜杠未转义）。

**影响：** 在 Electron 生产模式下加载字幕文件可能失败。

### MAJ-5: 前端 `api.js getVocabulary()` 参数名与后端不匹配

前端 `storage.js` 第 545 行调用 `getVocabulary({ limit: 500, sort: '-saved_at' })`。
但后端 `vocabulary.py` 接受 `page`, `page_size`, `mastered`, `search` 参数，没有 `limit` 或 `sort` 参数。

即使路径匹配了（CRIT-1），参数也会被忽略。

### MAJ-6: video.py HEADERS 字典硬编码且包含敏感浏览器指纹

`video.py` 第 19-35 行包含一个巨大的硬编码 HEADERS 字典，包含 `Sec-Ch-Ua`, `Sec-Ch-Ua-Platform` 等浏览器指纹。这些头部在 production 中很快会过时，且硬编码会让爬虫行为容易被检测。

**修复建议：** 使用动态 UA 轮换或简化的必要头部。

### MAJ-7: Cookie 明文存储在 JSON 文件中

`services/cookie_manager.py` 将 Bilibili Cookie（包含 SESSDATA 等敏感信息）以明文形式存储在 `config/downloader.json` 中。没有任何加密或权限保护。

**影响：** 如果用户的 Bilibili Cookie 被泄露，攻击者可获取用户的 Bilibili 账户访问权限。

### MAJ-8: video.py 中 extract_bilibili_video 的编码 fallback 逻辑不完整

第 59-61 行：
```python
except UnicodeDecodeError:
    content = info_response.content.decode('gbk')
    info_data = json.loads(content)
```

如果 gbk 解码也失败（或内容不是 JSON 格式），异常会直接冒泡。且对非 B站 URL 调用 `extract_bilibili_video` 时，B站 API 请求会发出但可能返回奇怪结果。

---

## Minor (次要)

### MIN-1: player.js 中 `formatTime` 函数被重复定义（死代码）

- `subtitle.js` 导出一个完整的 `formatTime`（HH:MM:SS.mmm 格式）
- `player.js` 第 36-40 行定义了一个局部 `formatTime`（MM:SS 格式）
- 但第 14 行 `import { formatTime } from './subtitle.js'` 使局部函数被全局导入覆盖

**影响：** `player.js` 中的局部 `formatTime` 为完全无法到达的死代码。

### MIN-2: video.py `_download_bilibili_sync` 中 yt-dlp 是延迟导入

第 193 行 `import yt-dlp` 在函数内部，但第 16 行外部 `from downloaders.bilibili_downloader import BilibiliDownloader, download_bilibili_audio, get_bilibili_subtitles` 也已导入 `BilibiliDownloader`，它内部也可能依赖 `yt-dlp`。如果 `yt-dlp` 未安装，两个地方都会报错。

### MIN-3: migrations.py 中 `migrations/` 目录在 `MIGRATIONS_DIR` 定义但实际未使用（硬编码 vs config）

`database/migrations.py` 第 16 行：
```python
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
```

但 `main.py` 中未调用 `ensure_initial_migration()` 来创建初始迁移文件（第 194 行定义了此函数但未被调用）。迁移系统存在但未集成到启动流程中。

### MIN-4: database/__init__.py 中 `_set_sqlite_pragma` 在每个连接上重复设置 WAL 模式

第 52-56 行：
```python
@event.listens_for(_engine, "connect")
def _set_sqlite_pragma(dbapi_connection, connection_record):
    cursor.execute("PRAGMA journal_mode=WAL;")
```

WAL 模式只需设置一次（存储在 SQLite 数据库文件中），每次连接都设置是多余的，且有轻微性能开销。

### MIN-5: card.js 中 `fetchWordInfo` 重复调用后端搜索 API

`card.js` 第 229 行和 `checkFavoriteStatus` 第 333 行都调用了相同的 `/api/vocab?search=...` 端点。如果两个请求都成功，相当于对同一个单词做了两次相同的 API 调用。

**修复建议：** 合并这两个请求，在 `fetchWordInfo` 中同时获取单词数据和收藏状态。

### MIN-6: storage.js `fullSync` 中的 `sort: '-saved_at'` 参数后端不支持

`storage.js` 第 788 行：`getVocabulary({ limit: 500, sort: '-saved_at' })`。后端 `vocabulary.py` 不接受 `limit` 或 `sort` 参数（仅 `page`、`page_size`、`mastered`、`search`）。

### MIN-7: wordFreqPanel 中 `showToast` 函数与 player.js 的 `showToast` 重复

两个文件各自定义了独立的 `showToast` 函数，实现略有不同（player.js 使用 `.toast-container`，wordFreqPanel.js 也使用 `.toast-container`，但实现中一个用 ID 一个用 class）。

同一个 UI 功能在两个模块间重复实现，可能导致 toast 显示冲突。

### MIN-8: clickable word hover 事件绑定在每次 re-render 时没有清理旧绑定

`SubtitleDisplay.js` 第 104 行每次 `renderSubtitles()` 都调用 `bindHoverToWord(wordEl)`，但旧的 `wordEl._fcCleanup` 从未被调用（因为 DOM 元素被 `area.innerHTML = ''` 移除了，但事件监听器已经绑定到了将被移除的元素上，GC 会处理）。实际上 GC 会处理被移除 DOM 元素上的监听器，所以这不是真正的内存泄漏，但 `unbindHoverFromWord` 从未被使用。

### MIN-9: Word Frequency 数据刷新间隔为 30 秒，可能导致退出时数据丢失

`word_frequency.py` 第 23 行 `DEFAULT_FLUSH_INTERVAL = 30` 秒。如果应用在两次刷新之间异常退出，30 秒内的词频数据全部丢失。

**修复建议：** 缩短刷新间隔，或在应用关闭前触发最后一次 `force_flush()`。

### MIN-10: 悬浮窗（overlay）的 CSP 限制了字幕卡片 API 调用

`overlay.html` 的 CSP（第 6-9 行）包含 `connect-src 'self' http://localhost:* https://api.dictionaryapi.dev`。在生产模式下从 `file://` 加载时，对 `http://localhost:8000` 的 API 调用是允许的（`http://localhost:*` 覆盖）。但如果未来后端迁移到非 localhost 地址，需要更新 CSP。

### MIN-11: `transcription.py` 中 `_engine` 全局变量线程不安全

第 37 行的 `_engine: WhisperEngine | None = None` 和 `_get_engine()` 函数存在线程安全问题。虽然 `_get_engine()` 在读取时没有锁保护，但 Whisper 引擎的初始化可能很耗时，两个并发请求可能创建两个引擎实例。

### MIN-12: video.py 中 `output_dir = "data/audio"` 使用相对路径

第 349 行：`output_dir = "data/audio"` — 相对路径基于当前工作目录，不是基于项目根目录。如果从不同目录启动后端，文件会保存到错误位置。

---

## Code Smell & 建议

1. **player.js（1282 行）** — 该文件体积过大，混合了视频加载、音频加载、字幕解析、单词卡片、Toast、拖拽等多个职责。建议拆分为多个模块。

2. **CRUD 函数中重复的 session_scope 模式** — 每个 CRUD 函数都重复了 `with session_scope() as session:` 模板，建议提取一个基类或装饰器。

3. **video.py（701 行）** — 内联了完整的 HTML 测试页面（`/test` 端点返回 ~200 行 HTML+JS）。生产代码中不应包含测试页面。

4. **硬编码 Magic Numbers** — `player.js` 中轮询超时 `maxAttempts = 180`（6分钟），轮询间隔 `2000ms`，`wordFreqPanel` 刷新间隔 `5000ms`，应有配置常量。

5. **storage.js 中大量 `catch { /* ignore */ }`** — 多个 IndexedDB 操作使用空 catch，掩盖了潜在的数据库错误。

6. **`restorePlayerState()` 使用 `setTimeout(tryRestoreTime, 100)`** — 硬编码的延迟非常脆弱，应使用 `MutationObserver` 或 `requestAnimationFrame` 检测 DOM 就绪。

7. **`window.__SETTINGS` 全局变量** — 设置通过全局 window 属性在页面间传递，而不是通过模块导入，违反了 ES module 的设计原则。

---

## 总结

| 级别 | 数量 | 关键问题 |
|------|------|----------|
| Critical | 4 | 前后端 API 路径不匹配导致全后端离线同步机制失效；词频数据竞争丢失；拖拽位置偏移 |
| Major | 8 | 路由前缀不一致；阻塞事件循环；MIME 校验不可靠；file:// 协议使用不当；Cookie 明文存储 |
| Minor | 12 | 死代码；重复定义；路径硬编码；配置未集成；线程安全；CSP 限制等 |
| Code Smell | 7 | 超大文件；重复模式；内联测试页；魔法数字；静默 catch |

**最紧急修复项：**
1. 统一 `/api/vocabulary` → `/api/vocab`（或反向修改后端）
2. 修复 `toggleFavorite()` 调用的不存在的后端端点
3. 修复 `word_frequency.py` 的缓存重置算法
4. 修复 overlay 拖拽的 screenX/clientX 混算
