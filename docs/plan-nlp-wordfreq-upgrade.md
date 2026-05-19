# 学习数据系统升级 — 实施计划

## 1. 当前已有功能 vs 需求差距分析

### 1.1 词频系统现状（已完成 Phase 3）

| 模块 | 当前状态 | 关键文件 |
|------|----------|----------|
| 词频统计服务 | ✅ 完整实现 — 内存缓存(Splay Tree风格) + SQLite批量刷新(30s间隔) | `python-backend/services/word_frequency.py` (299行) |
| 词频API | ✅ 6端点完整实现 | `python-backend/api/words.py` (133行) |
| 数据库 word_frequency表 | ✅ 已迁移 (002_word_frequency.sql) | `python-backend/database/models.py` WordFrequency |
| 数据库 word_occurrences表 | ✅ 已迁移，含source_type/source_id/timestamp | `python-backend/database/models.py` WordOccurrence |
| 词频面板前端 | ✅ 3 Tab (排行榜/查单词/来源追踪) + auto-refresh | `electron/src/scripts/wordFreqPanel.js` (474行) |
| 字幕点击跳转 | ✅ 单词级 data-start/data-end + seekTo | `electron/src/scripts/SubtitleDisplay.js` (279行) |
| WebSocket实时字幕 | ✅ 含word-level时间戳推送 | `python-backend/api/websocket.py` (459行) |
| 转录后词频记录 | ✅ player.js在实时转录和文件转录后均调用recordSubtitleWords | `electron/src/scripts/player.js` |

### 1.2 用户需求 vs 现状差距矩阵

| # | 用户需求 | 当前状态 | 差距 | 优先级 |
|---|----------|----------|------|--------|
| R1 | spaCy NLP语义解析(句法角色标注/词组抽取/词性标注/分句) | ❌ 无任何NLP组件，requirements.txt无spaCy依赖 | **全缺失** | P0 |
| R2 | 多语种支持：根据Whisper语种自动切换spaCy模型 | ❌ 无语言感知的NLP pipeline | **全缺失** | P0 |
| R3 | 增强Splay Tree：按文本快速检索节点，存储溯源关联信息 | ⚠️ word_frequency.py使用dict做hash索引(O(1)精确查找)，但**不支持模糊搜索/前缀搜索**，且无Splay Tree的splay操作 | **部分缺失** — 当前是"Splay Tree风格"仅为设计理念，实际是dict缓存。缺少(1)模糊搜索 (2)溯源关联元数据内嵌 (3)按文本快速定位 | P1 |
| R4 | 新增数据库表：transcript_fragment | ❌ 不存在 | **全缺失** | P1 |
| R4 | 新增数据库表：session_info | ❌ 不存在 | **全缺失** | P1 |
| R5 | 搜索溯源：搜索单词/词组，追溯原始转录来源(对应视频、时间戳) | ⚠️ word_occurrences表已存储source_type/source_id/time，但**无视频关联信息**，无session关联，无法"从单词→具体视频片段" | **部分缺失** — 基础数据结构有但缺少视频→片段→单词的完整链路 | P0 |
| R6 | 前端改造：搜索框、溯源展示、按句法角色差异化着色 | ⚠️ wordFreqPanel已有搜索和来源tab，但**无句法角色着色**，溯源展示缺少视频标题和时间戳链接 | **部分缺失** | P1 |
| R7 | WebSocket协议扩展：检索+溯源消息格式 | ❌ 现有WS仅支持subtitle/audio_status两种消息类型 | **全缺失** | P1 |

### 1.3 总体现状评估

```
完成度: ████████░░░░░░░░ 约 35%
                            ↑ 仅词频基础框架完成
                               NLP + 溯源链路 + 前端增强 未开始
```

---

## 2. 任务拆解（按依赖顺序）

### Phase 4.1: NLP 基础设施搭建 (P0)

**依赖：无**（独立于现有系统）

**T4.1.1 — 安装spaCy + 下载多语种模型**
- 在 `requirements.txt` 添加 `spacy>=3.7.0`
- 在项目根目录添加 `scripts/download_spacy_models.py`（自动检测并下载 en_core_web_sm, zh_core_web_sm, ja_core_web_sm, de_core_web_sm, fr_core_web_sm, es_core_web_sm）
- 注意：中文用 `zh_core_web_sm` 需要额外依赖 `spacy[zh]` 或 `jieba`
- 后端启动时检查模型可用性，缺失时降级运行（不影响转录）

