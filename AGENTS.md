# LinguaCaption — AGENTS.md

> **Fulldo Studio** — 个人科技品牌
> AI Agent 项目入口文档
> 最后更新: 2026-05-17

---

## 项目概述

LinguaCaption 是一个**实时字幕英语学习助手**。通过系统音频/WASAPI Loopback 采集正在播放的视频/音频声音，实时转为字幕显示在桌面悬浮窗上，支持单词点读、释义卡片、生词收藏和间隔重复复习。

**核心体验：** 看外语视频 → 实时字幕 → 点击查词 → 收藏生词 → 自动复习

---

## 技术栈

| 层 | 技术 | 版本 |
|---|------|------|
| 前端框架 | Electron | 33+ |
| 打包工具 | Vite | 6+ |
| 前端语言 | Vanilla JS (SPA, 无框架) | - |
| 后端框架 | Python FastAPI | 3.11+ |
| 数据库 | SQLite + SQLAlchemy | WAL 模式 |
| 实时通信 | WebSocket (FastAPI) | - |
| 语音识别 | OpenAI Whisper (本地模型) | - |
| 音频采集 | WASAPI Loopback (pyaudiowpatch) | - |

---

## 项目结构

```
LinguaCaption/
├── AGENTS.md                      # ← 本文档：AI Agent 入口
├── README.md                      # 用户文档
├── package.json                   # Node.js 项目配置
├── vite.config.js                 # Vite 打包配置
│
├── electron/                      # 前端（Electron 桌面应用）
│   ├── main.js                    # Electron 主进程
│   ├── overlay.js                 # 悬浮窗主进程模块
│   ├── preload.js                 # 预加载脚本 (IPC 桥接)
│   └── src/
│       ├── index.html             # SPA 入口（播放器页）
│       ├── overlay.html           # 悬浮窗 HTML
│       ├── styles/
│       │   ├── main.css           # 主界面样式（深色主题）
│       │   ├── overlay.css        # 悬浮窗样式（毛玻璃）
│       │   └── card.css           # 单词卡片样式
│       └── scripts/
│           ├── router.js          # Hash Router (3 路由)
│           ├── app.js             # 应用入口
│           ├── player.js          # 播放器 + 字幕同步 (397行)
│           ├── overlay.js         # 悬浮窗前端脚本
│           ├── card.js            # 单词卡片 (FloatingCard)
│           ├── review.js          # 生词复习页
│           ├── subtitle.js        # SRT/VTT 解析器
│           ├── api.js             # API 封装层
│           └── storage.js         # IndexedDB 本地缓存
│
├── python-backend/                # 后端（FastAPI）
│   ├── main.py                    # FastAPI 应用入口
│   ├── config.py                  # 配置管理
│   ├── requirements.txt           # Python 依赖
│   ├── api/
│   │   ├── health.py              # GET /api/health
│   │   ├── audio.py               # 音频相关 API
│   │   ├── transcription.py       # 转录相关 API
│   │   ├── vocabulary.py          # 生词 CRUD API (8 端点)
│   │   └── websocket.py           # 实时字幕 WebSocket
│   ├── audio/
│   │   ├── capture.py             # WASAPI Loopback + 麦克风采集
│   │   └── source_manager.py      # 音频源管理器
│   ├── transcription/
│   │   ├── whisper_engine.py      # Whisper 模型封装
│   │   ├── transcriber.py         # 转录引擎
│   │   ├── audio_buffer.py        # 音频缓冲区
│   │   └── simulator.py           # 实时字幕模拟器（开发用）
│   ├── database/
│   │   ├── models.py              # SQLAlchemy 模型
│   │   ├── crud.py                # CRUD 操作
│   │   ├── migrations.py          # 数据库迁移
│   │   └── backup.py              # 数据库备份
│   └── schemas/
│       ├── audio.py               # 音频 Pydantic 模型
│       ├── transcription.py       # 转录 Pydantic 模型
│       └── vocabulary.py          # 生词 Pydantic 模型
│
├── docs/                          # 文档
│   ├── ARCHITECTURE.md            # 系统架构文档
│   ├── REQUIREMENTS.md            # 开发任务清单
│   ├── phase1-frontend-spec.md    # 前端规格
│   └── plan-b3-b4-s2.md          # Phase 2 开发计划
│
└── scripts/
    └── sync-issues-to-kanban.py   # Kanban 同步脚本
```

---

## 开发指南

### 环境要求

- Node.js 18+
- Python 3.11+
- Git for Windows (`D:\Program Files\Git\bin\bash.exe`)
- Windows 11（WASAPI 音频采集依赖 Windows 音频 API）

### 快速启动

```bash
# 1. 安装依赖
npm install
cd python-backend && pip install -r requirements.txt && cd ..

# 2. 一键启动（前后端同时）
npm run dev
# 前端: http://localhost:5173
# 后端: http://localhost:8000
# API 文档: http://localhost:8000/docs

# 3. Electron 桌面模式
npm run electron:dev
```

### 开发命令

```bash
npm run dev              # 前后端同时启动
npm run dev:frontend     # 仅前端 (Vite dev server)
npm run dev:backend      # 仅后端 (uvicorn reload)
npm run electron:dev     # Electron 桌面模式
npm run build            # 前端打包
```

### 后端单独运行

