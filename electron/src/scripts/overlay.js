/**
 * LinguaCaption — 悬浮字幕窗口前端脚本 (F2-NEW 字幕条UI)
 *
 * 功能:
 *   1. 鼠标拖拽窗口 (mousedown/mousemove/mouseup)
 *   2. 边缘吸附 (<20px 自动对齐 + 缓动)
 *   3. 窗口位置 localStorage 记忆，启动时恢复
 *   4. 状态指示灯
 *   5. 字幕文本更新接口（单词级渲染）
 *   6. 工具栏：收藏/复制/设置/音量/暂停/折叠
 *   7. 迷你模式折叠/展开
 *   8. 单词高亮（生词收藏）
 *   9. IPC 监听主进程推送
 */

// =============================================================
// 常量 / 状态
// =============================================================

const SNAP_THRESHOLD = 20;         // px — 距离屏幕边缘多少像素触发吸附
const STORAGE_KEY = 'overlay_position';
const MINI_STORAGE_KEY = 'overlay_mini_mode';
const DRAG_HANDLE_ID = 'drag-handle';

/** @type {{ x: number, y: number, w: number, h: number }} */
let screen = { x: 0, y: 0, w: 1920, h: 1080 };

let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

// UI 状态
let isPaused = false;
let isMiniMode = false;
let currentText = '';
/** @type {Set<string>} 已收藏（高亮）的单词 */
let highlightedWords = new Set();

// DOM refs
let container;
let dragHandle;
let subtitleText;
let statusDot;
let toolbar;
let btnFavorite;
let btnCopy;
let btnSettings;
let volumeIndicator;
let btnPause;
let btnCollapse;

// =============================================================
// 初始化
// =============================================================

document.addEventListener('DOMContentLoaded', async () => {
  container = document.getElementById('overlay-container');
  dragHandle = document.getElementById(DRAG_HANDLE_ID);
  subtitleText = document.getElementById('subtitle-text');
  statusDot = document.getElementById('status-dot');
  toolbar = document.getElementById('toolbar');
  btnFavorite = document.getElementById('btn-favorite');
  btnCopy = document.getElementById('btn-copy');
  btnSettings = document.getElementById('btn-settings');
  volumeIndicator = document.getElementById('volume-indicator');
  btnPause = document.getElementById('btn-pause');
  btnCollapse = document.getElementById('btn-collapse');

  // 获取屏幕尺寸
  try {
    if (window.electronAPI && window.electronAPI.getScreenSize) {
      const size = await window.electronAPI.getScreenSize();
      screen.w = size.width;
      screen.h = size.height;
    }
  } catch (_) { /* fallback below */ }

  // 从 localStorage 恢复上次位置
  const savedPos = loadPosition();

  // 如果 localStorage 有记录，通知主进程恢复位置
  if (savedPos && window.electronAPI && window.electronAPI.setOverlayPosition) {
    window.electronAPI.setOverlayPosition(savedPos.x, savedPos.y);
  }

  // 恢复迷你模式状态
  const savedMini = loadMiniMode();
  if (savedMini) {
    enterMiniMode();
  }

  // 绑定拖拽事件
  bindDragEvents();

  // 绑定工具栏事件
  bindToolbarEvents();

  // 绑定 IPC 监听
  bindIpcListeners();

  // ── F3-NEW: 初始化单词释义卡片 ──
  if (window.cardAPI && window.cardAPI.init) {
    window.cardAPI.init();
  }

  // ── F3-NEW: 绑定单词点击事件 ──
  bindWordClickEvents();

  // 初始状态: idle
  setStatus('idle');
});

// =============================================================
// 拖拽系统
// =============================================================