**T4.1.2 — 创建 NLP 服务模块 `services/nlp_service.py`**
- `class NLPService` 单例
- `__init__`: 惰性加载模型字典 `{'en': nlp_en, 'zh': nlp_zh, ...}`
- `get_parser(language: str) -> spacy.Language`: 根据语言代码返回对应模型
- `parse(text, language) -> ParsedResult`: 核心方法，返回句法分析结果
- `is_available(language) -> bool`: 检查某语言模型是否可用
- 支持的语言列表： en, zh, ja, de, fr, es （覆盖 Whisper 99% 场景）
- 线程安全：spaCy 的 Language 对象不是线程安全的，需用 Thread-local storage 或 lock

**T4.1.3 — 定义 NLP 数据结构 `schemas/nlp.py`**
```python
class SyntacticToken(BaseModel):
    text: str
    lemma: str          # 词元
    pos: str            # 粗粒度词性 (NOUN/VERB/ADJ...)
    tag: str            # 细粒度词性标签 (NN/VBD/JJ...)
    dep: str            # 句法依存关系 (nsubj/dobj/amod...)
    head_text: str      # 中心词
    head_idx: int       # 中心词在句子中的索引
    is_stop: bool       # 是否停用词
    morph: dict         # 形态特征

class PhraseChunk(BaseModel):
    text: str
    root: str           # 核心词
    label: str          # 词组类型 (NP/VP/ADJP/ADVP...)
    start: int          # 在原文中的起始字符位置
    end: int            # 在原文中的结束字符位置

class ParsedSentence(BaseModel):
    text: str
    tokens: list[SyntacticToken]
    phrases: list[PhraseChunk]

class ParsedResult(BaseModel):
    language: str
    sentences: list[ParsedSentence]
    tokens: list[SyntacticToken]    # 扁平化所有token
    phrases: list[PhraseChunk]      # 扁平化所有词组
```

---

### Phase 4.2: 数据库扩展 (P0 — 与 4.1 并行)

**依赖：无**（与 NLP 服务并行开发，互不干扰）

**T4.2.1 — 新增 `transcript_fragment` 表**
- 在 `database/models.py` 新增模型
```python
class TranscriptFragment(Base):
    """转录片段 — 记录每次转录输出的语义片段"""
    __tablename__ = "transcript_fragment"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("session_info.id"), index=True)  # 关联会话
    text = Column(Text, nullable=False)              # 片段文本
    language = Column(String(10), default="en")      # 语种
    start_time = Column(Float, default=0)            # 在媒体中的开始时间
    end_time = Column(Float, default=0)              # 在媒体中的结束时间
    source_type = Column(String(50), default="")     # 'file' | 'url' | 'system_audio'
    source_name = Column(String(500), default="")    # 文件名或URL
    source_video_id = Column(String(255), default="") # 视频标识（B站av号/yt-id等）
    word_count = Column(Integer, default=0)          # 单词数
    parsed_at = Column(DateTime, nullable=True)      # NLP解析时间
    created_at = Column(DateTime, default=datetime.now(timezone.utc))
```

**T4.2.2 — 新增 `session_info` 表**
```python
class SessionInfo(Base):
    """会话信息 — 记录一次观看/转录会话"""
    __tablename__ = "session_info"

    id = Column(Integer, primary_key=True)
    session_type = Column(String(50), default="realtime")  # 'realtime' | 'file_transcribe' | 'manual'
    language = Column(String(10), default="en")             # 会话主要语言
    source_type = Column(String(50), default="")            # 来源类型
    source_name = Column(String(500), default="")           # 来源名称
    source_url = Column(Text, nullable=True)                # 视频URL
    media_duration = Column(Float, default=0)               # 媒体总时长
    total_fragments = Column(Integer, default=0)            # 总片段数
    total_words = Column(Integer, default=0)                # 总单词数
    started_at = Column(DateTime, default=datetime.now(timezone.utc))
    ended_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, default=True)               # 是否活跃会话
```

