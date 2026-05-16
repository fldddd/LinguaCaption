# LinguaCaption 系统架构文档

> 版本: v0.2.0 · 更新: 2026-05-16
> 角色: 🏗️ Architect

---

## 一、系统总览

```
┌─────────────────────────────────────────────────────┐
│                    Electron 客户端                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ 播放器页   │  │ 点读页    │  │ 生词复习页        │  │
│  │ #/watch   │  │ #/point  │  │ #/review        │  │
│  └─────┬─────┘  └─────┬─────┘  └───────┬──────────┘  │
│        └──────────────┼─────────────────┘             │
│                       │ Hash Router                    │
│          ┌────────────┴────────────┐                   │
│          │     api.js (封装层)      │                   │
│          │     storage.js (本地)    │                   │
│          └────────────┬────────────┘                   │
└───────────────────────┼───────────────────────────────┘
                        │ HTTP / WebSocket
┌───────────────────────┼───────────────────────────────┐
│          FastAPI Backend (localhost:8000)               │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │ /api/health│  │ /api/audio│  │ /api/transcription│  │
│  │    ✅     │  │   ⬜ stub  │  │     ⬜ stub      │  │
│  └──────────┘  └──────────┘  └──────────────────┘    │
│  ┌─────────────────────────────────────────────────┐  │
│  │ /api/vocab ✅  8 endpoints (CRUD + 复习 + 统计)  │  │
│  └─────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────┐  │
│  │  WebSocket  (实时字幕 — s1-s2 桥接)              │  │
│  │  ws://localhost:8000/ws/subtitle                 │  │
│  └─────────────────────────────────────────────────┘  │
│                        │                               │
│  ┌─────────────────────┴──────────────────────────┐  │
│  │  SQLite (linguacaption.db)                      │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │  │
│  │  │ vocab    │  │ subtitles│  │ learning_rec  │  │  │
│  │  └──────────┘  └──────────┘  └──────────────┘  │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

---

## 二、API 契约（完整）

### 2.1 Health ✅

| 方法 | 路径 | 描述 | 状态 |
|------|------|------|------|
| GET | `/api/health` | 服务健康检查 | ✅ 已实现 |

**响应：**
```json
{"status": "ok", "version": "0.1.0"}
```

---

### 2.2 Vocab（生词收藏）✅ — 8 端点

| 方法 | 路径 | 描述 | 状态 |
|------|------|------|------|
| **GET** | `/api/vocab` | 分页列出生词（支持 search / mastered 过滤） | ✅ |
| **POST** | `/api/vocab` | 添加生词（含自动创建学习记录） | ✅ |
| **GET** | `/api/vocab/{id}` | 生词详情 | ✅ |
| **PUT** | `/api/vocab/{id}` | 更新生词（部分字段） | ✅ |
| **DELETE** | `/api/vocab/{id}` | 删除生词（级联删除学习记录） | ✅ |
| **POST** | `/api/vocab/{id}/review` | 记录复习结果（间隔重复算法） | ✅ |
| **GET** | `/api/vocab/due/list` | 待复习列表 | ✅ |
| **GET** | `/api/vocab/stats/summary` | 学习统计概览 | ✅ |

**请求/响应示例：**
```json
// POST /api/vocab
// Request:
{"word": "serendipity", "translation": "意外发现", "phonetic": "/ˌserənˈdɪpəti/", "part_of_speech": "noun"}
// Response 201:
{"id": 1, "word": "serendipity", "translation": "意外发现", "created_at": "2026-05-16T12:00:00+00:00", ...}

// POST /api/vocab/{id}/review
// Request:
{"correct": true, "difficulty": 3}
// Response:
{"review_count": 1, "correct_count": 1, "mastered": false, "next_review_at": "..."}
```

---

### 2.3 Audio（音频上传）⬜

| 方法 | 路径 | 描述 | 状态 |
|------|------|------|------|
| GET | `/api/audio` | 音频文件列表 | ⬜ stub |
| POST | `/api/audio/upload` | 上传音频文件 | ❌ 未实现 |
| GET | `/api/audio/segment?word=xxx` | 获取单词音频片段 | ❌ 未实现 |

**需要实现的端点（后端开发者 b2）：**
```json
// POST /api/audio/upload
// Content-Type: multipart/form-data
// Request: { file: <binary>, language?: "en" }
// Response 201:
{"id": "uuid", "filename": "lesson.mp3", "duration": 120.5, "status": "uploaded"}