```bash
cd python-backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

### 运行测试

```bash
cd python-backend
pytest tests/ -v
```

---

## 编码规范

### 通用

- 中文注释，英文代码（变量名、函数名用英文）
- 字符串用双引号（Python）和单引号（JS）
- commit message 用英文，格式：`type(scope): description`
- 统一缩进：Python 4空格，JS/CSS 2空格

### Python (后端)

- 使用 f-string，不用 `%` 或 `.format()`
- import 顺序：标准库 → 第三方 → 本地模块
- 类型注解：所有函数参数和返回值必须标注类型
- 异步优先：IO 操作用 `async/await`
- Pydantic v2 风格（`model_validate` 而非 `from_orm`）

### JavaScript (前端)

- 使用 `const` / `let`，不用 `var`
- 使用 `async/await`，不用裸 `.then()`
- DOM 操作用原生 API，不用 jQuery
- 事件监听用 `addEventListener`，不用 `onclick` 属性
- 函数名用 camelCase，常量用 UPPER_SNAKE_CASE

### CSS

- 深色主题优先（`background: #1a1a2e` 基调）
- 使用 CSS 变量管理配色
- 毛玻璃效果：`backdrop-filter: blur(10px)`
- class 命名：kebab-case

### Git

- 分支策略：`main`（稳定） ← `develop`（开发） ← `feature/xxx`
- commit 类型：`feat:` / `fix:` / `refactor:` / `docs:` / `chore:` / `test:`
- PR 需要至少 1 个 review 通过才能合并
- pre-push hook 自动运行 flake8 + 语法检查

---

## 数据库

- 引擎：SQLite + WAL 模式
- ORM：SQLAlchemy 2.0（声明式映射）
- 模型文件：`python-backend/database/models.py`
- 迁移：`python-backend/database/migrations.py`（手动触发）

### 核心表

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `vocab` | 生词表 | word, translation, phonetic, part_of_speech |
| `subtitles` | 字幕表 | text, start_time, end_time, language |
| `learning_records` | 学习记录 | review_count, correct_count, next_review_at, mastered |

---

## API 端点总览

| 方法 | 路径 | 说明 | 状态 |
|------|------|------|------|
| GET | `/api/health` | 健康检查 | ✅ |
| GET | `/api/vocab` | 生词列表（分页+搜索） | ✅ |
| POST | `/api/vocab` | 添加生词 | ✅ |
| GET | `/api/vocab/{id}` | 生词详情 | ✅ |
| PUT | `/api/vocab/{id}` | 更新生词 | ✅ |
| DELETE | `/api/vocab/{id}` | 删除生词 | ✅ |
| POST | `/api/vocab/{id}/review` | 记录复习 | ✅ |
| GET | `/api/vocab/due/list` | 待复习列表 | ✅ |
| GET | `/api/vocab/stats/summary` | 学习统计 | ✅ |
| GET | `/api/audio/sources` | 音频源列表 | ✅ |
| GET | `/api/audio/devices` | 音频设备列表 | ✅ |
| GET | `/api/audio/source/status` | 音频源状态 | ✅ |
| POST | `/api/audio/source/switch` | 切换音频源 | ✅ |
| WS | `/api/ws/subtitle/realtime` | 实时字幕流 | ✅ |
| WS | `/api/ws/audio/status` | 音频状态推送 | ✅ |

---

## 多 Agent 协作规则（Feishu 群聊）

本项目通过飞书群聊 `oc_33c9e0399cd59fd6a2012218ec8aff26` 中的 Agent 协作开发，分两个部门：

### 🎯 产品创意部

| Agent | 角色 | 职责 |
|-------|------|------|
| 📋 **PM** | 产品经理 | 需求定义、用户调研、功能优先级排序、产品路线图 |
| 🚀 **创业者** | 创业者 | 商业战略、创新驱动、第一性原理思考、市场定位 |
| 📐 **执行策划** | 执行策划 | 执行方案设计、任务拆解、时间线管理、资源协调 |

### ⚙️ 技术开发部

| Agent | 角色 | 职责 |
|-------|------|------|
| 🏗️ **Architect** | 架构师 | 系统设计、架构决策、代码审核、任务分派 |
| 💻 **Developer** | 开发者 | 编码实现、功能开发、Bug 修复 |
| 👀 **Reviewer** | 审查者 | 代码审查、测试覆盖、质量把关 |
| 🔧 **DevOps** | 运维 | CI/CD、基础设施、环境配置、文档维护 |

### 协作规则

1. **@mention 格式**：Agent 间引用必须用 `@open_id` 格式（如 `@ou_aae937ad9b3a9d03c889924c518c0685`），不能用纯文本 @名字
2. **跨部门协作**：产品创意部定义需求 → 技术开发部实现，通过看板流转
3. **超时接管**：Agent 沉默 30 分钟无响应 → PM 或 Architect 视部门接管任务
4. **看板驱动**：使用 Kanban 看板 `linguacaption` 追踪任务进度
5. **状态同步**：每次提交更新 `docs/REQUIREMENTS.md`
6. **任务依赖**：遵循任务依赖链，阻塞任务及时标记并通知上下游

---

## 当前状态

- ✅ Phase 1 MVP — 基础骨架 + 数据库 + Vocab API + 点读界面
- ✅ Phase 2 — 悬浮字幕系统（Overlay + WASAPI 采集 + Whisper 转录）
- 🔜 Phase 3 — 功能完善 + 发布准备

---

## 安全注意事项

- API keys 存放在 `.env` 文件中，不提交到 Git
- 所有配置文件路径使用 `config.py` 统一管理
- 音频数据仅本地处理，不上传云端
- 数据库路径：`python-backend/data/linguacaption.db`
