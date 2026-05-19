/**
 * LinguaCaption — 浏览器内悬浮字幕窗口 (Inline Overlay)
 *
 * 功能:
 *   1. 可拖拽定位的内嵌字幕悬浮窗口
 *   2. 迷你模式折叠/展开
 *   3. 实时字幕显示（支持单词高亮）
 *   4. 透明度调节
 *   5. 位置记忆 (localStorage)
 *   6. 工具栏：收藏/复制/暂停/折叠
 *   7. 与字幕同步显示模块协同工作
 */

// =============================================================
// 常量 / 配置
// =============================================================

const INLINE_OVERLAY_STORAGE_KEY = 'inline_overlay_position';
const INLINE_OVERLAY_MINI_KEY = 'inline_overlay_mini_mode';
const INLINE_OVERLAY_OPACITY_KEY = 'inline_overlay_opacity';
const DEFAULT_OPACITY = 0.9;
const DRAG_HANDLE_ID = 'inline-drag-handle';

// =============================================================
// 状态
// =============================================================

let container = null;
let dragHandle = null;
let subtitleText = null;
let toolbar = null;
let btnCollapse = null;
let btnPause = null;
let btnFavorite = null;
let btnCopy = null;
let opacitySlider = null;

let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let isPaused = false;
let isMiniMode = false;
let currentText = '';
/** @type {Set<string>} 已收藏（高亮）的单词 */
let highlightedWords = new Set();

// =============================================================
// 初始化
// =============================================================

/**
 * 初始化内嵌悬浮窗口
 * @param {HTMLElement} parentContainer - 悬浮窗口的父容器（通常是视频容器）
 */
export function initInlineOverlay(parentContainer) {
  // 如果已存在，先移除
  destroyInlineOverlay();

  // 创建悬浮窗口 DOM
  const el = createOverlayElement();
  container = el;
  parentContainer.appendChild(container);

  // 获取 DOM 引用
  dragHandle = container.querySelector('#' + DRAG_HANDLE_ID);
  subtitleText = container.querySelector('#inline-subtitle-text');
  toolbar = container.querySelector('#inline-toolbar');
  btnCollapse = container.querySelector('#inline-btn-collapse');
  btnPause = container.querySelector('#inline-btn-pause');
  btnFavorite = container.querySelector('#inline-btn-favorite');
  btnCopy = container.querySelector('#inline-btn-copy');
  opacitySlider = container.querySelector('#inline-opacity-slider');

  // 恢复位置和状态
  restoreState();

  // 绑定事件
  bindDragEvents();
  bindToolbarEvents();
  bindOpacitySlider();

  // 显示悬浮窗口
  container.classList.add('visible');

  return container;
}

/**
 * 销毁内嵌悬浮窗口
 */
export function destroyInlineOverlay() {
  if (container && container.parentElement) {
    saveState();
    container.remove();
  }
  container = null;
  dragHandle = null;
  subtitleText = null;
}

/**
 * 显示/隐藏内嵌悬浮窗口
 */
export function toggleInlineOverlay() {
  if (!container) return false;

  if (container.classList.contains('visible')) {
    container.classList.remove('visible');
    return false;
  } else {
    container.classList.add('visible');
    return true;
  }
}

/**
 * 是否正在显示
 */
export function isInlineOverlayVisible() {
  return container && container.classList.contains('visible');
}

// =============================================================
// DOM 创建
// =============================================================

