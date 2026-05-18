# LinguaCaption 项目设计方案 (PM-Musk)

> 作者: PM-Musk · 日期: 2026-05-18
> 范围: 3 个新需求的产品设计 + 技术方案
> 原则: 第一性原理 · 极端简洁 · 消灭冗余流程

---

## 总览：三需求依赖关系

```
需求 1 (下载持久化) ───── 前置 → 需求 2 (点读跳转) ──── 共享字幕数据结构 → 需求 3 (实时字幕+统计)
    │                          │                               │
    └── P0 基础设施              └── P0 核心交互                   └── P1 高级特性
    (现有修整，2天)               (现有增强，3天)                    (新建系统，5天)
```

**执行顺序**: 需求 1 → 需求 2 → 需求 3（可重叠尾首）

---

## 需求 1：下载到本地选项持久化 (P0)

### 1.1 产品逻辑

**核心命题**: 用户开关 "下载到本地" checkbox 后，切换页面再回来，状态不丢失；之前加载的视频/音频断点续播。

**第一性原理分析**:
- 用户想要的不是「保持 checkbox 状态」，而是「切回来直接继续看」
- checkbox 只是表象，真正的价值是：媒体的 blob 缓存 + 播放位置恢复 + 字幕恢复
- 现有的 `store.js` 已经实现了 `forget/recall` 和 `cacheBlob`，但缺了两环：
  1. 播放进度（currentTime）未持久化
  2. 字幕同步在恢复后可能漂移

### 1.2 UI/交互方案

| 元素 | 变更 |
|------|------|
| `#toggle-download` checkbox | ✅ 已由 app.js 的 forget/recall 自动持久化 (ROUTE_SELECTORS) |
| 媒体 blob 缓存 | ✅ 已在 store.js 中 _blobCache + cacheBlob |
| **新增**: 断点续播 | 离开页面时保存 `media.currentTime`，回来时 `media.currentTime = savedTime` |
| **新增**: 恢复后自动播放 | blob URL 加载完成后调用 `media.play()` |

**交互变化（用户无感知）**:
- 用户从 #/watch → #/review → 回到 #/watch
- 视频仍然在，进度条停留在离开时的位置
- 字幕同步自动对齐
- 无需任何额外操作

### 1.3 技术方案

**修改文件**:

1. **`electron/src/scripts/player.js`** — `_savePlayerState()` 增加 currentTime 保存

```js
function _savePlayerState() {
  storeSet(STORE_KEY, {
    mediaFile: state.mediaFile,
    subs: state.subs,
    mode: state.mode,
    currentTime: state.media ? state.media.currentTime : 0,  // ← 新增
  });
}
```

2. **`electron/src/scripts/player.js`** — `restorePlayerState()` 增加断点续播

```js
export function restorePlayerState() {
  const saved = storeGet(STORE_KEY);
  if (!saved) return;
  // ... existing restore logic ...
  // 恢复播放进度
  if (saved.currentTime && state.media) {
    state.media.currentTime = saved.currentTime;
    state.media.play().catch(() => {}); // 自动播放可能被浏览器阻止，忽略
  }
}
```

3. **`electron/src/scripts/app.js`** — watch 路由离开时调用 `_savePlayerState`

```js
// 在 forget 之前，确保 player state 已保存
window.__savePlayerState?.();
```

### 1.4 验收标准

| # | 条件 | 预期结果 |
|---|------|---------|
| 1.1 | 选中 "下载到本地"，切到复习页再切回来 | checkbox 保持选中 |
| 1.2 | 取消选中，切页面再回来 | checkbox 保持未选中 |
| 1.3 | 播放视频到 01:23，切到复习页再切回来 | 视频停在 01:23，自动播放 |
| 1.4 | 播放音频到 00:45，切页面再回来 | 音频停在 00:45 |
| 1.5 | 加载新视频后切换回来 | 新视频正确显示，旧 blob 不残留 |
| 1.6 | Electron 窗口关闭再打开 | localStorage 持久化，状态恢复 |

### 1.5 工作量估计

- 前端修改: 2 个文件，~15 行代码变更
- 后端: 无改动
- 测试: 手动验证 6 个验收点
- **预估工时**: 4 小时（含测试）

