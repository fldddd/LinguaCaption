const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Dialog ──
  openMedia: () => ipcRenderer.invoke('dialog:openMedia'),
  openSubtitle: () => ipcRenderer.invoke('dialog:openSubtitle'),

  // ── Overlay Window ──
  overlayShow: () => ipcRenderer.send('overlay:show'),
  overlayHide: () => ipcRenderer.send('overlay:hide'),
  overlayToggle: () => ipcRenderer.send('overlay:toggle'),

  /** 向主进程发送窗口位置更新 */
  setOverlayPosition: (x, y) => ipcRenderer.send('overlay:setPosition', x, y),

  /** 获取主进程保存的窗口位置 */
  getOverlayPosition: () => ipcRenderer.invoke('overlay:getPosition'),

  /** 获取屏幕尺寸 */
  getScreenSize: () => ipcRenderer.invoke('overlay:getScreenSize'),

  // ── Transcription control ──
  toggleTranscription: () => ipcRenderer.send('transcription:toggle'),

  // ── F4.5: 转录状态通知（主窗口 → 主进程 → 托盘图标 + overlay）──
  /** 通知主进程转录状态变更（'transcribing'|'paused'|'disconnected'|'idle'） */
  setTrayStatus: (status) => ipcRenderer.send('tray:setStatus', status),

  // ── F2-NEW: Subtitles / Status pushed from main process ──
  /** 监听主进程推送的字幕文本 */
  onOverlaySubtitle: (callback) => {
    const handler = (_event, text) => callback(text);
    ipcRenderer.on('overlay:subtitle', handler);
    return () => ipcRenderer.removeListener('overlay:subtitle', handler);
  },

  /** 监听主进程推送的转录状态 */
  onOverlayStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('overlay:status', handler);
    return () => ipcRenderer.removeListener('overlay:status', handler);
  },

  /** 监听迷你模式切换 */
  onToggleMini: (callback) => {
    const handler = (_event, forceState) => callback(forceState);
    ipcRenderer.on('overlay:toggleMini', handler);
    return () => ipcRenderer.removeListener('overlay:toggleMini', handler);
  },

  // ── F2-NEW: Actions from overlay toolbar ──
  /** 复制文本到剪贴板 */
  copyToClipboard: (text) => ipcRenderer.invoke('overlay:clipboard:copy', text),

  /** 收藏单词/句子 */
  favoriteWord: (word) => ipcRenderer.invoke('overlay:favorite:word', word),

  /** 打开设置窗口 */
  openSettings: () => ipcRenderer.send('overlay:settings:open'),

  /** 获取当前音频电平数据 */
  onVolumeLevel: (callback) => {
    const handler = (_event, level) => callback(level);
    ipcRenderer.on('overlay:volume', handler);
    return () => ipcRenderer.removeListener('overlay:volume', handler);
  },

  // ── F3-NEW: 单词释义卡片 IPC 通道 ──

  /** 通知渲染进程显示单词卡片 */
  onWordCardShow: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('wordCard:show', handler);
    return () => ipcRenderer.removeListener('wordCard:show', handler);
  },

  /** 通知渲染进程隐藏单词卡片 */
  onWordCardHide: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('wordCard:hide', handler);
    return () => ipcRenderer.removeListener('wordCard:hide', handler);
  },

  /** 渲染进程请求隐藏单词卡片 */
  hideWordCard: () => ipcRenderer.send('wordCard:hide'),

  /** 收藏单词（通过主进程转发） */
  favoriteWordCard: (wordData) => ipcRenderer.invoke('wordCard:favorite', wordData),

  /** 播放发音（通过主进程/Web Speech API） */
  pronounceWordCard: (word) => ipcRenderer.invoke('wordCard:pronounce', word),
});