**T4.2.3 — 创建迁移文件 `003_session_fragment.sql`**
- 创建 transcript_fragment 表（含索引：session_id, language, source_type+source_name）
- 创建 session_info 表（含索引：session_type, is_active, started_at）
- 更新 `word_occurrences` 表：可选新增 `session_id` 和 `fragment_id` 外键列（向后兼容，默认为 NULL）

**T4.2.4 — 实现 CRUD 操作**
- `database/crud.py` 新增:
  - `create_session(...)` / `close_session(session_id)` / `get_active_session()` / `list_sessions(limit, offset)`
  - `insert_fragment(...)` / `get_fragments_by_session(session_id)` / `search_fragments(keyword, language, limit, offset)`
  - `get_fragments_by_word(word, session_id=None)` — 溯源查询核心

---

### Phase 4.3: NLP 与转录系统集成 (P0 — 依赖 4.1, 4.2)

**依赖：T4.1.2 (NLP服务) + T4.2.1~4.2.4 (新表+CRUD)**

**T4.3.1 — 转录流程集成 NLP**
- 修改 `api/websocket.py` 的 `_transcription_loop()`:
  - 转录完成后调用 `nlp_service.parse(result.text, language)`
  - 将 ParsedResult 存入 TranscriptFragment（含句法分析结果）
  - 将每个单词的词性/句法角色信息存入 word_occurrences（新增 pos/dep 字段）
  - 或新增 `word_syntactic` 表存储单词级别的句法标注（避免 word_occurrences 膨胀）
- 修改 `api/transcription.py` 的文件转录流程（批量转录时同样进行 NLP 解析）
- 修改 `services/word_frequency.py` 的 `record_text()` 方法：接收可选的 parsed_result 参数

**T4.3.2 — 会话生命周期管理**
- 在 WebSocket `/subtitle/realtime` 端点中，收到 `start` 命令时:
  - 创建 SessionInfo 记录（language, source_type, source_name）
  - 返回 `session_id` 给前端
- 在 `stop` / 断线时:
  - 关闭会话（set ended_at, is_active=False）
  - 释放 NLP 模型资源
- 文件转录流程启动时同样创建 SessionInfo

**T4.3.3 — Splay Tree 增强**
- 修改 `WordFrequencyService` 的内部缓存结构:
  - 当前: `dict[str, dict]` — 精确匹配 O(1)
  - 增强为: `dict[str, WordNode]` 其中 WordNode 包含:
    - word, cumulative, session, first_seen, last_seen
    - `synctactic_info: dict` — 存储近期 N 次出现的句法角色统计（最常见 pos/dep）
    - `provenance_ids: list[int]` — 关联的 fragment_id 列表（最近 N 条）
  - 新增 `search_by_prefix(prefix: str, limit: int) -> list[WordNode]` — Trie 索引
  - 新增 `search_by_pos(pos: str, limit: int) -> list[WordNode]` — 按词性筛选
- 注意：当前实现命名"Splay Tree风格"但实际是 dict，不需要真正实现 splay 操作。重点是增强搜索能力

---

### Phase 4.4: API 扩展 (P1 — 依赖 4.3)

**T4.4.1 — 会话管理 API**
- 新增 `api/sessions.py` router (prefix="/sessions")
  - `GET /sessions/list` — 会话历史列表
  - `GET /sessions/{id}` — 会话详情（含片段统计、词频摘要）
  - `GET /sessions/{id}/fragments` — 会话的转录片段列表
  - `GET /sessions/active` — 当前活跃会话

**T4.4.2 — 溯源搜索 API**
- 增强 `api/words.py` 或新建 `api/search.py`:
  - `GET /search/provenance?q=word&session_id=&limit=&offset=` — 溯源搜索，返回:
    ```json
    {
      "word": "hello",
      "total_matches": 42,
      "matches": [{
        "fragment_id": 123,
        "session_id": 5,
        "session_name": "B站视频标题.mp4",
        "text": "...hello world...",
        "start_time": 12.5,
        "end_time": 13.2,
        "source_url": "https://bilibili.com/video/xxx",
        "syntactic_role": "nsubj",
        "pos": "INTJ"
      }]
    }
    ```
  - `GET /search/provenance/advanced?phrase=hello world&pos=NOUN&language=en` — 高级搜索
  - `GET /search/suggestions?q=hel` — 前缀搜索建议