---

## 需求 2：点读单词跳转播放 (P0)

### 2.1 产品逻辑

**核心命题**: 点击字幕中的任意单词 → 视频/音频跳转到该单词所在位置开始播放。

**第一性原理分析**:
- 用户点击单词的深层动机：「这个词听起来是什么样子的？在上下文里怎么读？」
- 不是查释义（那是 F3 词卡的事）
- 而是「跳转听音」—— 听到这个词在原视频中的真实发音
- 所以点击单词 = 查词卡 + 跳转播放 两件事一起做

**数据依赖**:
- 需要字幕数据包含 **单词级时间戳**（word.start, word.end）
- 当前 `subtitle.js` 解析的 SRT/VTT 只有句子级时间戳
- 已有 `convertToSubtitles()` 在 Whisper 转录结果中保留了单词级时间戳
- 但 SRT 解析只生成了 `{ id, start, end, text, words: [string] }`——words 是纯字符串数组，缺少时间戳

### 2.2 UI/交互方案

```
┌─────────────────────────────────────────────┐
│  字幕区域                                      │
│                                              │
│  ⏱ 00:12  Hello, <clickable>welcome</> to   │
│            the <clickable>real-time</>       │
│            subtitle demonstration.           │
│                                              │
│  用户点击 "welcome" →                          │
│    1. 视频/音频跳转到 00:12.500（welcome 位置） │
│    2. 开始自动播放                              │
│    3. 弹出单词释义卡                           │
└─────────────────────────────────────────────┘
```

**交互变化**:
- 目前点击单词只触发词卡 → **新增**：点击单词同时跳转播放
- 保留 hover 悬浮词卡不变（F4 功能不受影响）
- 跳转时，字幕高亮同步更新（已有 Sync Loop 自动处理）

### 2.3 技术方案

#### Step 1: 扩展字幕数据结构

**修改 `electron/src/scripts/subtitle.js`** — 支持 word-level 时间戳

```js
// 当前
{ id: 1, start: 12.0, end: 14.5, text: "Hello world", words: ["Hello", "world"] }

// 目标
{
  id: 1,
  start: 12.0,
  end: 14.5,
  text: "Hello world",
  words: [
    { word: "Hello", start: 12.0, end: 12.3 },
    { word: "world", start: 12.4, end: 12.8 }
  ]
}
```

- SRT/VTT 解析保持向后兼容：无 word-level 时间戳时，按句子时长平均分配
- Whisper 转录结果直接保留单词级时间戳

#### Step 2: 修改 SubtitleDisplay — 点击跳转

**修改 `electron/src/scripts/SubtitleDisplay.js`** — `triggerWordCard()` 之前先跳转

```js
// 在 renderSubtitles 的 click handler 中：
textSpan.addEventListener('click', (e) => {
  const wordEl = e.target.closest('.clickable-word');
  if (wordEl) {
    const word = wordEl.dataset.word;
    // ★ NEW: 查找单词时间戳并跳转
    const wordTimestamp = findWordTimestamp(sub, word);
    if (wordTimestamp && mediaElement) {
      mediaElement.currentTime = wordTimestamp.start;
      mediaElement.play().catch(() => {});
    }
    triggerWordCard(word, sub);
  }
});
```

**新增辅助函数**:
```js
function findWordTimestamp(sub, word) {
  // 优先使用 word-level 时间戳
  if (sub.words && Array.isArray(sub.words)) {
    const found = sub.words.find(w =>
      w.word && w.word.toLowerCase() === word.toLowerCase()
    );
    if (found && found.start != null) return found;
  }
  // 兜底：使用句子 start 时间
  return { start: sub.start, end: sub.end };
}
```

#### Step 3: 修改 WHISPER 转写结果适配

**修改 `electron/src/scripts/player.js`** — `convertToSubtitles()` 保留 words 字段

```js
function convertToSubtitles(segments, words) {
  // 当有 word-level 数据时，subs[i].words = [...wordObjects]
  // 每个 word object: { word: string, start: number, end: number, probability: number }
}
```

#### 后端: SRT parsing 增强（可选 P2）