function bindDragEvents() {
  // 只在拖拽手柄上响应 mousedown
  dragHandle.addEventListener('mousedown', onMouseDown);

  // mousemove / mouseup 挂载到 document 上，确保不丢失
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

/**
 * mousedown — 记录拖拽起始偏移
 */
function onMouseDown(e) {
  e.preventDefault();
  isDragging = true;

  // 移除 snap 过渡动画（拖拽时不应有缓动）
  container.classList.remove('snapping');

  // 记录鼠标相对于容器左上角的偏移
  const rect = container.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
}

/**
 * mousemove — 实时更新窗口位置
 */
function onMouseMove(e) {
  if (!isDragging) return;

  // 计算新位置：窗口左上角应位于 (鼠标坐标 - 偏移)
  let newX = e.screenX - dragOffsetX;
  let newY = e.screenY - dragOffsetY;

  // 可选：限制不超出屏幕
  newX = Math.max(0, Math.min(newX, screen.w - container.offsetWidth));
  newY = Math.max(0, Math.min(newY, screen.h - container.offsetHeight));

  // 通过 IPC 发送到主进程
  if (window.electronAPI && window.electronAPI.setOverlayPosition) {
    window.electronAPI.setOverlayPosition(newX, newY);
  }
}

/**
 * mouseup — 结束拖拽，触发边缘吸附 + 保存位置
 */
function onMouseUp(e) {
  if (!isDragging) return;
  isDragging = false;

  // 计算当前窗口左上角位置
  let newX = e.screenX - dragOffsetX;
  let newY = e.screenY - dragOffsetY;

  // 边缘吸附逻辑
  const snapped = snapToEdge(newX, newY);

  if (snapped) {
    // 添加 snap 过渡类，让主进程的 setPosition 有缓动感
    container.classList.add('snapping');
    if (window.electronAPI && window.electronAPI.setOverlayPosition) {
      window.electronAPI.setOverlayPosition(snapped.x, snapped.y);
    }

    // 动画结束后移除过渡类
    setTimeout(() => {
      container.classList.remove('snapping');
    }, 150);

    // 保存吸附后的位置
    savePosition(snapped.x, snapped.y);
  } else {
    // 保存当前位置
    savePosition(newX, newY);
  }
}

// =============================================================
// 边缘吸附
// =============================================================

function snapToEdge(x, y) {
  let snappedX = x;
  let snappedY = y;
  let didSnap = false;

  const winW = container.offsetWidth;
  const winH = container.offsetHeight;

  // 左边缘
  if (x < SNAP_THRESHOLD) {
    snappedX = 0;
    didSnap = true;
  }
  // 右边缘
  else if (x + winW > screen.w - SNAP_THRESHOLD) {
    snappedX = screen.w - winW;
    didSnap = true;
  }

  // 上边缘
  if (y < SNAP_THRESHOLD) {
    snappedY = 0;
    didSnap = true;
  }
  // 下边缘
  else if (y + winH > screen.h - SNAP_THRESHOLD) {
    snappedY = screen.h - winH;
    didSnap = true;
  }

  return didSnap ? { x: snappedX, y: snappedY } : null;
}

// =============================================================
// 位置持久化 (localStorage)
// =============================================================

function savePosition(x, y) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x, y }));
  } catch (_) { /* Storage full or unavailable */ }
}

function loadPosition() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return null;
}

function saveMiniMode(enabled) {
  try {
    localStorage.setItem(MINI_STORAGE_KEY, enabled ? '1' : '0');
  } catch (_) {}
}

function loadMiniMode() {
  try {
    return localStorage.getItem(MINI_STORAGE_KEY) === '1';
  } catch (_) { return false; }
}

// =============================================================
// F2.4 / F2.6: 工具栏事件绑定
// =============================================================

function bindToolbarEvents() {
  // 折叠 — 迷你模式切换
  if (btnCollapse) {
    btnCollapse.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMiniMode();
    });
  }

  // 暂停/继续
  if (btnPause) {
    btnPause.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePause();
    });
  }

  // 收藏
  if (btnFavorite) {
    btnFavorite.addEventListener('click', (e) => {
      e.stopPropagation();
      handleFavorite();
    });
  }

  // 复制
  if (btnCopy) {
    btnCopy.addEventListener('click', (e) => {
      e.stopPropagation();
      handleCopy();
    });
  }

  // 设置
  if (btnSettings) {
    btnSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.electronAPI && window.electronAPI.openSettings) {
        window.electronAPI.openSettings();
      }
    });
  }
}