**T4.4.3 — NLP 元数据 API**
- `GET /words/syntactic/{word}` — 单词句法统计（最常见的词性、依存关系）
- `GET /words/pos/{pos}` — 按词性列出高频词

---

### Phase 4.5: WebSocket 协议扩展 (P1 — 依赖 4.4)

**T4.5.1 — 新增消息类型**
- 在 `api/websocket.py` 中扩展协议:
  - 客户端 → 服务端: `{"type": "search", "query": "hello", "limit": 20}`
  - 服务端 → 客户端: `{"type": "search_result", "data": {...}}`
  - 客户端 → 服务端: `{"type": "provenance", "word": "hello", "session_id": 5}`
  - 服务端 → 客户端: `{"type": "provenance_result", "data": [...]}`
  - 服务端 → 客户端: `{"type": "nlp_update", "data": {"fragment_id": 123, "sentence": "...", "syntactic_tokens": [...]}}` — NLP解析完成时推送
  - 服务端 → 客户端: `{"type": "session_update", "data": {"session_id": 5, "status": "active", "word_count": 234}}`

**T4.5.2 — 前端 WebSocket 消息分发升级**
- 在 `app.js` 或新建 `websocket_handler.js` 中:
  - 统一消息分发器: 根据 `msg.type` 路由到对应 handler
  - 新增 `search_result`, `provenance_result`, `nlp_update`, `session_update` 的 handler

---

### Phase 4.6: 前端大改造 (P1 — 依赖 4.4, 4.5)

**T4.6.1 — 搜索框组件**
- 在 `player.js` 的播放器控制栏添加搜索按钮/搜索框
- 或作为 `wordFreqPanel.js` 的第四 Tab "搜索溯源"
- 搜索框特性:
  - 实时前缀建议（debounce 300ms 后请求 `/search/suggestions`）
  - 搜索结果展示: 单词/词组 + 词性标签 + 词频统计
  - 点击结果进入溯源详情

**T4.6.2 — 溯源展示组件**
- 在 `wordFreqPanel.js` 的"来源追踪" Tab 升级:
  - 当前: 仅显示 source_id + subtitle_text
  - 升级后: 显示视频标题、时间戳链接(可点击跳转)、片段上下文
  - 时间戳点击 → 跳转到媒体的对应时间点
  - 视频标题点击 → 打开来源 URL（如 B站视频）
- 新增 `provenanceView.js` 独立溯源视图组件（可选）

**T4.6.3 — 按句法角色差异化着色**
- 在 `SubtitleDisplay.js` 的 `makeWordsClickable()` 中:
  - 从 word_occurrences 或 word_frequency 缓存读取该单词的常见词性
  - 如果已知词性，添加 CSS class: `pos-noun`, `pos-verb`, `pos-adj`, `pos-adv`, `pos-prep` 等
  - 在 `main.css` 或 `overlay.css` 中定义着色规则:
    ```css
    .pos-noun { color: #e74c3c; }     /* 红色 — 名词 */
    .pos-verb { color: #3498db; }     /* 蓝色 — 动词 */
    .pos-adj  { color: #2ecc71; }     /* 绿色 — 形容词 */
    .pos-adv  { color: #f39c12; }     /* 橙色 — 副词 */
    .pos-prep { color: #9b59b6; }     /* 紫色 — 介词 */
    .pos-det  { color: #7f8c8d; }     /* 灰色 — 限定词 */
    .pos-pron { color: #1abc9c; }     /* 青色 — 代词 */
    .pos-unk  { color: inherit; }      /* 未知 — 继承 */
    ```
  - 句子级高亮：按句法依存关系给词组着色（更深层的视觉提示）
  - 注意：中文语种的词性着色策略不同（中文词性标签用 `pos_` 而非 `pos`）

**T4.6.4 — 词性筛选面板**
- 在 `wordFreqPanel.js` 的排行榜 Tab 添加词性过滤下拉菜单:
  - "全部"、"名词"、"动词"、"形容词"、"副词"、"介词"...
  - 筛选后仅显示对应词性的高频词

---

### Phase 4.7: 数据迁移与兼容性 (P2 — 可延迟到上线前)

**T4.7.1 — 历史数据 NLP 回填**
- 编写脚本 `scripts/backfill_nlp.py`:
  - 遍历 word_occurrences 表中所有没有词性/句法角色的记录
  - 批量调用 NLP 解析（按语言分批）
  - 更新 word_occurrences 添加 pos/dep 信息
  - 创建缺失的 TranscriptFragment 记录