当前后端的 `transcribe` 返回的 segments 已经是 word-level 的。如果需要直接从 SRT 文件解析 word-level 时间戳，可以增强 `whisper_engine.py` 在转录时输出带时间戳的 words。但**SRT 文件本身不包含单词级时间戳**，非要实现需要 Whisper 带 `word_timestamps=True` 参数。

### 2.4 验收标准

| # | 条件 | 预期结果 |
|---|------|---------|
| 2.1 | 点击字幕中的单词 | 视频/音频跳转到该单词位置并自动播放 |
| 2.2 | 点击 SRT 文件加载的字幕单词 | 跳转到句子 start 位置 |
| 2.3 | 点击 Whisper 转录的字幕单词 | 精确跳转到单词 start 位置（word-level 时间戳） |
| 2.4 | 跳转后字幕高亮同步更新 | 当前行高亮正确 |
| 2.5 | 跳转后词卡弹出 | 词卡正常显示释义 |
| 2.6 | 多次快速点击不同单词 | 每次都能正确跳转，不会卡顿 |
| 2.7 | 纯音频模式下点击单词 | 音频跳转正常 |

### 2.5 工作量估计

- 前端修改: 3 个文件（subtitle.js, SubtitleDisplay.js, player.js），~40 行
- 后端: 无改动
- **预估工时**: 6 小时

---

## 需求 3：实时字幕 + 词频统计 + 单词来源 (P1)

### 3.1 产品逻辑

**核心命题**:
1. 播放视频时（无论是否导入字幕），自动显示实时转录字幕
2. 每个单词旁边显示在当前视频中的出现频率
3. 每个单词可以追溯来源——来自哪个视频/音频的哪个时间点

**第一性原理分析**:
- 实时字幕 = 文件播放 + WASAPI Loopback 双模式，让用户「看任何视频都有字幕」
- 词频统计 = 帮用户判断「这个词是高频词还是冷僻词」——高频先学
- 单词来源 = 学习上下文链 —— 用户看到生词时想知道「我上次在哪见过这个词」

**三大模块关系**:
```
┌────────────────────────────────────────────────────┐
│  模块 3A: 实时字幕引擎                                │
│  ┌────────────────────┐  ┌──────────────────────┐  │
│  │ 文件播放模式         │  │ WASAPI Loopback 模式  │  │
│  │ (已有 media.src)    │  │ (系统音频采集)         │  │
│  └────────┬───────────┘  └──────────┬───────────┘  │
│           │                          │              │
│           └──────────┬───────────────┘              │
│                      ▼                              │
│              Whsiper 实时转录                        │
│              (已有 WebSocket)                       │
└──────────────────────┬─────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────┐
│  模块 3B: 词频统计引擎                                │
│  - 当前视频内频率（session）                            │
│  - 历史累计频率（所有视频）                               │
│  - 渲染到字幕行中                                     │
└──────────────────────┬─────────────────────────────┘
                       │
┌──────────────────────▼─────────────────────────────┐
│  模块 3C: 单词来源追溯                                 │
│  - 每个单词关联 { source_file, timestamp }            │
│  - 后端新增 word_occurrences 表                      │
│  - 词卡中显示来源链                                   │
└────────────────────────────────────────────────────┘
```

### 3.2 UI/交互方案

#### 实时字幕面板（overlay 悬浮窗改造）

```
┌──────────────────────────────────────────┐
│  [● 已连接] 🔊 ────────── [⏸] [⚙] [⤓]  │
│                                          │
│  Welcome to the  ⟶ 🔊  🔊  🔊            │
│  real-time subtitle                      │  ← 字幕 + 词频标注
│  demonstration.                          │
│                       ↑3 ↑2 ↑1           │
│                                          │
│  词频统计: welcome(3) real-time(2) ...   │  ← 底部词频条
│  来源: "lesson1.mp4" @ 01:23             │
└──────────────────────────────────────────┘
```

**交互变化**:
- 悬浮窗 subtitle-text 中，每个单词下方显示小字频率数（🔊 3 = 本视频中出现 3 次）
- 底部新增词频统计条（可折叠），显示 Top N 高频词
- 点击单词 → 词卡新增「来源」标签页，显示该词出现过的所有视频和时间点