function createOverlayElement() {
  const wrapper = document.createElement('div');
  wrapper.id = 'inline-overlay';
  wrapper.className = 'inline-overlay';
  wrapper.innerHTML = `
    <div id="${DRAG_HANDLE_ID}" class="inline-drag-handle">
      <div class="inline-drag-dots">⋮⋮</div>
    </div>
    <div id="inline-subtitle-area" class="inline-subtitle-area">
      <div id="inline-subtitle-text" class="inline-subtitle-text">
        <span class="inline-placeholder">等候字幕...</span>
      </div>
    </div>
    <div id="inline-toolbar" class="inline-toolbar">
      <button id="inline-btn-pause" class="inline-tool-btn" title="暂停/继续">⏸</button>
      <button id="inline-btn-favorite" class="inline-tool-btn" title="收藏">⭐</button>
      <button id="inline-btn-copy" class="inline-tool-btn" title="复制">📋</button>
      <div class="inline-opacity-control">
        <span class="inline-opacity-label">🔘</span>
        <input type="range" id="inline-opacity-slider" class="inline-opacity-slider"
               min="0.3" max="1" step="0.1" value="${DEFAULT_OPACITY}">
      </div>
      <button id="inline-btn-collapse" class="inline-tool-btn" title="折叠">—</button>
    </div>
  `;
  return wrapper;
}

// =============================================================
// 状态持久化
// =============================================================

function saveState() {
  if (!container) return;

  try {
    const rect = container.getBoundingClientRect();
    const parentRect = container.parentElement.getBoundingClientRect();

    // 存储相对于父容器的位置
    const relX = rect.left - parentRect.left;
    const relY = rect.top - parentRect.top;

    localStorage.setItem(INLINE_OVERLAY_STORAGE_KEY, JSON.stringify({
      x: relX,
      y: relY,
    }));
    localStorage.setItem(INLINE_OVERLAY_MINI_KEY, isMiniMode ? '1' : '0');
    localStorage.setItem(INLINE_OVERLAY_OPACITY_KEY, opacitySlider?.value || DEFAULT_OPACITY);
  } catch (_) {}
}

function restoreState() {
  try {
    // 恢复位置
    const posData = localStorage.getItem(INLINE_OVERLAY_STORAGE_KEY);
    if (posData) {
      const { x, y } = JSON.parse(posData);
      if (typeof x === 'number' && typeof y === 'number') {
        container.style.left = `${x}px`;
        container.style.top = `${y}px`;
      }
    }

    // 恢复迷你模式
    if (localStorage.getItem(INLINE_OVERLAY_MINI_KEY) === '1') {
      enterMiniMode();
    }

    // 恢复透明度
    const opacity = localStorage.getItem(INLINE_OVERLAY_OPACITY_KEY);
    if (opacity && opacitySlider) {
      opacitySlider.value = opacity;
      container.style.setProperty('--inline-overlay-opacity', opacity);
    }
  } catch (_) {}
}

// =============================================================
// 拖拽系统
// =============================================================

function bindDragEvents() {
  if (!dragHandle) return;

  dragHandle.addEventListener('mousedown', onDragStart);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragStart(e) {
  e.preventDefault();
  isDragging = true;
  container.classList.add('dragging');

  const rect = container.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
}

function onDragMove(e) {
  if (!isDragging) return;

  const parent = container.parentElement;
  if (!parent) return;

  const parentRect = parent.getBoundingClientRect();

  // 计算新位置（相对于父容器）
  let newX = e.clientX - parentRect.left - dragOffsetX;
  let newY = e.clientY - parentRect.top - dragOffsetY;

  // 边界限制
  const containerW = container.offsetWidth;
  const containerH = container.offsetHeight;
  const maxX = parentRect.width - containerW;
  const maxY = parentRect.height - containerH;

  newX = Math.max(0, Math.min(newX, maxX));
  newY = Math.max(0, Math.min(newY, maxY));

  container.style.left = `${newX}px`;
  container.style.top = `${newY}px`;
}

function onDragEnd() {
  if (!isDragging) return;
  isDragging = false;
  container.classList.remove('dragging');
  saveState();
}

// =============================================================
// 工具栏事件
// =============================================================

function bindToolbarEvents() {
  // 折叠
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
}

function bindOpacitySlider() {
  if (!opacitySlider) return;

  opacitySlider.addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    container.style.setProperty('--inline-overlay-opacity', value);
    saveState();
  });

  opacitySlider.addEventListener('click', (e) => e.stopPropagation());
}

// =============================================================
// 模式切换
// =============================================================

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
  if (btnCollapse) btnCollapse.textContent = '▲';
  saveState();
}