**T4.7.2 — 旧词频数据迁移**
- 将 word_occurrences 与 session_info 关联（如果缺少 session_id）
- 为历史数据生成虚拟 session_id

---

## 3. 每个任务的工时估算

| 编号 | 任务 | 工程师级别 | 预估工时 | 备注 |
|------|------|-----------|---------|------|
| **Phase 4.1 — NLP 基础设施** | | | **3天** | |
| T4.1.1 | 安装spaCy + 下载模型 | 初级 | 0.5天 | 主要是下载时间，编码极少 |
| T4.1.2 | 创建 NLPService 服务模块 | 高级 | 1.5天 | 需处理线程安全、惰性加载、降级策略 |
| T4.1.3 | 定义 NLP 数据结构 | 中级 | 0.5天 | Pydantic模型定义 |
| T4.1.4 | 单元测试: NLP 服务 | 中级 | 0.5天 | 多语种解析正确性 |
| **Phase 4.2 — 数据库扩展** | | | **1.5天** | |
| T4.2.1 | 新增 transcript_fragment 模型 | 中级 | 0.25天 | SQLAlchemy模型 |
| T4.2.2 | 新增 session_info 模型 | 中级 | 0.25天 | |
| T4.2.3 | 创建迁移文件 | 中级 | 0.25天 | |
| T4.2.4 | CRUD 操作实现 | 中级 | 0.75天 | session + fragment CRUD |
| **Phase 4.3 — NLP 与转录集成** | | | **3天** | |
| T4.3.1 | 转录流程集成 NLP | 高级 | 2天 | WebSocket + 文件转录两条链路 |
| T4.3.2 | 会话生命周期管理 | 高级 | 0.5天 | session create/close 集成 |
| T4.3.3 | Splay Tree 增强 | 高级 | 0.5天 | Trie索引 + 元数据内嵌 |
| **Phase 4.4 — API 扩展** | | | **2天** | |
| T4.4.1 | 会话管理 API | 中级 | 0.5天 | 4个端点 |
| T4.4.2 | 溯源搜索 API | 高级 | 1天 | 核心溯源逻辑，含全文搜索 |
| T4.4.3 | NLP 元数据 API | 中级 | 0.5天 | 句法统计、词性筛选 |
| **Phase 4.5 — WebSocket 扩展** | | | **1.5天** | |
| T4.5.1 | 后端 WS 消息扩展 | 高级 | 1天 | 新增4种消息类型 |
| T4.5.2 | 前端 WS 消息分发 | 中级 | 0.5天 | 路由新增 handler |
| **Phase 4.6 — 前端改造** | | | **3.5天** | |
| T4.6.1 | 搜索框组件 | 中级 | 1天 | 实时前缀搜索 UI |
| T4.6.2 | 溯源展示升级 | 中级 | 1天 | 视频信息、时间戳链接 |
| T4.6.3 | 句法角色着色 | 高级 | 1天 | CSS + JS 联动，中文适配 |
| T4.6.4 | 词性筛选面板 | 中级 | 0.5天 | 过滤下拉菜单 |
| **Phase 4.7 — 数据迁移** | | | **1.5天** | |
| T4.7.1 | 历史数据 NLP 回填 | 中级 | 1天 | 批量解析脚本 |
| T4.7.2 | 旧词频数据迁移 | 中级 | 0.5天 | session 关联 |
| **总计** | | | **16天** | 约3个sprint（2周开发 + 1周缓冲） |

---

## 4. 风险点

### 高风险 🟥

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| **spaCy 中文模型精度不足** | 中文句法分析结果质量差，着色不准 | 中 | (1) 中文先降级到仅分词+词性标注，跳过依存分析 (2) 预留替换为 HanLP/jieba 的接口 (3) 英文优先确保质量 |
| **实时转录场景下 NLP 解析延迟** | 转录到显示NLP结果之间存在明显延迟，影响用户体验 | 高 | (1) NLP 解析异步执行，不阻塞字幕推送 (2) 先推送字幕，NLP完成后通过WS推送 nlp_update (3) 解析超时则跳过（5s timeout） |
| **多语种模型磁盘占用过大** | 6个spaCy模型合计约 1-2GB，Windows用户可能空间不足 | 中 | (1) 仅按需下载（Whisper检测到语种后才下载对应模型）(2) 提供精简配置选项（仅 en）(3) 启动时检查磁盘空间 |
| **word_occurrences 表再次膨胀** | 增加 pos/dep 字段后单行数据变大，历史数据回填加剧膨胀 | 中 | (1) 新增 `word_syntactic` 独立表专门存句法信息 (2) 数据保留策略（90天自动清理）(3) 聚合存储（同单词同词性合并） |

