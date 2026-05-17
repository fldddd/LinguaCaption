const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const overlay = require('./overlay');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'LinguaCaption',
  });

  // Dev: load from Vite dev server; Prod: load built files
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── System Tray ──────────────────────────────────────────
// F4.5: 托盘图标状态指示 (绿色=转录中, 灰色=已暂停, 红色=断开)

/** @type {Tray|null} */
let tray = null;

/** @type {'transcribing'|'paused'|'disconnected'|'idle'} */
let trayStatus = 'idle';

// 16x16 彩色圆点 PNG (base64) — 用 Python 生成
const TRAY_ICONS = {
  green: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR4nGNgoDZQOhr3Hx+mSDNeQ4jVjNUQUjVjGDJqwLAwgIHShESVpEysIXg1kwMAA8mFwC7+rqsAAAAASUVORK5CYII=',
  gray:  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAM0lEQVR4nGNgoDaYs3j9f3yYIs14DSFWM1ZDSNWMYcioAcPCAAZKExJVkjKxhuDVTA4AAAoE90zweg3lAAAAAElFTkSuQmCC',
  red:   'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMklEQVR4nGNgoDZ47+LyHx+mSDNeQ4jVjNUQUjVjGDJqwLAwgIHShESVpEysIXg1kwMA8IWnWP31KqAAAAAASUVORK5CYII=',
};

function createTrayIcon(base64Png) {
  return nativeImage.createFromBuffer(
    Buffer.from(base64Png, 'base64'),
    { width: 16, height: 16 }
  );
}

function updateTrayIcon(status) {
  if (!tray) return;
  trayStatus = status || 'idle';
  switch (trayStatus) {
    case 'transcribing':
    case 'listening':
      tray.setImage(createTrayIcon(TRAY_ICONS.green));
      tray.setToolTip('LinguaCaption - 转录中');
      break;
    case 'paused':
      tray.setImage(createTrayIcon(TRAY_ICONS.gray));
      tray.setToolTip('LinguaCaption - 已暂停');
      break;
    case 'disconnected':
    case 'error':
      tray.setImage(createTrayIcon(TRAY_ICONS.red));
      tray.setToolTip('LinguaCaption - 已断开');
      break;
    default:
      tray.setImage(createTrayIcon(TRAY_ICONS.green));
      tray.setToolTip('LinguaCaption - 悬浮字幕');
  }
}

function setupTray() {
  tray = new Tray(createTrayIcon(TRAY_ICONS.green));
  tray.setToolTip('LinguaCaption - 悬浮字幕');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示/隐藏悬浮窗',
      click: () => overlay.toggleOverlay(),
    },
    { type: 'separator' },
    {
      label: '开始/暂停转录',
      click: () => mainWindow && mainWindow.webContents.send('transcription:toggle'),
    },
    {
      label: '设置',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.webContents.send('navigate', '/settings');
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        global.__appQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ── Global Shortcuts ────────────────────────────────────

function setupGlobalShortcuts() {
  // Ctrl+Shift+S: 切换转录
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcription:toggle');
    }
  });

  // Ctrl+Shift+H: 显示/隐藏悬浮窗
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    overlay.toggleOverlay();
  });
}

// ── IPC Handlers ──────────────────────────────────────────

// Open file dialog for selecting media files
ipcMain.handle('dialog:openMedia', async (_event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: defaultPath || undefined,
    properties: ['openFile'],
    filters: [
      { name: 'Media Files', extensions: ['mp4', 'mkv', 'webm', 'mp3', 'wav', 'm4a', 'ogg'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// Open file dialog for selecting subtitle files
ipcMain.handle('dialog:openSubtitle', async (_event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    defaultPath: defaultPath || undefined,
    properties: ['openFile'],
    filters: [
      { name: 'Subtitle Files', extensions: ['srt', 'vtt', 'ass', 'ssa'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// Open directory picker for selecting a folder
ipcMain.handle('dialog:selectDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// ── F4.5: 托盘图标状态切换 ──────────────────────────────
// 主窗口渲染进程将从 Python 后端收到的状态转发到这里
ipcMain.on('tray:setStatus', (_event, status) => {
  updateTrayIcon(status);
  // 同时转发给 overlay 窗口，保持状态同步
  if (status && status.type) {
    overlay.sendStatus(status);
  } else if (typeof status === 'string') {
    overlay.sendStatus({ type: status });
  }
});

// ── App Lifecycle ────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();

  // 注册 overlay IPC 处理器
  overlay.registerIpcHandlers();

  // 创建悬浮窗（预先创建，初始隐藏）
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  overlay.createOverlay(isDev);
  overlay.hideOverlay();

  // 系统托盘
  setupTray();

  // 全局快捷键
  setupGlobalShortcuts();
});

app.on('window-all-closed', () => {
  // 如果 overlay 窗口还活着，不退出
  if (overlay.getOverlay() && !overlay.getOverlay().isDestroyed()) {
    // 只处理 mainWindow 关闭，不退出程序
  } else if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