// GET /api/audio/segment?word=serendipity
// Response 200: <binary audio data>
// Response 404: {"detail": "单词音频不存在"}
```

---

### 2.4 Transcription（转录）⬜

| 方法 | 路径 | 描述 | 状态 |
|------|------|------|------|
| GET | `/api/transcription` | 转录结果列表 | ⬜ stub |
| POST | `/api/transcription/start` | 开始转录任务 | ❌ 未实现 |
| GET | `/api/transcription/{id}` | 查询转录结果 | ❌ 未实现 |
| GET | `/api/transcription/{id}/subtitles` | 获取字幕列表 | ❌ 未实现 |

**需要实现的端点（后端开发者 b3）：**
```json
// POST /api/transcription/start
// Request: {"audio_id": "uuid", "language": "en", "model": "base"}
// Response 202:
{"task_id": "uuid", "status": "pending", "estimated_seconds": 30}

// GET /api/transcription/{id}
// Response:
{"task_id": "uuid", "status": "completed", "progress": 1.0}

// GET /api/transcription/{id}/subtitles?page=1&page_size=50
// Response:
{"items": [{"id": 1, "text": "Hello world", "start_time": 0.5, "end_time": 2.3}], "total": 100}
```

---

### 2.5 WebSocket 实时字幕（s1-s2 桥接）🔄

| 协议 | 路径 | 描述 | 优先级 |
|------|------|------|--------|
| WebSocket | `ws://localhost:8000/ws/subtitle` | 实时字幕流（模拟+真实） | P1 |

**消息格式：**

客户端 → 服务端（控制指令）：
```json
{"type": "start", "language": "en", "audio_source": "mic"}
{"type": "stop"}
{"type": "pause"}
{"type": "resume"}
```

服务端 → 客户端（推送）：
```json
{"type": "subtitle", "data": {"text": "This is a test", "start_time": 0.5, "end_time": 2.3, "is_final": true}}
{"type": "status", "data": {"state": "listening", "since": "..."}}
{"type": "error", "data": {"code": "AUDIO_ERR", "message": "麦克风无法访问"}}
```

---

## 三、数据库 ER 图

```
┌──────────────────────┐
│       vocab         │
├──────────────────────┤
│ id (PK, auto)       │
│ word (INDEX)        │  ← 单词原文
│ translation         │  ← 中文翻译
│ phonetic            │  ← 音标
│ part_of_speech      │  ← 词性 noun/verb/adj/adv
│ context             │  ← 上下文句子
│ source_subtitle_id  │──┐ FK → subtitles.id (SET NULL)
│ created_at          │  │
│ updated_at          │  │
└──────────────────────┘  │
                          │
┌──────────────────────┐  │
│      subtitles      │  │
├──────────────────────┤  │
│ id (PK, auto)       │←─┘
│ text                │  ← 字幕文本
│ start_time          │  ← 开始秒数
│ end_time            │  ← 结束秒数
│ language            │  ← "en"/"zh"
│ created_at          │
└──────────────────────┘
        │ 1
        │
        │ * (Vocab → subtitle 多对一)
        │

┌──────────────────────┐
│  learning_records   │
├──────────────────────┤
│ id (PK, auto)       │
│ vocab_id (INDEX)    │──┐ FK → vocab.id (CASCADE)
│ review_count        │  │  ← 复习次数
│ correct_count       │  │  ← 正确次数
│ last_reviewed_at    │  │  ← 上次复习
│ next_review_at      │  │  ← 下次复习（间隔重复）
│ mastered            │  │  ← 是否掌握
│ difficulty          │  │  ← 1-5 难度
│ created_at          │  │
└──────────────────────┘  │
  1:1 关系 ←────────────────┘
```

---

## 四、数据流：音频 → 字幕 → 生词

```
用户上传音频
     │
     ▼
┌─────────────┐    POST /api/audio/upload
│  音频存储    │ ─────────────────────────────→ 保存到 data/audio/{uuid}.mp3
└──────┬──────┘
       │
       ▼
┌─────────────┐    POST /api/transcription/start
│ Whisper 转录 │ ─────────────────────────────→ 异步任务，Whisper 模型处理
└──────┬──────┘
       │
       ▼
┌─────────────┐    GET /api/transcription/{id}/subtitles
│  字幕解析    │ ─────────────────────────────→ 返回 SRT/VTT 格式字幕
│  SRT → JSON  │                                  批量写入 subtitles 表
└──────┬──────┘
       │
       ▼
┌─────────────┐    前端播放器
│  同步渲染    │ ──→ 按 start_time 逐行高亮
└──────┬──────┘    用户点击单词
       │
       ▼
┌─────────────┐    POST /api/vocab
│  收藏生词    │ ──→ 写入 vocab 表 + 自动创建 learning_records
└──────┬──────┘
       │
       ▼
┌─────────────┐    GET /api/vocab/due/list
│  间隔复习    │ ──→ 按 next_review_at 排序，到期提醒
│  1d→3d→7d   │    用户复习 → POST /api/vocab/{id}/review
│  →14d→30d   │    连续正确5次 → mastered=true
└─────────────┘
```

---

## 五、前端模块依赖图