#### 主界面字幕面板改造

```
┌─────────────────────────────────────────────┐
│ 字幕区域                                      │
│                                              │
│  ⏱ 00:12  Hello(3) welcome(2) to(15) the(8)│
│            real-time(2) subtitle(4) demo(1)  │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │ 📊 本视频词频 Top 10                    │   │
│  │ the: 8 | to: 6 | subtitle: 4 | ...    │   │
│  │ welcome: 2 | demo: 1                  │   │
│  └──────────────────────────────────────┘   │
│                                              │
│  [🗂 切换来源视图]                            │
└─────────────────────────────────────────────┘
```

**模式切换**:
- 默认：字幕 + 词频（单词旁小标）
- 可选：字幕 + 来源（单词可展开显示来源链）
- 快捷键: Ctrl+F 切换词频/来源显示模式

### 3.3 技术方案

#### 3.3.1 数据结构

**后端新增表 `word_occurrences`**:

```sql
CREATE TABLE word_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,                       -- 单词（小写）
    source_file TEXT NOT NULL,                -- 来源文件名
    source_url TEXT,                          -- 来源视频 URL（可为空）
    start_time REAL NOT NULL,                 -- 在文件中的出现时间点
    end_time REAL NOT NULL,                   -- 结束时间点
    subtitle_text TEXT,                       -- 所在字幕行完整文本
    session_id TEXT,                          -- 会话 ID（用于按会话分组）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wo_word ON word_occurrences(word);
CREATE INDEX idx_wo_source ON word_occurrences(source_file);
CREATE INDEX idx_wo_session ON word_occurrences(session_id);
```

**前端运行时数据结构**:

```js
// 词频统计（内存中）
const wordFrequency = {
  // session: 当前会话（当前播放的视频）
  session: new Map(),    // Map<word, { count, firstSeen, lastSeen, sourceFile, timestamps: [] }>
  // global: 历史累计（从后端加载）
  global: new Map(),     // Map<word, { totalCount, sources: [{file, startTime, count}] }>
};
```

#### 3.3.2 实时字幕双模式

**模式 A: 文件播放模式（P0）**
- 已有 `startRealtimeMode()` 和 WebSocket realtime 端点
- 在打开文件/URL 时，自动在**播放的同时**通过 WASAPI 或直接从音频源启动实时转录
- 或者：已有转录结果时走文件模式，没有转录结果时走实时模式
- **简化方案**: 文件播放时，如果已有字幕文件 → 使用文件字幕 + 补充词频统计；如果没有字幕 → 自动触发实时转录

**模式 B: WASAPI Loopback 模式（P1）**
- 已有 `audio/source_manager.py` 和 WASAPI capture
- 启动方式：用户点击「实时字幕」按钮 → 选择「系统音频采集」
- 后端采集系统音频 → Whisper 实时转录 → WebSocket 推送到前端
- 独立于文件播放，任何系统声音都能转录

**双模式整合**:

```js
// electron/src/scripts/player.js — 新增实时字幕控制器
class RealtimeSubtitleController {
  constructor() {
    this.ws = null;
    this.mode = 'file'; // 'file' | 'wasapi'
    this.wordFrequency = new Map();
  }

  async startFileMode(mediaBlob, filename) {
    // 通过后端实时转录文件音频流
    // 或直接使用已有的转录结果
  }

  async startWASAPIMode() {
    // 连接 WebSocket，切换 source_manager 到 system
    // 接收实时字幕流
  }

  onSubtitleReceived(data) {
    // 更新词频统计
    this.updateWordFrequency(data.words);
    // 记录单词来源
    this.recordWordSource(data.words, data.sourceFile, data.startTime);
    // 渲染字幕 + 词频标记
  }
}
```

#### 3.3.3 词频统计引擎

**实现位置**: 前端 `wordFrequency` 模块（新建 `electron/src/scripts/wordFrequency.js`）

