# 架构评估与技术选型报告

> 角色: 🏗️ Architect
> 日期: 2026-05-18
> 评估范围: 三项新需求对现有架构的影响

---

## 目录

1. [需求 1: 下载选项持久化 + 视频状态恢复](#1-需求-1-下载选项持久化--视频状态恢复)
2. [需求 2: 点读单词跳转播放](#2-需求-2-点读单词跳转播放)
3. [需求 3: 实时字幕 + 词频统计 + 单词来源](#3-需求-3-实时字幕--词频统计--单词来源)
4. [技术选型决策记录](#4-技术选型决策记录)
5. [数据流图](#5-数据流图)
6. [潜在风险评估](#6-潜在风险评估)
7. [建议开发顺序](#7-建议开发顺序)

---

## 1. 需求 1: 下载选项持久化 + 视频状态恢复

### 当前架构支持情况

| 维度 | 状态 | 说明 |
|------|------|------|
| UI 状态持久化 | ✅ 已支持 | `store.js` 的 `forget/recall` 按 route key 隔离，localStorage 1s debounce 写入 |
| Blob 缓存 | ✅ 已支持 | `cacheBlob/getCachedBlob/clearBlob` 模块级存活，跨路由切换可用 |
| 视频播放位置恢复 | ⚠️ 部分支持 | `_savePlayerState()` 保存 mediaFile/subs/mode，但**未保存 currentTime** |
| 下载开关状态 | ⚠️ 部分支持 | `app.js` 中 ROUTE_SELECTORS.WATCH 包含 `'downloadToggle': '#toggle-download'`，但 `forget/recall` 只在路由切换时调用，**页面刷新后无法恢复** |
| 视频播放列表/历史 | ❌ 未支持 | 无历史记录机制 |

### 需要修改的内容

#### 前端修改

**1. store.js — 增加 currentTime 持久化**

```javascript
// 在 _savePlayerState() 中补充
function _savePlayerState() {
  storeSet(STORE_KEY, {
    mediaFile: state.mediaFile,
    subs: state.subs,
    mode: state.mode,
    currentTime: state.media ? state.media.currentTime : 0,  // ← 新增
  });
}

// restorePlayerState() 中恢复播放位置
export function restorePlayerState() {
  const saved = storeGet(STORE_KEY);
  // ... 现有恢复逻辑 ...
  if (saved.currentTime && state.media) {
    state.media.currentTime = saved.currentTime;
  }
}
```

**2. app.js — 页面加载时自动恢复下载开关**

当前 `ROUTE_SELECTORS` 已包含 `downloadToggle`，但 `forget/recall` 只在路由切换时触发。需确保页面**初次加载**时也调用 `recall('watch', ...)`（当前 watch 路由 handler 已调用 `restoreState`，确认工作正常）。

**3. 新增功能：视频下载目录持久化**

`settings.js` 已有 `downloadDir` 存储，但需确认持久化位置：
- 推荐方案：`window.__SETTINGS` 从 localStorage 读取，`settings.js` 中的 `getSettings/saveSettings` 已使用 localStorage
- 当前 `app.js` settings modal 已可设置下载目录，无需额外改动

### 改动量评估

| 文件 | 改动 | 行数 |
|------|------|------|
| `player.js` | `_savePlayerState()` 加 currentTime，`restorePlayerState()` 加恢复逻辑 | ~5 行 |
| `store.js` | 无需改动 | 0 行 |
| `app.js` | 确认恢复逻辑已正确 | ~0 行 |

---

## 2. 需求 2: 点读单词跳转播放

### 当前架构支持情况

| 维度 | 状态 | 说明 |
|------|------|------|
| 字幕单词可点击 | ✅ 已支持 | `SubtitleDisplay.js` 的 `makeWordsClickable()` 将每个单词包成 `.clickable-word` span，`click` 事件调用 `triggerWordCard` |
| 单词卡片 | ✅ 已支持 | `card.js` 浮动词卡（FloatingCard），显示释义、发音、收藏 |
| 字幕数据有单词级时间戳 | ✅ 后端支持 | `whisper_engine.py` 的 `word_timestamps=True` 输出 `SegmentWord(word, start, end, probability)` |
| 点击单词跳转播放 | ❌ 未实现 | `triggerWordCard` 只传 sub.start/sub.end（片段级），不具备单词粒度时间戳 |
| 字幕数据结构含 word-level 信息 | ❌ 未实现 | `player.js` 的 `subs[]` 结构只有 `{id, start, end, text}`，无 `words[]` 字段 |

### 需要修改的内容

#### 数据流改造

**核心思路**: 将字幕数据从目前仅含片段级信息，升级为包含单词级时间戳的复合结构。

**1. 后端返回格式升级** (`api/transcription.py`)

当前 `transcribe()` 返回已包含 `words: [{word, start, end, probability}]`。需要确保字幕 API 返回值中包含单词数组：

```json
{
  "segments": [{"id": 0, "start": 0.5, "end": 2.3, "text": "Hello world", "words": [...]}],
  "words": [{"word": "Hello", "start": 0.5, "end": 0.9, "probability": 0.98}, ...]
}
```

当前 `whisper_engine.py` 的 `transcribe()` 和 `transcribe_segment()` 均已输出 `words`，**后端无需改动**。

**2. 前端字幕数据结构** (`player.js`)

```javascript
// 当前结构
state.subs = [{id, start, end, text}]

// 升级后结构
state.subs = [{
  id, start, end, text,
  words: [{word, start, end, probability}]  // ← 新增
}]
```

**3. SubtitleDisplay.js — 为每个单词 span 附加时间戳**

```javascript
function makeWordsClickable(text, subWords = []) {
  const parts = text.split(/(\b[\w']+\b)/g);
  return parts.map((part) => {
    const word = part.replace(/[^\w']/g, '');
    if (word && word.length >= 2) {
      const wordInfo = subWords.find(w => w.word.toLowerCase() === word.toLowerCase());
      const start = wordInfo ? wordInfo.start : '';
      const end = wordInfo ? wordInfo.end : '';
      return `<span class="clickable-word" data-word="${escapeHtml(word.toLowerCase())}"
               data-start="${start}" data-end="${end}">${escapeHtml(part)}</span>`;
    }
    return escapeHtml(part);
  }).join('');
}
```

**4. triggerWordCard → 点击播放跳转**

```javascript
function triggerWordCard(word, sub) {
  // 从点击事件中获取单词级时间戳
  const wordEl = event.target.closest('.clickable-word');
  const wordStart = parseFloat(wordEl?.dataset?.start);
  
  if (mediaElement && !isNaN(wordStart)) {
    mediaElement.currentTime = wordStart;  // 跳转
    mediaElement.play();                   // 播放
  }
  
  // 仍然弹出词卡
  import('./player.js').then(mod => {
    mod.showWordCard(word, sub.text, wordStart || sub.start, wordEl?.dataset?.end || sub.end);
  });
}
```

#### Whisper 模型是否需要切换到更大尺寸？

- `word_timestamps=True` 在 faster-whisper 的所有模型尺寸都支持
- Tiny/base 模型的单词边界可能不够精确
- **建议**: 保持 base 模型，先验证精度，如不满足再升级到 small

#### 字幕文件导入时的单词时间戳

对于 SRT/VTT 文件，没有 word-level 时间戳。**降级策略**: 单词无法跳转到精确位置，使用 `sub.start` 作为近似值，并在 UI 上提示"文件字幕不支持精确跳转"。

### 改动量评估

| 文件 | 改动 | 行数 |
|------|------|------|
| `SubtitleDisplay.js` | `makeWordsClickable` 接受 word 数组参数；`triggerWordCard` 改为事件处理 + 跳转逻辑 | ~30 行 |
| `player.js` | `convertToSubtitles()` 保留 words 数组；渲染时传入 words | ~10 行 |
| `card.js` | 可能不需要改动（已有 start/end 参数） | ~0 行 |

---

## 3. 需求 3: 实时字幕 + 词频统计 + 单词来源

### 当前架构支持情况

| 维度 | 状态 | 说明 |
|------|------|------|
| WASAPI Loopback 系统音频采集 | ✅ 已支持 | `audio/capture.py` 使用 `pyaudiowpatch` 实现 Loopback |
| 实时转录 | ✅ 已支持 | WebSocket `/api/ws/subtitle/realtime` 整合音频源管理器 + AudioBuffer + WhisperEngine |
| 双模式切换 | ✅ 已支持 | 文件播放字幕 (`startSync` + SRT) vs 实时字幕 (WebSocket)，`player.js` 的 `switchMode` |
| 实时字幕 WebSocket 已有 word-level | ✅ 已支持 | websocket.py 的 `subtitle` 消息包含 `words: [{word, start, end, probability}]` |
| 词频统计（会话） | ❌ 未实现 | 无内存中的会话级词频计数器 |
| 词频统计（历史累计） | ❌ 未实现 | 无持久化词频表 |
| 单词来源追踪 | ❌ 未实现 | 无 `word_occurrences` 表记录每个单词出现的文件/URL/时间点 |
| 词频展示 UI | ❌ 未实现 | 无词频面板或热力图 |

### 需要新增的模块/组件

#### 后端

##### 1. 新数据表: `word_frequency`

```sql
CREATE TABLE word_frequency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL UNIQUE,         -- 单词原文（小写）
    session_count INTEGER DEFAULT 0,   -- 当前会话出现次数
    total_count INTEGER DEFAULT 0,     -- 历史累计出现次数
    first_seen_at DATETIME,            -- 首次出现时间
    last_seen_at DATETIME,             -- 最近出现时间
    updated_at DATETIME
);
CREATE INDEX idx_wf_word ON word_frequency(word);
```

##### 2. 新数据表: `word_occurrences` (来源追踪)

```sql
CREATE TABLE word_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,                -- 单词原文
    source_type TEXT NOT NULL,         -- 'file' | 'url' | 'system_audio'
    source_name TEXT NOT NULL,         -- 文件名或 URL
    subtitle_id INTEGER,               -- 关联字幕（可选）
    timestamp FLOAT,                   -- 在音频中的时间点（秒）
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (subtitle_id) REFERENCES subtitles(id) ON DELETE SET NULL
);
CREATE INDEX idx_wo_word ON word_occurrences(word);
CREATE INDEX idx_wo_source ON word_occurrences(source_type, source_name);
```

##### 3. 新 API 端点

| 方法 | 路径 | 说明 | 优先级 |
|------|------|------|--------|
| GET | `/api/words/frequency` | 词频列表（分页、排序） | P1 |
| GET | `/api/words/frequency/top` | 高频词 Top-N | P1 |
| GET | `/api/words/{word}/occurrences` | 某单词的所有出现记录 | P2 |
| POST | `/api/words/{word}/reset-session` | 重置会话计数 | P2 |
| GET | `/api/words/session/summary` | 当前会话词频摘要 | P1 |
| POST | `/api/words/batch` | 批量记录单词出现（供 WebSocket 转录回调使用） | P1 |

##### 4. 新模块: `services/word_frequency.py`

```python
"""单词频率统计服务 — 会话级 + 持久化"""
class WordFrequencyService:
    def record_words(self, words: list[dict], source_info: dict) -> None:
        """转录回调：记录一组单词的出现"""
        # words: [{word, start, end, probability}]
        # source_info: {type, name}
        # 1. 更新 word_frequency 表（session_count+1, total_count+1）
        # 2. 插入 word_occurrences 记录
        pass

    def get_session_summary(self) -> dict:
        """当前会话的词频摘要"""
        pass

    def reset_session(self) -> None:
        """开始新会话时重置 session_count"""
        pass
```

##### 5. Websocket 集成 — 实时转录回调注入

在 `websocket.py` 的 `_transcription_loop()` 中，每次转录完成后调用 `WordFrequencyService.record_words()`：

```python
async def _transcription_loop():
    # ... 现有转录逻辑 ...
    if result.text.strip():
        # 推送字幕结果（现有）
        await ws.send_json({...})
        # 新增：记录词频
        source_info = {"type": "system_audio" if using_source_manager else "client_stream",
                       "name": current_source_name}
        word_freq_service.record_words(
            [w.to_dict() for w in result.words], source_info)
        # 推送词频更新
        await ws.send_json({
            "type": "word_frequency",
            "data": word_freq_service.get_session_summary()
        })
```

#### 前端

##### 1. 新模块: `wordFreqPanel.js`

- 词频统计面板组件
- 可放置在 `/watch` 和 `/point` 页面的侧边或底部
- 显示当前会话高频词列表（按词频降序）
- 支持点击单词跳转到该单词的首次出现位置
- 两种视图：紧凑型（仅显示 Top-20 单词+次数）和完整型（带来源信息）

##### 2. SubtitleDisplay 升级

- 已出现的高频词在字幕中用特殊高亮（如不同颜色底色）

##### 3. WebSocket 消息扩展

```javascript
// 前端 WebSocket 消息处理升级
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'subtitle':
      displaySubtitle(msg.data);
      break;
    case 'word_frequency':
      updateWordFreqPanel(msg.data);  // ← 新增
      break;
  }
};
```

### 词频存储技术选型

| 方案 | 优点 | 缺点 | 推荐度 |
|------|------|------|--------|
| **SQLite (word_frequency 表)** | 与现有数据库统一，事务支持，持久化 | 高频更新可能造成写竞争 | ⭐⭐⭐ 推荐 |
| 内存 dict + 定时持久化 | 性能极佳，无锁 | 进程重启丢失，需额外持久化逻辑 | ⭐⭐ 备选 |
| Redis | 高性能，原生计数器 | 增加基础设施复杂度，桌面应用不必要 | ❌ 不推荐 |
| IndexedDB (前端) | 离线可用 | 与后端数据割裂，多端无法共享 | ❌ 不推荐 |

**选型决策**: SQLite + WordFrequencyService 内存级缓存

```python
class WordFrequencyService:
    def __init__(self):
        self._session_cache: dict[str, int] = {}  # 内存级会话计数
        self._dirty = False
        self._last_flush = time.time()
    
    def record_words(self, words, source_info):
        # 1. 更新内存缓存（无锁，性能极佳）
        for w in words:
            word = w['word'].lower()
            self._session_cache[word] = self._session_cache.get(word, 0) + 1
        
        # 2. 异步批量写入 DB（每 5s 或 100 条刷新一次）
        self._dirty = True
        if time.time() - self._last_flush > 5 or len(words) > 100:
            self._flush_to_db(words, source_info)
    
    def _flush_to_db(self, words, source_info):
        """批量写入 SQLite—使用 INSERT OR UPDATE"""
        with session_scope() as session:
            for w in words:
                word = w['word'].lower()
                record = session.query(WordFrequency).filter_by(word=word).first()
                if record:
                    record.total_count += 1
                    record.last_seen_at = datetime.now(timezone.utc)
                else:
                    session.add(WordFrequency(word=word, session_count=1, total_count=1, ...))
                # 插入来源记录
                session.add(WordOccurrence(word=word, ...))
```

### 改动量评估

| 模块 | 改动类型 | 预计行数 |
|------|----------|----------|
| `database/models.py` | 新增 2 个模型: WordFrequency, WordOccurrence | ~50 行 |
| `database/crud.py` | 新增 CRUD: batch_record_words, get_frequency, get_occurrences | ~100 行 |
| `database/migrations.py` | 新增迁移: 创建 word_frequency + word_occurrences 表 | ~40 行 |
| `services/word_frequency.py` | 全新模块 | ~150 行 |
| `api/words.py` | 全新 API Router (6 个端点) | ~120 行 |
| `websocket.py` | 集成词频回调 | ~20 行 |
| `main.py` | 注册新 router | ~2 行 |
| `wordFreqPanel.js` | 全新前端模块 | ~200 行 |
| `SubtitleDisplay.js` | 高频词高亮 | ~30 行 |
| WebSocket 前端 | 处理 word_frequency 消息 | ~15 行 |

---

## 4. 技术选型决策记录

### ADR-005: 词频统计用 SQLite + 内存缓存，而非 Redis

- **问题**: 实时转录每秒都可能产生新单词，需要高频词频更新
- **决策**: SQLite 持久化 + Python dict 内存缓存，每 5s 批量刷入
- **理由**: 
  - 桌面应用单用户，无需分布式
  - 内存 dict 写入纳秒级，不阻塞转录
  - 5s 批量写入避免 WAL 锁竞争
- **风险**: 进程崩溃丢失最多 5s 的词频数据（可接受，会话计数可从总计数重算）
- **折中**: session_count 在恢复时从 total_count 中减去历史均值，或标记为"部分丢失"

### ADR-006: 单词来源用单独表而非 JSON 字段

- **问题**: 一个单词可能在多个文件/多个时间点出现，需要追踪
- **决策**: `word_occurrences` 独立表，每出现一次一行
- **理由**:
  - 支持查询"某个单词在所有文件中出现了多少次"
  - 支持按来源过滤"只显示 Bilibili 视频中出现的单词"
  - 标准化查询效率远高于 JSON 解析
- **风险**: 长期使用后行数可能膨胀（预计每天几百到几千行，可接受）

### ADR-007: 单词跳转使用 `mediaElement.currentTime = word.start`

- **问题**: HTML5 `<video>` 和 `<audio>` 的 `currentTime` 设置精度
- **决策**: 直接使用 `currentTime = word.start`
- **理由**: 
  - HTMLMediaElement.currentTime 精度约 0.01s，满足单词级跳转需求
  - 不需要额外 seek 到 keyframe 的逻辑（音频更是无此问题）
- **风险**: 对某些编码的视频，seek 可能跳到最近的 keyframe，误差 ~0.5s
- **缓解**: 提示用户使用支持精确 seek 的编码（如 H.264 低 GOP size）

### ADR-008: 前端子单词时间戳通过 dataset 属性传递

- **问题**: 点击单词时需要获取单词的精确时间戳用于跳转
- **决策**: 渲染时 `data-start` / `data-end` 属性直接附加到 `.clickable-word` span 上
- **理由**: 
  - 无需在点击时通过 words 数组查找（O(n)→O(1)）
  - 与现有 `data-word` 属性风格一致
  - DOM 操作最小化

---

## 5. 数据流图

### 整体架构更新后

```
┌──────────────────────────────────────────────────────────────────┐
│                       Electron 前端                               │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  /watch 路由                                              │    │
│  │                                                          │    │
│  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  │    │
│  │  │ 媒体播放器    │  │ SubtitleDisplay│  │ 词频面板     │  │    │
│  │  │ (player.js)  │  │ (SubtitleDisp) │  │(wordFreqPanel)│  │    │
│  │  │              │  │ .clickable-word│  │              │  │    │
│  │  │ currentTime= │◀─│ 带 data-start │  │ Top-N 词频   │  │    │
│  │  │ word.start   │  │ data-end      │  │ 来源信息     │  │    │
│  │  └──────┬───────┘  └───────┬───────┘  └──────┬───────┘  │    │
│  │         │                 │                  │           │    │
│  │         └─────────────────┼──────────────────┘           │    │
│  │                           │ store.js                      │    │
│  │                    localStorage + blob cache               │    │
│  └───────────────────────────┼──────────────────────────────┘    │
│                              │                                    │
│                   ┌──────────┴──────────┐                        │
│                   │     api.js          │                        │
│                   │   REST + WebSocket  │                        │
│                   └──────────┬──────────┘                        │
└──────────────────────────────┼──────────────────────────────────┘
                               │
          HTTP REST ┌──────────┴──────────┐ WebSocket
                    │   FastAPI Backend   │
                    │                     │
                    │  ┌───────────────┐  │
                    │  │ WS /subtitle  │──┼───→ 转录回调
                    │  │ /realtime     │  │         │
                    │  └───────┬───────┘  │         │
                    │          │          │         ▼
                    │  ┌───────┴───────┐  │  ┌──────────────┐
                    │  │ AudioBuffer   │  │  │ WordFreqSvc  │
                    │  │ + Whisper     │  │  │ (内存缓存)   │
                    │  └───────┬───────┘  │  └──────┬───────┘
                    │          │          │         │
                    │  ┌───────┴───────┐  │         │ 5s flush
                    │  │ source_manager│  │  ┌──────┴──────┐
                    │  │ (WASAPI Loop) │  │  │ SQLite DB   │
                    │  └───────────────┘  │  │ linguacapt. │
                    │                     │  │ word_freq   │
                    │  ┌───────────────┐  │  │ word_occur  │
                    │  │ /api/vocab    │  │  │ vocab       │
                    │  │ /api/words/** │  │  │ subtitles   │
                    │  └───────────────┘  │  └─────────────┘
                    └─────────────────────┘
```

### 需求 2: 点读点击数据流

```
用户点击字幕单词
       │
       ▼
.clickable-word span (data-word, data-start, data-end)
       │
       ▼
SubtitleDisplay click handler
       │
       ├──→ mediaElement.currentTime = word.start
       │         │
       │         ▼
       │    mediaElement.play()
       │
       └──→ import('./player.js').showWordCard(word, context, start, end)
                     │
                     ▼
                card.js 展示释义卡片
```

### 需求 3: 实时字幕词频数据流

```
WASAPI Loopback 采集
       │
       ▼
source_manager (PCM chunks)
       │
       ▼
AudioBuffer (滑窗缓冲)
       │
       ▼
WhisperEngine.transcribe_segment(audio_bytes)
       │
       ▼
TranscribeResult {text, words: [{word, start, end, prob}]}
       │
       ├──→ WebSocket推送: {"type": "subtitle", "data": {text, words}}
       │         │
       │         ▼
       │    前端 SubtitleDisplay 渲染（带可点击单词）
       │
       └──→ WordFrequencyService.record_words(words, source_info)
                 │
                 ├──→ 内存 session_cache 累加
                 │
                 └──→ 每5s/100条 → SQLite批量写入
                            │
                            ├── word_frequency 表
                            └── word_occurrences 表
                 
后续 WebSocket 推送: {"type": "word_frequency", "data": {...}}
       │
       ▼
前端 wordFreqPanel.js 更新 UI
```

---

## 6. 潜在风险评估

| 风险 | 级别 | 说明 | 缓解措施 |
|------|------|------|----------|
| **Whisper word timestamps 不精确** | 🟡 中 | tiny/base 模型的单词边界可能偏移 0.1-0.3s，跳转后听不到目标单词 | 1. 跳转前置 0.2s 作为 offset；2. 增加"微调"按钮（±0.5s） |
| **SQLite 写竞争** | 🟡 中 | 实时转录约 3-5s 一次，词频写入可能和 vocab CRUD 竞争 | 使用 WAL 模式（已有）；词频写入合并批量；StaticPool 连接池 |
| **word_occurrences 表膨胀** | 🟢 低 | 假设每分钟 100 个单词，每天 ~144K 行，一年 ~52M 行 | 1. 添加数据保留策略（默认 30 天）；2. 按月份分表；3. 首次实现加索引即可 |
| **WebSocket 消息类型膨胀** | 🟢 低 | 新增 word_frequency 消息类型，需前端增加 switch-case | 保持消息类型枚举文档化，client 侧统一 dispatch |
| **Electron IPC 调用 currentTime** | 🟢 低 | 如果通过 overlay 悬浮窗控制，可能需要 IPC 通信 | 确保悬浮窗能获取 mediaElement 引用（直接 DOM 操作或在 overlay.js 中桥接） |
| **SRT/VTT 无单词时间戳** | 🟢 低 | 导入的字幕文件无法精确跳转 | 优雅降级：跳转到片段开始处，UI 提示"近似跳转" |

---

## 7. 建议开发顺序

### Phase 3.1: 需求 1 + 需求 2 基础 (预估: 2-3 天)

```
优先级: P0 (高)

Day 1 — 需求 1: 状态持久化完善
  [ ] player.js: _savePlayerState 增加 currentTime
  [ ] player.js: restorePlayerState 恢复 currentTime
  [ ] 测试: 路由切换后播放位置保留
  [ ] 测试: 下载开关状态跨页面恢复

Day 2-3 — 需求 2: 单词点击跳转
  [ ] SubtitleDisplay.js: makeWordsClickable 新增 words 参数 + data-start/data-end
  [ ] SubtitleDisplay.js: triggerWordCard → 跳转 + 播放逻辑
  [ ] player.js: convertToSubtitles 保留 words 数组
  [ ] player.js: 渲染时传递 words 给 SubtitleDisplay
  [ ] 测试: 点击单词跳转到精确位置
  [ ] 测试: SRT 文件降级（无 words 时跳转到 sub.start）
```

### Phase 3.2: 数据库扩展 (预估: 1 天)

```
优先级: P1

  [ ] database/models.py: 新增 WordFrequency, WordOccurrence 模型
  [ ] database/migrations.py: 创建新表迁移
  [ ] database/crud.py: 批量写入词频 + 来源记录的 CRUD
  [ ] 测试: 数据库迁移正确执行
  [ ] 测试: 词频批量写入性能（单次 100 条 < 50ms）
```

### Phase 3.3: 后端词频服务 + API (预估: 2 天)

```
优先级: P1

  [ ] services/word_frequency.py: 内存缓存 + 批量刷新
  [ ] api/words.py: 6 个词频 API 端点
  [ ] main.py: 注册新 router
  [ ] websocket.py: 转录回调注入词频记录 + 推送
  [ ] 测试: WebSocket 实时词频推送
  [ ] 测试: 词频 API 分页/排序
  [ ] 测试: 会话重置功能
```

### Phase 3.4: 前端词频面板 (预估: 1.5 天)

```
优先级: P2

  [ ] wordFreqPanel.js: 词频展示组件
  [ ] 高频词在字幕中高亮（SubtitleDisplay.js 扩展）
  [ ] WebSocket 消息处理: word_frequency 类型
  [ ] 词频面板 UI 集成到 /watch 和 /point 路由
  [ ] 测试: 实时字幕 + 词频面板联合工作
  [ ] 测试: 高频词高亮显示
```

### Phase 3.5: 单词来源追踪 UI (预估: 1 天)

```
优先级: P2

  [ ] 单词详情卡片增加"来源"信息显示
  [ ] 点击来源跳转到对应文件/URL（如可行）
  [ ] word_occurrences API 联调
  [ ] 测试: 来源信息正确显示

总计预估: 7.5 ~ 9.5 天
```

---

## 附录: 文件改动清单汇总

| 文件 | 需求 1 | 需求 2 | 需求 3 | 状态 |
|------|--------|--------|--------|------|
| `electron/src/scripts/player.js` | ✅ 修改 | ✅ 修改 | — | 修改已有 |
| `electron/src/scripts/SubtitleDisplay.js` | — | ✅ 修改 | ✅ 修改 | 修改已有 |
| `electron/src/scripts/store.js` | — | — | — | 无需改动 |
| `electron/src/scripts/app.js` | — | — | — | 无需改动 |
| `electron/src/scripts/card.js` | — | — | ✅ 修改(来源) | 修改已有 |
| `electron/src/scripts/wordFreqPanel.js` | — | — | ✅ **新建** | 新建 |
| `python-backend/database/models.py` | — | — | ✅ 新增 2 模型 | 新增 |
| `python-backend/database/crud.py` | — | — | ✅ 新增 CRUD | 新增 |
| `python-backend/database/migrations.py` | — | — | ✅ 新增迁移 | 新增 |
| `python-backend/services/word_frequency.py` | — | — | ✅ **新建** | 新建 |
| `python-backend/api/words.py` | — | — | ✅ **新建** | 新建 |
| `python-backend/api/websocket.py` | — | — | ✅ 修改 | 修改已有 |
| `python-backend/main.py` | — | — | ✅ 修改 | 修改已有 |

---

**文档结束**
