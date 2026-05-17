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
# 一键启动前后端（推荐）
npm run dev

# 单独启动前端
npm run dev:frontend

# 单独启动后端
npm run dev:backend

# 后端单独debug启动（使用debugpy，端口5678）
# Bash/Linux:
cd python-backend && python -m debugpy --listen 0.0.0.0:5678 --wait-for-client -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
# PowerShell/Windows:
pip install debugpy

cd python-backend; python -m debugpy --listen 0.0.0.0:5678 --wait-for-client -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Electron 桌面模式
npm run electron:dev

# 运行测试
cd python-backend && pytest tests/ -v
```

## VS Code 调试配置

### 前置条件

1. 安装 VS Code 扩展：
   - **Python** (Microsoft) - 用于后端调试
   - **Node.js** (Microsoft) - 用于前端调试

### 创建调试配置文件

在项目根目录创建 `.vscode/launch.json` 文件：

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "前端调试 (Vite)",
            "type": "node",
            "request": "launch",
            "runtimeExecutable": "npm",
            "runtimeArgs": ["run", "dev:frontend"],
            "cwd": "${workspaceFolder}",
            "console": "integratedTerminal",
            "skipFiles": ["<node_internals>/**"]
        },
        {
            "name": "后端调试 (FastAPI)",
            "type": "python",
            "request": "launch",
            "program": "${workspaceFolder}/python-backend/main.py",
            "cwd": "${workspaceFolder}/python-backend",
            "env": {
                "PYTHONPATH": "${workspaceFolder}/python-backend"
            },
            "console": "integratedTerminal",
            "justMyCode": true
        }
    ],
    "compounds": [
        {
            "name": "双端同时调试 (推荐)",
            "configurations": ["前端调试 (Vite)", "后端调试 (FastAPI)"],
            "stopAll": true
        }
    ]
}
```

### 使用方法

1. 打开 VS Code 的"运行和调试"面板（快捷键：`Ctrl+Shift+D`）
2. 从下拉菜单选择调试配置：
   - **前端调试 (Vite)**：仅启动前端调试
   - **后端调试 (FastAPI)**：仅启动后端调试
   - **双端同时调试 (推荐)**：同时启动前后端调试
3. 点击绿色的"开始调试"按钮（快捷键：`F5`）

### 调试技巧

- **设置断点**：在代码行左侧点击即可设置断点（红色圆点）
- **条件断点**：右键断点 → "编辑条件断点"，设置触发条件
- **监视表达式**：在调试面板中添加变量或表达式进行实时监控
- **步进调试**：
  - `F10`：单步跳过（不进入函数）
  - `F11`：单步进入（进入函数）
  - `Shift+F11`：单步跳出（从函数返回）

## 许可

MIT
