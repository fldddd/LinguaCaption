/**
 * LinguaCaption — Electron 悬浮字幕窗口 (Overlay)
 *
 * 无边框半透明悬浮窗，桌面歌词风格，始终置顶。
 * 通过 IPC 接口由主进程控制显示/隐藏/位置。
 */

const { BrowserWindow, ipcMain, screen, clipboard } = require('electron');
const path = require('path');

/** @type {BrowserWindow|null} */
let overlayWindow = null;

/**
 * 创建（或重建）悬浮字幕窗口
 * @param {boolean} isDev 是否开发模式（从 Vite dev server 加载）
 * @returns {BrowserWindow}
 */
function createOverlay(isDev = false) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  overlayWindow = new BrowserWindow({
    width: screenWidth,
    height: 80,
    x: 0,
    y: screenHeight - 80,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    type: 'toolbar',    // 在 Windows 上避免抢焦点
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 点击穿透 — 仅当拖拽时才接收鼠标事件
  overlayWindow.setIgnoreMouseEvents(false);

  // 加载页面
  if (isDev) {
    overlayWindow.loadURL('http://localhost:5173/overlay.html');
  } else {
    overlayWindow.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  }

  // 关闭行为：隐藏而非销毁
  overlayWindow.on('close', (event) => {
    if (!global.__appQuitting) {
      event.preventDefault();
      overlayWindow.hide();
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

// ── IPC 处理 ──────────────────────────────────────────

/**
 * 在主进程注册 overlay 相关的 IPC handler
 */
function registerIpcHandlers() {
  // 设置窗口位置
  ipcMain.on('overlay:setPosition', (_event, x, y) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.setPosition(Math.round(x), Math.round(y));
    }
  });

  // 获取窗口当前位置
  ipcMain.handle('overlay:getPosition', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      return overlayWindow.getPosition();
    }
    return [0, 0];
  });

  // 获取屏幕尺寸
  ipcMain.handle('overlay:getScreenSize', () => {
    const primaryDisplay = screen.getPrimaryDisplay();
    return primaryDisplay.workAreaSize;
  });

  // 显示悬浮窗
  ipcMain.on('overlay:show', () => {
    showOverlay();
  });

  // 隐藏悬浮窗
  ipcMain.on('overlay:hide', () => {
    hideOverlay();
  });

  // 切换悬浮窗显示/隐藏
  ipcMain.on('overlay:toggle', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      if (overlayWindow.isVisible()) {
        hideOverlay();
      } else {
        showOverlay();
      }
    }
  });

  // ── F2-NEW: 复制到剪贴板 ──
  ipcMain.handle('overlay:clipboard:copy', (_event, text) => {
    if (text) {
      clipboard.writeText(text);
      return true;
    }
    return false;
  });

  // ── F2-NEW: 收藏单词 ──
  ipcMain.handle('overlay:favorite:word', (_event, word) => {
    // 将事件转发到主窗口（由主窗口的 Python 桥接处理）
    const { BrowserWindow: BW } = require('electron');
    const mainWin = BW.getAllWindows().find(w => w !== overlayWindow);
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('vocabulary:favorite', word);
    }
    return true;
  });

  // ── F2-NEW: 打开设置 ──
  ipcMain.on('overlay:settings:open', () => {
    const { BrowserWindow: BW } = require('electron');
    const mainWin = BW.getAllWindows().find(w => w !== overlayWindow);
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.show();
      mainWin.webContents.send('navigate', '/settings');
    }
  });

  // ── F3-NEW: 单词释义卡片 IPC ──

  /** 渲染进程请求隐藏卡片 → 转发到自身（或由渲染进程直接处理） */
  ipcMain.on('wordCard:hide', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('wordCard:hide');
    }
  });

  /** 收藏单词（从卡片） */
  ipcMain.handle('wordCard:favorite', (_event, wordData) => {
    // 转发到主窗口的前端逻辑
    const { BrowserWindow: BW } = require('electron');
    const mainWin = BW.getAllWindows().find(w => w !== overlayWindow);
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('vocabulary:favorite', wordData);
    }
    return true;
  });

  /** 播放单词发音（IPC 方式，实际 card.js 使用 Web Speech API 直接处理） */
  ipcMain.handle('wordCard:pronounce', (_event, word) => {
    // 渲染进程在 card.js 中直接用 Web Speech API 处理
    // 这里只是一个 IPC 通道以备未来扩展
    return true;
  });
}

// ── F2-NEW: 推送数据到 overlay 渲染进程 ──

/**
 * 推送字幕文本到悬浮窗
 * @param {string} text
 */
function sendSubtitle(text) {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.webContents.send('overlay:subtitle', text);
  }
}

/**
 * 推送转录状态
 * @param {{ type: 'transcribing'|'paused'|'disconnected' }} status
 */
function sendStatus(status) {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.webContents.send('overlay:status', status);
  }
}

/**
 * 切换迷你模式
 * @param {boolean} [forceState] - 若指定，强制设为该状态
 */
function toggleMiniMode(forceState) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:toggleMini', forceState);
  }
}

/**
 * 推送音频电平数据
 * @param {number} level 0.0 ~ 1.0
 */
function sendVolumeLevel(level) {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.webContents.send('overlay:volume', level);
  }
}

// ── Public API ────────────────────────────────────────

function showOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlay(process.env.NODE_ENV === 'development' || process.argv.includes('--dev'));
  }
  overlayWindow.show();
  overlayWindow.setIgnoreMouseEvents(false);
}

function hideOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
}

function toggleOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    hideOverlay();
  } else {
    showOverlay();
  }
}

function getOverlay() {
  return overlayWindow;
}

module.exports = {
  createOverlay,
  registerIpcHandlers,
  showOverlay,
  hideOverlay,
  toggleOverlay,
  getOverlay,
  // F2-NEW exports
  sendSubtitle,
  sendStatus,
  toggleMiniMode,
  sendVolumeLevel,
};