function exitMiniMode() {
  isMiniMode = false;
  container.classList.remove('mini-mode');
  if (btnCollapse) btnCollapse.textContent = '—';
  saveState();
}

function togglePause() {
  isPaused = !isPaused;
  if (btnPause) {
    btnPause.textContent = isPaused ? '▶' : '⏸';
    btnPause.title = isPaused ? '继续' : '暂停';
  }
}

// =============================================================
// 字幕操作
// =============================================================

/**
 * 更新字幕文本
 * @param {string} text
 */
export function updateInlineSubtitle(text) {
  if (!subtitleText) return;

  currentText = text || '';

  if (!text || text.trim() === '') {
    subtitleText.innerHTML = '<span class="inline-placeholder">等候字幕...</span>';
    return;
  }

  // 按单词拆分
  const parts = splitIntoWords(text);

  let html = '';
  for (const part of parts) {
    if (part.type === 'word') {
      const isHighlighted = highlightedWords.has(part.text.toLowerCase());
      const cls = isHighlighted ? 'inline-word-span highlighted' : 'inline-word-span';
      const wordAttr = part.text.toLowerCase().replace(/[^a-zA-Z']/g, '');
      html += `<span class="${cls}" data-word="${escapeHtml(wordAttr)}">${escapeHtml(part.text)}</span>`;
    } else {
      html += escapeHtml(part.text);
    }
  }

  subtitleText.innerHTML = html;

  // 长文本自动缩小
  if (text.length > 50) {
    subtitleText.classList.add('long-text');
  } else {
    subtitleText.classList.remove('long-text');
  }
}

/**
 * 分割文本为单词和非单词片段
 */
function splitIntoWords(text) {
  const result = [];
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

/**
 * 添加高亮单词
 */
export function addHighlightedWord(word) {
  const normalized = word.toLowerCase().replace(/[^a-zA-Z'-]/g, '');
  if (normalized) {
    highlightedWords.add(normalized);
    if (currentText) {
      updateInlineSubtitle(currentText);
    }
  }
}

/**
 * 获取高亮单词列表
 */
export function getHighlightedWords() {
  return Array.from(highlightedWords);
}

/**
 * 设置暂停状态
 */
export function setPauseState(paused) {
  isPaused = paused;
  if (btnPause) {
    btnPause.textContent = isPaused ? '▶' : '⏸';
    btnPause.title = isPaused ? '继续' : '暂停';
  }
}

/**
 * 是否暂停
 */
export function isPaused() {
  return isPaused;
}

// =============================================================
// 操作处理
// =============================================================

function handleFavorite() {
  const text = currentText || subtitleText.textContent;
  if (!text || text.includes('等候字幕')) return;

  const words = text.trim().split(/\s+/);
  const word = words.length > 0 ? words[0].replace(/[^a-zA-Z'-]/g, '') : '';

  if (word && word.length > 0) {
    addHighlightedWord(word);
    showInlineToast('⭐ 已收藏: ' + word);
  }
}

function handleCopy() {
  const text = currentText || subtitleText.textContent;
  if (!text || text.includes('等候字幕')) return;

  if (window.electronAPI && window.electronAPI.copyToClipboard) {
    window.electronAPI.copyToClipboard(text);
  }
  showInlineToast('📋 已复制');
}

// =============================================================
// Toast 提示
// =============================================================

function showInlineToast(message) {
  if (!container) return;

  const existing = container.querySelector('.inline-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'inline-toast';
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 200);
  }, 1500);
}

// =============================================================
// 工具函数
// =============================================================

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// =============================================================
// 导出 API
// =============================================================

window.inlineOverlayAPI = {
  init: initInlineOverlay,
  destroy: destroyInlineOverlay,
  toggle: toggleInlineOverlay,
  isVisible: isInlineOverlayVisible,
  updateSubtitle: updateInlineSubtitle,
  addHighlightedWord,
  getHighlightedWords,
  setPauseState,
  isPaused,
};
