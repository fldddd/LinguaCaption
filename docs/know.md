LinguaCaption 项目知识讲解
一、Electron 桌面开发知识
1.1 Electron 是什么？
Electron = Chromium（浏览器内核） + Node.js（后端能力） + Native API（系统调用）

它让你用 Web 技术（HTML/CSS/JS） 开发跨平台桌面应用，一套代码同时打包 Windows、macOS、Linux。

code

复制
┌─────────────────────────────────────┐
│ Electron 应用 │
├─────────────────────────────────────┤
│ 渲染进程（Chromium） │ ← 前端 UI，就是你写的网页
│ - index.html │
│ - CSS / JavaScript │
│ - 可以调用 Node.js（通过 preload） │
├─────────────────────────────────────┤
│ 主进程（Node.js） │ ← 后端逻辑，控制窗口、文件、系统
│ - main.js │
│ - 创建 BrowserWindow │
│ - IPC 通信 │
│ - 系统托盘、快捷键、原生对话框 │
└─────────────────────────────────────┘
1.2 LinguaCaption 的 Electron 架构
从 electron/main.js 可以看到几个关键模式：

(1) 主窗口创建
javascript

复制
function createWindow() {
 mainWindow = new BrowserWindow({
 width: 1280,
 height: 800,
 webPreferences: {
 preload: path.join(__dirname, 'preload.js'), // ← 安全桥梁
 contextIsolation: true, // ← 隔离渲染进程的 JS 上下文
 nodeIntegration: false, // ← 禁用渲染进程直接 require Node 模块
 },
 });
 
 // 开发模式：加载 Vite dev server
 if (isDev) {
 mainWindow.loadURL('http://localhost:5173');
 mainWindow.webContents.openDevTools(); // 自动打开 DevTools
 } else {
 // 生产模式：加载打包后的静态文件
 mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
 }
}
关键概念：

contextIsolation: true — 安全隔离，防止渲染进程污染 Node.js 上下文
preload.js — 唯一能同时访问 Node.js 和 DOM 的桥梁，暴露安全 API 给前端
(2) IPC 通信（进程间通信）
Electron 有两个进程，它们通过 IPC（Inter-Process Communication） 通信：

code

复制
渲染进程（前端） ←→ 主进程
 │ │
 │ ipcRenderer.invoke() │
 │ ───────────────────→ │ ipcMain.handle()
 │ │
 │ ipcRenderer.on() │
 │ ←─────────────────── │ mainWindow.webContents.send()
LinguaCaption 中的例子：

javascript

复制
// 主进程监听：打开文件对话框
ipcMain.handle('dialog:openMedia', async () => {
 const result = await dialog.showOpenDialog(mainWindow, {
 filters: [{ name: 'Media Files', extensions: ['mp4', 'mp3', 'wav'] }],
 });
 return result.filePaths[0];
});

// 渲染进程调用（通过 preload 暴露的 API）
const filePath = await window.api.dialog.openMedia();
(3) 系统托盘
javascript

复制
const { Tray, Menu, nativeImage } = require('electron');

// 创建托盘图标
tray = new Tray(nativeImage.createFromBuffer(iconBuffer));

// 托盘右键菜单
const contextMenu = Menu.buildFromTemplate([
 { label: '显示/隐藏悬浮窗', click: () => overlay.toggleOverlay() },
 { label: '退出', click: () => app.quit() },
]);
tray.setContextMenu(contextMenu);
状态指示： 用不同颜色图标表示状态（绿色=转录中，灰色=暂停，红色=断开）

(4) 全局快捷键
javascript

复制
const { globalShortcut } = require('electron');

app.whenReady().then(() => {
 // Ctrl+Shift+S: 切换转录
 globalShortcut.register('CommandOrControl+Shift+S', () => {
 mainWindow.webContents.send('transcription:toggle');
 });
});
(5) 悬浮窗口
javascript

复制
overlayWindow = new BrowserWindow({
 transparent: true, // 透明背景
 frame: false, // 无边框
 alwaysOnTop: true, // 始终置顶
 skipTaskbar: true, // 不在任务栏显示
 type: 'toolbar', // Windows 上避免抢焦点
});
这是桌面歌词风格的悬浮字幕条，可以在看视频时显示实时字幕。

二、项目设计架构
2.1 整体架构
code