```js
export class WordFrequencyTracker {
  constructor() {
    this.sessionCounts = new Map();  // 本视频统计
    this.totalCounts = new Map();    // 历史累计
  }

  /** 记录一批单词（从字幕行或实时转录中） */
  recordWords(words, sourceFile, timestamp) {
    for (const w of words) {
      const word = w.word.toLowerCase();
      // session 统计
      if (!this.sessionCounts.has(word)) {
        this.sessionCounts.set(word, { count: 0, sources: [] });
      }
      const entry = this.sessionCounts.get(word);
      entry.count++;
      entry.sources.push({ file: sourceFile, time: timestamp });
    }
  }

  /** 获取单词频率显示文本 */
  getFrequencyDisplay(word) {
    const count = this.sessionCounts.get(word.toLowerCase())?.count || 0;
    return count > 1 ? `🔊${count}` : '';
  }

  /** 获取 Top N 高频词 */
  getTopWords(n = 10) {
    return [...this.sessionCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n)
      .map(([word, data]) => ({ word, count: data.count }));
  }

  /** 获取单词来源链 */
  getWordSources(word) {
    return this.sessionCounts.get(word.toLowerCase())?.sources || [];
  }
}
```

#### 3.3.4 单词来源追溯

**后端 API 新增**:

| 方法 | 路径 | 描述 | 优先级 |
|------|------|------|--------|
| POST | `/api/word-occurrences/batch` | 批量记录单词出现 | P1 |
| GET | `/api/word-occurrences/{word}` | 查询单词出现历史 | P1 |
| GET | `/api/word-occurrences/session/{session_id}` | 查询会话内统计 | P1 |

**前端集成**:
- 播放/转录完成时，调用 `POST /api/word-occurrences/batch` 上传单词出现数据
- 词卡中新增「来源」tab，调用 `GET /api/word-occurrences/{word}` 拉取来源链
- 来源链展示: `[文件1 @ 01:23] [文件1 @ 05:47] [文件2 @ 12:05]`
- 用户点击来源链中的时间点 → 跳转到对应文件和时间位置播放

#### 3.3.5 字幕渲染改造

**修改 `electron/src/scripts/SubtitleDisplay.js`** — 添加词频标注

```js
function renderSubtitles() {
  // ... existing render logic ...
  subtitleData.forEach((sub, i) => {
    // ...
    const textSpan = document.createElement('span');
    textSpan.className = 'subtitle-text';
    textSpan.innerHTML = makeWordsClickable(sub.text, {
      showFrequency: true,      // ← 新增参数
      tracker: wordFrequency,    // ← 词频统计器实例
    });
    // ...
  });
}

// makeWordsClickable 改造
function makeWordsClickable(text, opts = {}) {
  const parts = text.split(/(\b[\w']+\b)/g);
  return parts.map((part) => {
    const word = part.replace(/[^\w']/g, '');
    if (word && word.length >= 2) {
      let extra = '';
      if (opts.showFrequency && opts.tracker) {
        const freq = opts.tracker.getFrequencyDisplay(word);
        if (freq) extra = `<sup class="word-freq">${freq}</sup>`;
      }
      return `<span class="clickable-word" data-word="${escapeHtml(word.toLowerCase())}">
        ${escapeHtml(part)}${extra}</span>`;
    }
    return escapeHtml(part);
  }).join('');
}
```

### 3.4 验收标准

| # | 条件 | 预期结果 |
|---|------|---------|
| 3.1 | 播放有转录结果的视频 | 字幕正确显示，单词旁有频率标注 |
| 3.2 | 播放无字幕视频，开启实时字幕 | 实时转录字幕显示，词频实时更新 |
| 3.3 | 打开 WASAPI 系统音频采集 | 系统声音被转录为字幕 |
| 3.4 | 查看词卡 | 显示该单词的出现频率和来源列表 |
| 3.5 | 点击来源列表中的时间点 | 跳转到对应文件和时间位置播放 |
| 3.6 | 词频统计 Top N | 正确显示当前视频中最高频的单词 |
| 3.7 | 切换视频 | 词频统计重置为当前视频的数据 |
| 3.8 | 历史词频查询 | 可查看所有视频中某单词的出现记录 |
| 3.9 | 双模式切换 | 文件模式 ↔ WASAPI 模式可实时切换 |

### 3.5 工作量估计