// =============================================================
// F2.5 / F2.6: 交互操作
// =============================================================

/**
 * 切换迷你模式
 */
function toggleMiniMode() {
  if (isMiniMode) {
    exitMiniMode();
  } else {
    enterMiniMode();
  }
}

function enterMiniMode() {
  isMiniMode = true;
  container.classList.add('mini-mode');
  saveMiniMode(true);
  // 通知主进程（可选）
}

function exitMiniMode() {
  isMiniMode = false;
  container.classList.remove('mini-mode');
  saveMiniMode(false);
  // 通知主进程（可选）
}

/**
 * 切换暂停/继续
 */
function togglePause() {
  isPaused = !isPaused;
  if (btnPause) {
    btnPause.textContent = isPaused ? '▶' : '⏸';
    btnPause.title = isPaused ? '继续转录' : '暂停转录';
  }
  setStatus(isPaused ? 'paused' : (currentText ? 'transcribing' : 'idle'));

  // 通知主进程
  if (window.electronAPI && window.electronAPI.toggleTranscription) {
    window.electronAPI.toggleTranscription();
  }
}

/**
 * 收藏当前单词/句子
 */
function handleFavorite() {
  // 优先收藏当前显示的字幕文本
  const text = currentText || subtitleText.textContent;
  if (!text || text === '等候转录...') {
    showTooltip(btnFavorite, '没有可收藏的内容');
    return;
  }

  // 尝试提取第一个单词作为收藏目标
  const words = text.trim().split(/\s+/);
  const word = words.length > 0 ? words[0].replace(/[^a-zA-Z'-]/g, '') : '';

  if (word && word.length > 0) {
    // 本地高亮
    addHighlightedWord(word);

    // 通知主进程
    if (window.electronAPI && window.electronAPI.favoriteWord) {
      window.electronAPI.favoriteWord(word);
    }

    showTooltip(btnFavorite, `⭐ 已收藏 "${word}"`);
  } else {
    // 收藏整个句子
    if (window.electronAPI && window.electronAPI.favoriteWord) {
      window.electronAPI.favoriteWord(text.trim());
    }
    showTooltip(btnFavorite, '⭐ 已收藏');
  }
}

/**
 * 复制当前字幕到剪贴板
 */
function handleCopy() {
  const text = currentText || subtitleText.textContent;
  if (!text || text === '等候转录...') return;

  if (window.electronAPI && window.electronAPI.copyToClipboard) {
    window.electronAPI.copyToClipboard(text);
  }
  showTooltip(btnCopy, '📋 已复制');
}

// =============================================================
// F2.5: IPC 监听
// =============================================================

function bindIpcListeners() {
  // 主进程推送字幕
  if (window.electronAPI && window.electronAPI.onOverlaySubtitle) {
    window.electronAPI.onOverlaySubtitle((text) => {
      updateSubtitle(text);
    });
  }

  // 主进程推送状态
  if (window.electronAPI && window.electronAPI.onOverlayStatus) {
    window.electronAPI.onOverlayStatus((status) => {
      if (status && status.type) {
        setStatus(status.type);
        if (status.type === 'paused') {
          isPaused = true;
          if (btnPause) {
            btnPause.textContent = '▶';
            btnPause.title = '继续转录';
          }
        } else if (status.type === 'transcribing') {
          isPaused = false;
          if (btnPause) {
            btnPause.textContent = '⏸';
            btnPause.title = '暂停转录';
          }
        }
      }
    });
  }

  // 主进程切换迷你模式
  if (window.electronAPI && window.electronAPI.onToggleMini) {
    window.electronAPI.onToggleMini((forceState) => {
      if (forceState === true) enterMiniMode();
      else if (forceState === false) exitMiniMode();
      else toggleMiniMode();
    });
  }

  // 音量电平数据
  if (window.electronAPI && window.electronAPI.onVolumeLevel) {
    window.electronAPI.onVolumeLevel((level) => {
      updateVolumeLevel(level);
    });
  }
}

// =============================================================
// F2.3: 字幕文本渲染（单词粒度）
// =============================================================

/**
 * 更新字幕文本 — 按单词粒度分割为 <span> 元素
 * F2.3: 生词（已收藏的单词）加粗高亮（金色 #FFD700）
 * @param {string} text 字幕文本
 */
function updateSubtitle(text) {
  if (!subtitleText) return;

  currentText = text || '';

  if (!text || text.trim() === '') {
    showPlaceholder();
    return;
  }

  // 按单词拆分（保留空格和标点）
  const parts = splitIntoWords(text);

  // 构建 HTML
  let html = '';
  for (const part of parts) {
    if (part.type === 'word') {
      const isHighlighted = highlightedWords.has(part.text.toLowerCase());
      const cls = isHighlighted ? 'word-span highlighted' : 'word-span';
      const wordAttr = part.text.toLowerCase().replace(/[^a-zA-Z']/g, '');
      html += `<span class="${cls}" data-word="${escapeHtml(wordAttr)}">${escapeHtml(part.text)}</span>`;
    } else {
      // 空格 / 标点
      html += escapeHtml(part.text);
    }
  }

  subtitleText.innerHTML = html;
  subtitleText.classList.remove('placeholder');

  // 长文本自动缩小字号
  if (text.length > 40) {
    subtitleText.classList.add('long-text');
  } else {
    subtitleText.classList.remove('long-text');
  }
}

/**
 * 将文本分割为单词和非单词片段
 * @param {string} text
 * @returns {Array<{type: 'word'|'separator', text: string}>}
 */
function splitIntoWords(text) {
  const result = [];
  // 匹配单词（字母开头，包含连字符和撇号）和分隔符
  const regex = /([a-zA-Z\u00C0-\u024F][a-zA-Z\u00C0-\u024F'-]*)|([^a-zA-Z\u00C0-\u024F]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match[1] !== undefined) {
      result.push({ type: 'word', text: match[1] });
    } else if (match[2] !== undefined) {
      result.push({ type: 'separator', text: match[2] });
    }
  }
  return result;
}

// =============================================================
// F2.3: 单词高亮管理
// =============================================================

/**
 * 设置某个单词的高亮状态
 * @param {string} word
 * @param {boolean} highlighted
 */
function setWordHighlighted(word, highlighted) {
  if (!word) return;

  const normalized = word.toLowerCase().replace(/[^a-zA-Z'-]/g, '');
  if (!normalized) return;

  if (highlighted) {
    highlightedWords.add(normalized);
  } else {
    highlightedWords.delete(normalized);
  }

  // 重新渲染当前字幕以反映高亮变化
  if (currentText) {
    updateSubtitle(currentText);
  }
}

/**
 * 添加高亮单词（收藏）
 * @param {string} word
 */
function addHighlightedWord(word) {
  const normalized = word.toLowerCase().replace(/[^a-zA-Z'-]/g, '');
  if (normalized) {
    highlightedWords.add(normalized);
    // 重新渲染
    if (currentText) {
      updateSubtitle(currentText);
    }
  }
}

/**
 * 移除高亮单词（取消收藏）
 * @param {string} word
 */
function removeHighlightedWord(word) {
  const normalized = word.toLowerCase().replace(/[^a-zA-Z'-]/g, '');
  if (normalized) {
    highlightedWords.delete(normalized);
    if (currentText) {
      updateSubtitle(currentText);
    }
  }
}

// =============================================================
// F3-NEW: 单词点击 → 弹出释义卡片
// =============================================================

/**
 * 在字幕文本区绑定单词点击事件（事件委托）
 */
function bindWordClickEvents() {
  if (!subtitleText) return;

  subtitleText.addEventListener('click', (e) => {
    // 向上查找被点击的单词 span
    let target = e.target;
    while (target && target !== subtitleText) {
      if (target.classList && target.classList.contains('word-span')) {
        const word = target.getAttribute('data-word');
        if (word && word.length > 0) {
          handleWordClick(word, e.clientX, e.clientY);
        }
        e.preventDefault();
        return;
      }
      target = target.parentElement;
    }
  });
}

/**
 * 处理单词点击 — 弹出释义卡片
 * @param {string} word
 * @param {number} clientX
 * @param {number} clientY
 */
function handleWordClick(word, clientX, clientY) {
  // 获取当前上下文（整个字幕文本）
  const context = currentText || '';
  const source = ''; // 来源信息由主进程提供

  if (window.cardAPI && window.cardAPI.showCardForWord) {
    window.cardAPI.showCardForWord({
      word,
      context,
      source,
      x: clientX,
      y: clientY,
    });
  }
}

// =============================================================
// 显示/状态管理
// =============================================================

/**
 * 显示占位文本
 */
function showPlaceholder(text = '等候转录...') {
  if (!subtitleText) return;
  currentText = '';
  subtitleText.innerHTML = `<span class="placeholder">${escapeHtml(text)}</span>`;
  subtitleText.classList.remove('long-text');
}

/**
 * 设置状态指示灯
 * @param {'idle'|'listening'|'transcribing'|'paused'|'disconnected'|'error'} status
 */
function setStatus(status) {
  if (!statusDot) return;

  // 清除所有状态类
  statusDot.className = '';

  switch (status) {
    case 'listening':
    case 'transcribing':
      statusDot.classList.add('status-transcribing');
      break;
    case 'paused':
      statusDot.classList.add('status-paused');
      break;
    case 'disconnected':
    case 'error':
      statusDot.classList.add('status-disconnected');
      break;
    default:
      statusDot.classList.add('status-idle');
  }
}

/**
 * 更新音量电平显示
 * @param {number} level 0.0 ~ 1.0
 */
function updateVolumeLevel(level) {
  if (!volumeIndicator) return;

  // 清除所有音量级别类
  volumeIndicator.className = 'volume-indicator';

  if (level === undefined || level === null || level <= 0) {
    volumeIndicator.classList.add('volume-muted');
    return;
  }

  // 映射到 0-5 级
  const levelIndex = Math.min(5, Math.max(0, Math.round(level * 5)));
  volumeIndicator.classList.add('volume-level-' + levelIndex);
}

// =============================================================
// 工具函数
// =============================================================

/**
 * 简单的 HTML 转义
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * 在按钮上方显示临时 tooltip
 * @param {Element} anchor
 * @param {string} message
 */
function showTooltip(anchor, message) {
  if (!anchor) return;

  // 移除已有 tooltip
  const existing = anchor.parentElement.querySelector('.overlay-tooltip');
  if (existing) existing.remove();

  const tip = document.createElement('div');
  tip.className = 'overlay-tooltip';
  tip.textContent = message;
  tip.style.cssText = `
    position: absolute;
    bottom: calc(100% + 4px);
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.9);
    color: #fff;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    white-space: nowrap;
    pointer-events: none;
    z-index: 100;
    opacity: 0;
    transition: opacity 0.15s ease;
  `;

  // 确保按钮有相对定位
  if (getComputedStyle(anchor).position === 'static') {
    anchor.style.position = 'relative';
  }

  anchor.appendChild(tip);

  // 强制回流后淡入
  requestAnimationFrame(() => {
    tip.style.opacity = '1';
  });

  // 1.5 秒后移除
  setTimeout(() => {
    tip.style.opacity = '0';
    setTimeout(() => { if (tip.parentElement) tip.remove(); }, 200);
  }, 1500);
}

// =============================================================
// 导出（供 window 全局访问）
// =============================================================

window.overlayAPI = {
  // 字幕更新
  updateSubtitle,
  showPlaceholder,

  // 状态
  setStatus,

  // 单词高亮
  setWordHighlighted,
  addHighlightedWord,
  removeHighlightedWord,
  getHighlightedWords: () => Array.from(highlightedWords),

  // 迷你模式
  enterMiniMode,
  exitMiniMode,
  toggleMiniMode,
  isMiniMode: () => isMiniMode,

  // 暂停
  togglePause,
  isPaused: () => isPaused,

  // 音量
  updateVolumeLevel,
};