### 中风险 🟡

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| **线程安全 — spaCy 非线程安全** | 多个转录并发时 NLP 服务崩溃 | 高 | (1) Thread-local storage 存储 nlp 实例 (2) 每个线程独立加载模型 (3) 加锁保护解析调用 |
| **WebSocket 消息泛滥** | NLP 解析推送 + session update + subtitle 三条消息流同时推送，前端渲染跟不上 | 中 | (1) 前端消息合并 (2) 后端节流推送 (3) nlp_update 按语义组而非逐句推送 |
| **前端着色与现有主题冲突** | 词性着色在深色/浅色主题下可读性差 | 低 | (1) 使用 CSS 变量定义颜色 (2) 测试深色/浅色两种主题 (3) 提供可配置颜色 |
| **字幕文件导入无 NLP** | SRT/VTT 导入后没有 NLP 解析，词性着色不可用 | 低 | (1) 导入后触发异步后台解析 (2) 显示"NLP解析中..."状态 (3) 解析完成自动刷新 |
| **搜索 API 性能** | word_occurrences 表百万级记录时全文搜索慢 | 中 | (1) SQLite FTS5 全文索引 (2) 分页限制最大100条 (3) 前端 debounce 搜索请求 |

### 低风险 🟢

| 风险 | 影响 | 概率 | 缓解措施 |
|------|------|------|----------|
| spaCy 模型版本兼容性 | 不同版本 spaCy 模型文件格式不兼容 | 低 | (1) 锁定 spacy 版本 (2) 模型自动下载匹配版本 (3) CI 测试 |
| session_id 未传递到已有代码 | player.js 调用 recordSubtitleWords 未传 session_id | 低 | (1) session_id 作为可选参数 (2) 后端自动关联当前活跃会话 (3) 无会话时使用 fallback |
| Electron 打包体积增大 | spaCy 模型打包后应用体积大 | 低 | (1) 模型不打包，运行时首次使用下载 (2) 提供离线安装包选项 |

---

## 5. 建议实施顺序

### 原则

1. **先基础后上层** — NLP 服务和数据库表先行，NLP 集成和前端 UI 后行
2. **保持向后兼容** — 所有新字段可选/可空，不破坏现有功能
3. **可独立交付** — 每个 Phase 结束后可以独立测试和发布
4. **英文优先** — 先确保英文 NLP 质量，中文和其他语种逐步添加

### 推荐实施 Order