| 模块 | 文件 | 预估工时 |
|------|------|---------|
| 3A 实时字幕双模式 | player.js, ws.js (新建), websocket.py 增强 | 16h |
| 3B 词频统计引擎 | wordFrequency.js (新建), SubtitleDisplay.js | 8h |
| 3C 单词来源追溯 | models.py, crud.py, API 新端点 | 8h |
| 数据库迁移 | migrations.py | 2h |
| 前端集成 | card.js 来源 tab, overlay.js 词频条 | 6h |
| **合计** | | **40h** |

---

## 优先级总结

| 需求 | 优先级 | 理由 | 依赖 | 预估工时 |
|------|--------|------|------|---------|
| **R1: 下载持久化** | **P0** | 现有代码 90% 已完成，修缺口即可，成本极低收益大 | 无 | 4h |
| **R2: 点读跳转** | **P0** | 核心交互闭环（查词 + 听音），直接提升学习效率 | 无（复用现有字幕数据结构） | 6h |
| **R3: 实时字幕+统计** | **P1** | 全新建模，工程量较大，但差异化价值最高 | 需要 WASAPI 和 WebSocket 基础设施（已有） | 40h |

**建议执行节奏**:
- 第 1 天: R1 (4h) + R2 设计评审 (1h)
- 第 2 天: R2 实现 (5h) + R3 数据库设计 (2h)
- 第 3-5 天: R3 核心引擎 (24h)
- 第 6-7 天: R3 前端集成 + 联调测试 (16h)

---

## 数据库变更汇总

| 变更类型 | 说明 | 影响表 | 迁移脚本 |
|---------|------|--------|---------|
| **新增表** | `word_occurrences` — 单词出现记录 | word_occurrences | v1_to_v2.py |
| **无变更** | vocab, subtitles, learning_records 保持不变 | — | — |

## 前端文件变更清单

| 文件 | 变更类型 | 变更内容 |
|------|---------|---------|
| `electron/src/scripts/player.js` | 修改 | _savePlayerState 增加 currentTime；restorePlayerState 增加续播；新增 RealtimeSubtitleController |
| `electron/src/scripts/SubtitleDisplay.js` | 修改 | 点击跳转逻辑；词频标注渲染 |
| `electron/src/scripts/subtitle.js` | 修改 | word-level 时间戳支持；平均分配兜底 |
| `electron/src/scripts/store.js` | 无变更 | 已有 cacheBlob/getCachedBlob 可直接使用 |
| `electron/src/scripts/app.js` | 修改 | watch 路由离开时保存 player state |
| `electron/src/scripts/wordFrequency.js` | **新建** | 词频统计引擎 + 来源追溯 |
| `electron/src/scripts/overlay.js` | 修改 | 悬浮窗词频条 + 来源显示 |
| `electron/src/scripts/card.js` | 修改 | 词卡新增「来源」tab |
| `electron/src/scripts/api.js` | 修改 | 新增 word-occurrences API 调用 |

## 后端文件变更清单

| 文件 | 变更类型 | 变更内容 |
|------|---------|---------|
| `python-backend/database/models.py` | 修改 | 新增 WordOccurrence 模型 |
| `python-backend/database/crud.py` | 修改 | word_occurrences CRUD |
| `python-backend/database/migrations.py` | 修改 | v1_to_v2 迁移脚本 |
| `python-backend/api/websocket.py` | 修改 | 实时转录添加 source tracking |
| `python-backend/api/vocabulary.py` | 修改（可选） | 词频统计 API |
| `python-backend/main.py` | 修改 | 注册新路由 |

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解方案 |
|------|------|------|---------|
| WASAPI Loopback 在某些 Windows 版本上不工作 | 中 | R3 功能减半 | 文件模式始终可用为 P0；WASAPI 作为增强 P1 |
| Whisper 实时转录延迟过高 | 中 | 实时字幕体验差 | 使用 tiny/base 模型；缓存常用模型 |
| 词频数据量过大 | 低 | 性能下降 | 按 session 隔离；前端只保留当前 session |
| 断点续播时 blob URL 失效 | 低 | R1 恢复失败 | 检测 blob URL 可用性，失效时自动重加载 |
| 单词来源追溯存储膨胀 | 中 | 数据库增长 | 设置保留周期（默认 30 天）；支持手动清理 |