```
F1 (Router + SPA壳)
  │
  ├── F2 (点读界面)
  │     ├── subtitle.js (SRT解析)     ✅ 57行
  │     ├── player.js (播放控制)      🟡 397行（需拆分）
  │     │     ├── F3 单词点击
  │     │     ├── F4 悬浮词卡
  │     │     └── F5 收藏按钮
  │     └── api.js (API封装)         ⬜ 空
  │
  ├── F6 (本地存储)
  │     ├── storage.js               ⬜ 空
  │     └── 离线缓存策略
  │
  └── F5 (生词本页面)
        ├── #/review 路由
        └── 筛选/搜索/分页
```

**当前前端瓶颈：**
1. `player.js` 397 行杂糅了 F2/F3/F4/F5 四块逻辑，需要按职责抽离
2. `router.js` `app.js` `api.js` `storage.js` 全部为空，F1 脚手架未搭建
3. `index.html` `main.css` 为空，无 UI

---

## 六、s1-s2 桥接方案

### 当前阶段划分

| 阶段 | 范围 | 状态 |
|------|------|------|
| **Phase 1** | 基础骨架 + 数据库 + Vocab API | ✅ 完成 |
| **Phase 2** | 音频上传 + Whisper 转录 + 实时字幕 | 🔜 开始 |
| **s1-s2 桥接** | Phase 1 → Phase 2 的平滑过渡 | ❌ 未做 |

### 桥接内容

```
s1-s2 桥接 = WebSocket 基础设施 + 实时字幕模拟器 + 前端 API 封装层
```

| 组件 | 文件 | 说明 |
|------|------|------|
| WebSocket 端点 | `python-backend/api/websocket.py` | FastAPI WebSocket，接收音频流 → 推送字幕 |
| 字幕模拟器 | `python-backend/transcription/simulator.py` | Phase 2 前用 mock 数据模拟实时字幕 |
| 前端 WebSocket 客户端 | `electron/src/scripts/ws.js` | 连接 ws://localhost:8000/ws/subtitle |
| 前端 API 封装 | `electron/src/scripts/api.js` | 统一 API 层：REST + WebSocket 切换 |
| 实时字幕模式 | `electron/src/scripts/player.js` | F2.4 模式切换：文件模式 ↔ 实时模式 |

### 后端目录结构（桥接后）

```
python-backend/
├── api/
│   ├── health.py              ✅
│   ├── audio.py               ⬜ 填充
│   ├── transcription.py       ⬜ 填充
│   ├── vocabulary.py          ✅
│   └── websocket.py           ❌ 新建 —— 实时字幕 WebSocket
├── transcription/
│   └── simulator.py            ❌ 新建 —— Phase 2 前的字幕模拟器
├── database/                   ✅
├── schemas/                    ✅
└── main.py                     ✅
```

---

## 七、开发路线图

```
当前
 │
 ├── 🏗️ Architect (我)
 │    ├── 1️⃣ 输出本架构文档 ✅
 │    ├── 2️⃣ 实现 WebSocket + 字幕模拟器 (s1-s2 桥接)
 │    └── 3️⃣ 输出 api.js 接口规范
 │
 ├── 💻 Developer
 │    ├── 1️⃣ rebase develop → 修复 stale 分支
 │    ├── 2️⃣ 按 F1→F2→F3→F6→F4→F5 顺序开发前端
 │    └── 3️⃣ b2-b4 后端 API 填充（audio + transcription）
 │
 ├── 👀 Reviewer
 │    ├── 1️⃣ b5 API 已合并 ✅，review 前端 PR
 │    └── 2️⃣ 完善 b5 测试覆盖
 │
 └── 🔧 DevOps
      ├── 1️⃣ API Key 配置（DeepSeek ✅ / 其他）
      ├── 2️⃣ 基础设施（启动脚本 / 环境变量）
      └── 3️⃣ CI 配置（GitHub Actions）
```

---

## 八、决策记录 (ADR)

### ADR-001: SQLite + SQLAlchemy（而非 PostgreSQL）
- **理由**: 单机桌面应用，无需网络数据库
- **Trade-off**: 并发性能有限，但桌面场景足够
- **缓解**: WAL 模式 + StaticPool 连接池

### ADR-002: 前后端分离（Electron + FastAPI）
- **理由**: 前端可独立开发（mock 数据），后端可独立测试
- **Trade-off**: 用户需启动两个进程
- **缓解**: `concurrently` 一键启动

### ADR-003: 实时字幕用 WebSocket（而非轮询）
- **理由**: Whisper 转录是流式过程，轮询延迟高
- **Trade-off**: 需要维护长连接
- **缓解**: FastAPI 原生 WebSocket 支持，代码量 < 50 行

### ADR-004: 前端先用 mock 数据开发
- **理由**: 前端 F1-F6 不依赖后端任何接口
- **缓解**: api.js 封装层，后期一行代码切换真实接口