```
Sprint 1 (天 1-5): 核心基础
  ├── Phase 4.1 (NLP 基础设施)       — 天 1-3
  │   ├── T4.1.1 安装spaCy+下载模型   ── [天 1 AM]
  │   ├── T4.1.3 NLP 数据结构         ── [天 1 PM]
  │   └── T4.1.2 NLPService 服务模块  ── [天 2-3]
  │
  └── Phase 4.2 (数据库扩展)           — 天 1-2 (与4.1并行)
      ├── T4.2.1 transcript_fragment  ── [天 1]
      ├── T4.2.2 session_info         ── [天 1]
      ├── T4.2.3 迁移文件             ── [天 2]
      └── T4.2.4 CRUD 操作           ── [天 2]

Sprint 2 (天 6-10): NLP 集成 + API
  ├── Phase 4.3 (NLP 与转录集成)      — 天 6-8
  │   ├── T4.3.2 会话生命周期管理      ── [天 6]
  │   ├── T4.3.1 转录+NLP 集成       ── [天 7-8]
  │   └── T4.3.3 Splay Tree 增强     ── [天 8]
  │
  ├── Phase 4.4 (API 扩展)            — 天 8-9
  │   ├── T4.4.1 会话管理 API        ── [天 8]
  │   ├── T4.4.2 溯源搜索 API        ── [天 9]
  │   └── T4.4.3 NLP 元数据 API      ── [天 9]
  │
  └── Phase 4.5 (WebSocket 扩展)      — 天 10
      ├── T4.5.1 后端 WS 扩展        ── [天 10 AM]
      └── T4.5.2 前端 WS 分发        ── [天 10 PM]

Sprint 3 (天 11-16): 前端 + 数据迁移 + 发布
  ├── Phase 4.6 (前端改造)            — 天 11-14
  │   ├── T4.6.1 搜索框组件          ── [天 11]
  │   ├── T4.6.4 词性筛选面板        ── [天 12 AM]
  │   ├── T4.6.2 溯源展示升级        ── [天 12-13]
  │   ├── T4.6.3 句法角色着色        ── [天 13-14]
  │   └── 集成测试: 端到端           ── [天 14]
  │
  ├── Phase 4.7 (数据迁移)            — 天 15
  │   ├── T4.7.1 历史数据 NLP 回填   ── [天 15 AM]
  │   └── T4.7.2 旧词频数据迁移      ── [天 15 PM]
  │
  └── 发布前检查                       — 天 16
      ├── CODE_REVIEW 中 4 个 Critical 修复验证
      ├── 性能测试: NLP 解析对转录延迟影响 < 500ms
      ├── 数据库迁移回滚测试
      └── 边界情况: 无网络、模型不可用、超大文本

总预估: 16个工作日 (约3个日历周)
```

### 可选优化项（不阻塞主线，但建议做）

1. **CODE_REVIEW Critical 修复** — 词频数据竞争丢失 (CRIT-3) 应在 Sprint 1 同时修复
2. **FTS5 全文索引** — 如果 word_occurrences 表超过 10 万行，T4.4.2 前应建立 FTS5 索引
3. **前端模块拆分** — player.js (1245行) 已经过大，建议将词频相关的代码分离为独立模块
4. **悬浮窗协同时着色** — overlay.html 的字幕悬浮窗是否也需要着色？需评估但可延后

---

## 附录 A: 文件改动清单汇总

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `python-backend/requirements.txt` | ✅ 修改 | 添加 spacy |
| `python-backend/services/nlp_service.py` | 🆕 新建 | NLP 分析服务 |
| `python-backend/schemas/nlp.py` | 🆕 新建 | NLP 数据结构 |
| `python-backend/database/models.py` | ✅ 修改 | 新增 TranscriptFragment, SessionInfo |
| `python-backend/database/crud.py` | ✅ 修改 | 新增 session+fragment CRUD |
| `python-backend/database/migrations.py` | ✅ 修改 | 新增 003 迁移注册 |
| `python-backend/migrations/003_session_fragment.sql` | 🆕 新建 | 迁移文件 |
| `python-backend/api/sessions.py` | 🆕 新建 | 会话管理 API |
| `python-backend/api/search.py` | 🆕 新建 | 溯源搜索 API |
| `python-backend/api/words.py` | ✅ 修改 | 新增 NLP 元数据端点 |
| `python-backend/api/websocket.py` | ✅ 修改 | WS 消息扩展 + NLP 集成 |
| `python-backend/api/transcription.py` | ✅ 修改 | 文件转录集成 NLP |
| `python-backend/services/word_frequency.py` | ✅ 修改 | Splay Tree 增强 |
| `python-backend/main.py` | ✅ 修改 | 注册新 router |
| `scripts/download_spacy_models.py` | 🆕 新建 | 模型下载脚本 |
| `scripts/backfill_nlp.py` | 🆕 新建 | 历史数据回填 |
| `electron/src/scripts/wordFreqPanel.js` | ✅ 修改 | 溯源升级 + 词性筛选 |
| `electron/src/scripts/SubtitleDisplay.js` | ✅ 修改 | 句法角色着色 |
| `electron/src/scripts/player.js` | ✅ 修改 | 搜索框集成 |
| `electron/src/scripts/websocket_handler.js` | 🆕 新建 | WS 消息分发 |
| `electron/src/styles/main.css` | ✅ 修改 | 词性着色 CSS |
| `electron/src/styles/overlay.css` | ✅ 修改 | 词性着色 CSS |

---

*文档版本: v1.0 | 创建: 2026-05-19 | 角色: 🤖 Hermes Agent (技术开发部主管)*
