# LinguaCaption — 实时字幕英语学习助手

通过观看外语视频/音频，实时字幕 + 点查生词 + 间隔重复复习，沉浸式学英语。

## 快速开始

```bash
# 安装依赖
npm install
cd python-backend && pip install -r requirements.txt && cd ..

# 一键启动（前后端同时）
npm run dev
```

启动后：
- 前端：http://localhost:5173
- 后端：http://localhost:8000
- API 文档：http://localhost:8000/docs

## 功能

| 功能 | 说明 |
|------|------|
| 🎬 视频/音频播放 | 加载本地媒体文件 + SRT/VTT 字幕 |
| 📝 实时字幕同步 | 逐行高亮、自动滚动、两种模式切换 |
| 👆 单词点读 | 点击单词发音（TTS + API 音频段） |
| 📖 悬浮词卡 | 音标、释义、例句、上下文，0.3s 延迟弹出 |
| ⭐ 生词收藏 | 一键收藏到生词本，自动去重 |
| 🔄 间隔重复复习 | 1d→3d→7d→14d→30d 递减复习 |
| 🌐 实时字幕（即将推出） | WebSocket + Whisper 实时转录 |

## 技术栈

```
Frontend:  Electron 32 + Vite 6 + Vanilla JS (SPA)
Backend:   Python 3.11+ / FastAPI / SQLAlchemy / SQLite
Real-time: WebSocket (FastAPI)
Transcribe: OpenAI Whisper (本地模型)
```

## 项目结构

```
LinguaCaption/
├── electron/src/           # 前端源码
│   ├── index.html          # SPA 入口
│   ├── scripts/
│   │   ├── router.js       # Hash Router (3 条路由)
│   │   ├── player.js       # 播放器 + 字幕 + 词卡
│   │   ├── review.js       # 生词复习页
│   │   ├── storage.js      # IndexedDB 本地存储
│   │   ├── subtitle.js     # SRT/VTT 解析
│   │   └── api.js          # API 封装层
│   └── styles/main.css     # 深色主题
├── python-backend/         # FastAPI 后端
│   ├── api/                # REST + WebSocket 端点
│   ├── database/           # SQLite 模型 + CRUD
│   └── schemas/            # Pydantic 模型
├── docs/                   # 架构文档 + 前端规格
└── scripts/                # Git 钩子脚本
```

## 开发

```bash
# 单独启动前端
npm run dev:frontend

# 单独启动后端
npm run dev:backend

# Electron 桌面模式
npm run electron:dev

# 代码检查
npm run lint

# 运行测试
cd python-backend && pytest tests/ -v
```

## 许可

MIT