复制
┌────────────────────────────────────────────────────────────┐
│ LinguaCaption │
├────────────────────────────────────────────────────────────┤
│ │
│ ┌──────────────┐ ┌──────────────────────┐ │
│ │ Electron │ │ Python FastAPI │ │
│ │ 前端 UI │ ←HTTP→ │ 后端服务 │ │
│ │ │ ←WS→ │ │ │
│ │ - 播放器 │ │ - Whisper 转录 │ │
│ │ - 字幕同步 │ │ - 词汇管理 │ │
│ │ - 词卡悬浮 │ │ - 音频采集 │ │
│ │ - IndexedDB │ │ - SQLite 存储 │ │
│ └──────────────┘ └──────────────────────┘ │
│ │ │ │
│ │ │ │
│ ┌──────▼──────┐ ┌──────▼──────┐ │
│ │ Vite 6 │ │ uvicorn │ │
│ │ 热更新 │ │ ASGI 服务器 │ │
│ └─────────────┘ └─────────────┘ │
│ │
└────────────────────────────────────────────────────────────┘
2.2 技术栈选型理由
层	技术	选型理由
桌面框架	Electron 33	跨平台、Web 技术栈、丰富生态
前端构建	Vite 6	极速 HMR、原生 ESM、简洁配置
前端框架	Vanilla JS	轻量、无框架开销、适合小项目
后端框架	FastAPI	异步、自动 API 文档、类型安全
数据库	SQLite	嵌入式、零配置、适合桌面应用
转录引擎	Whisper	OpenAI 开源、支持本地运行、多语言
实时通信	WebSocket	双向通信、低延迟、适合实时字幕
2.3 数据流设计
code

复制
用户操作 → 前端 UI → HTTP/WebSocket → Python 后端 → 处理 → 返回结果

具体例子：点读单词
1. 用户点击字幕中的单词
2. 前端发送 GET /api/vocabulary/lookup?word=hello
3. 后端查询词典 API（如有）或本地词典
4. 返回 { word, phonetic, meaning, examples }
5. 前端渲染悬浮词卡
2.4 功能模块划分
code

复制
前端（Electron 渲染进程）
├── router.js — Hash Router，3 条路由（/watch, /point, /review）
├── player.js — 播放器 + 字幕同步 + 词卡触发
├── subtitle.js — SRT/VTT 解析器
├── SubtitleDisplay.js — 字幕渲染 + 高亮 + 滚动
├── review.js — 间隔重复复习页
├── storage.js — IndexedDB 本地存储（生词本）
└── api.js — HTTP/WebSocket 封装

后端
├── api/
│ ├── audio.py — 音频上传/管理
│ ├── transcription.py — Whisper 转录任务
│ ├── vocabulary.py — 词汇查询/收藏
│ ├── websocket.py — 实时字幕流
│ └── video.py — 视频处理
├── audio/
│ ├── capture.py — WASAPI Loopback 系统音频采集
│ └── source_manager.py — 音频源管理
├── transcription/
│ ├── buffer.py — 音频缓冲
│ └── whisper_engine.py — Whisper 推理
└── database/
 └── models.py — SQLite ORM 模型
三、Web 开发知识
3.1 Hash Router（前端路由）
javascript

复制
// router.js — 简单 Hash Router
function handleRoute() {
 const hash = window.location.hash || '#/watch';
 const route = hash.slice(2); // 去掉 '#/'
 
 switch (route) {
 case 'watch': loadWatchPage(); break;
 case 'point': loadPointPage(); break;
 case 'review': loadReviewPage(); break;
 }
}

window.addEventListener('hashchange', handleRoute);
为什么用 Hash Router？

不需要服务器配置（SPA 单页应用）
Electron 加载本地文件时，History API 有路径问题
简单、够用
3.2 IndexedDB 本地存储
javascript

复制
// storage.js — IndexedDB 封装
const DB_NAME = 'LinguaCaption';
const STORE_NAME = 'vocabulary';

function openDB() {
 return new Promise((resolve, reject) => {
 const request = indexedDB.open(DB_NAME, 1);
 request.onupgradeneeded = (e) => {
 const db = e.target.result;
 db.createObjectStore(STORE_NAME, { keyPath: 'word' });
 };
 request.onsuccess = (e) => resolve(e.target.result);
 });
}

async function addWord(word, data) {
 const db = await openDB();
 const tx = db.transaction(STORE_NAME, 'readwrite');
 tx.objectStore(STORE_NAME).put({ word, ...data, addedAt: Date.now() });
}
为什么用 IndexedDB？

存储容量大（几百 MB），比 localStorage 大得多
支持索引、事务
适合存储生词本、学习记录
3.3 WebSocket 实时通信
python

复制
# websocket.py — FastAPI WebSocket 端点
@router.websocket("/subtitle/stream")
async def websocket_subtitle(ws: WebSocket):
 await ws.accept()
 
 while True:
 # 接收音频数据
 audio_data = await ws.receive_bytes()
 
 # Whisper 转录
 text = await whisper_engine.transcribe(audio_data)
 
 # 推送字幕
 await ws.send_json({
 "type": "subtitle",
 "text": text,
 "timestamp": time.time()
 })
javascript

复制
// 前端连接
const ws = new WebSocket('ws://localhost:8000/api/ws/subtitle/stream');
ws.onmessage = (e) => {
 const data = JSON.parse(e.data);
 if (data.type === 'subtitle') {
 renderSubtitle(data.text);
 }
};