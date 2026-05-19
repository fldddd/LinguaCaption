/**
 * SubtitleDisplay Module — 字幕展示组件
 *
 * Features:
 * - Render subtitle list with timestamps
 * - Dynamic active-line highlighting via requestAnimationFrame sync
 * - Auto-scroll to current active line
 * - Clickable words (→ word card for F3/F4)
 * - Hover words (→ floating card for F4)
 * - Position counter display
 *
 * Depends on: subtitle.js (formatTime, findCurrentSubtitle)
 *             player.js (showWordCard via dynamic import)
 *             FloatingCard.js (bindHoverToWord for F4)
 */

import { formatTime, findCurrentSubtitle } from './subtitle.js';
import { bindHoverToWord, unbindHoverFromWord } from './FloatingCard.js';

/* ── State ────────────────────────────────────────────── */

let subtitleData = [];
let subtitleElements = [];
let currentSubIndex = -1;
let mediaElement = null;       // Assigned via init()
let areaId = 'subtitle-area';  // Target container ID
let animFrameId = null;        // requestAnimationFrame handle
let isActive = false;          // Sync loop running?

/* ── Init / Teardown ─────────────────────────────────── */

/**
 * Connect the display to a media element for time-synced rendering.
 * @param {HTMLMediaElement} mediaEl - <video> or <audio> element
 * @param {string} [containerId] - Subtitle area element ID
 */
export function initSubtitleDisplay(mediaEl, containerId) {
  mediaElement = mediaEl;
  if (containerId) areaId = containerId;
}

/**
 * 状态恢复后重新绑定 mediaElement 引用
 * 当播放器重建 <video>/<audio> 后调用此方法更新 SubtitleDisplay 的内部引用
 *
 * @param {HTMLMediaElement} mediaEl - 新创建的 media element
 */
export function rebindMediaElement(mediaEl) {
  mediaElement = mediaEl;
  // 如果同步循环已停止则重新启动
  if (!isActive && mediaElement) {
    startSync();
  }
}

/**
 * Load parsed subtitle data and re-render the list.
 */
export function loadSubtitleData(data) {
  subtitleData = data || [];
  subtitleElements = [];
  currentSubIndex = -1;
  renderSubtitles();
}

/**
 * Start the requestAnimationFrame sync loop.
 */
export function startSync() {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  isActive = true;
  syncLoop();
}

/**
 * Stop the sync loop and clear active highlighting.
 */
export function stopSync() {
  isActive = false;
  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
  currentSubIndex = -1;
}

/* ── Render ───────────────────────────────────────────── */

function renderSubtitles() {
  const area = document.getElementById(areaId);
  if (!area) return;

  area.innerHTML = '';
  subtitleElements = [];
  currentSubIndex = -1;

  if (!subtitleData.length) {
    area.innerHTML = '<div class="subtitle-empty">暂无字幕内容<br><small>请加载 SRT / VTT 字幕文件</small></div>';
    return;
  }

  subtitleData.forEach((sub, i) => {
    const line = document.createElement('div');
    line.className = 'subtitle-line';
    line.dataset.index = i;

    // Timestamp badge
    const timeBadge = document.createElement('span');
    timeBadge.className = 'subtitle-time';
    timeBadge.textContent = formatTime(sub.start);

    // Text content with clickable words
    const textSpan = document.createElement('span');
    textSpan.className = 'subtitle-text';
    // FIX: makeWordsClickable already escapes internally — no outer escapeHtml
    textSpan.innerHTML = makeWordsClickable(sub.text);

    // Bind hover events for floating card (F4)
    textSpan.querySelectorAll('.clickable-word').forEach((wordEl) => {
      bindHoverToWord(wordEl);
    });

    // Click handler: clickable word → word card + seek (F6)
    textSpan.addEventListener('click', (e) => {
      const wordEl = e.target.closest('.clickable-word');
      if (wordEl) {
        const word = wordEl.dataset.word;
        triggerWordCard(word, sub);
        // F6: seek to this subtitle's start time
        import('./player.js').then((mod) => {
          if (typeof mod.seekTo === 'function') {
            mod.seekTo(sub.start || 0);
          }
        }).catch((err) => {
          console.warn('[SubtitleDisplay] seekTo not available:', err);
        });
      }
    });

    line.appendChild(timeBadge);
    line.appendChild(textSpan);
    area.appendChild(line);
    subtitleElements.push(line);
  });
}

/* ── Sync Loop ────────────────────────────────────────── */

function syncLoop() {
  if (!mediaElement) {
    if (isActive) animFrameId = requestAnimationFrame(syncLoop);
    return;
  }

  const currentTime = mediaElement.currentTime;
  const duration = mediaElement.duration || 0;

  // Update position counter
  const posEl = document.getElementById('subtitle-pos');
  if (posEl) {
    posEl.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  }

  // Find active subtitle
  const active = findCurrentSubtitle(subtitleData, currentTime);
  const foundIdx = active ? subtitleData.indexOf(active) : -1;

  // Highlight and auto-scroll
  if (foundIdx !== currentSubIndex) {
    subtitleElements.forEach((el, i) => {
      el.classList.toggle('active', i === foundIdx);
    });

    if (foundIdx >= 0 && subtitleElements[foundIdx]) {
      subtitleElements[foundIdx].scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }

    currentSubIndex = foundIdx;
  }

  if (isActive) animFrameId = requestAnimationFrame(syncLoop);
}

/* ── Word Card Integration ────────────────────────────── */

function triggerWordCard(word, sub) {
  // Dynamically import player.js to avoid circular deps.
  // Player module exports showWordCard as a named export.
  import('./player.js').then((mod) => {
    if (typeof mod.showWordCard === 'function') {
      // Pass subtitle text as context, plus start/end timestamps
      mod.showWordCard(word, sub.text, sub.start || 0, sub.end || 0);
    }
  }).catch((err) => {
    console.warn('[SubtitleDisplay] Word card not available:', err);
  });
}

/* ── Word Clickable Helpers ──────────────────────────── */

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function makeWordsClickable(text) {
  const parts = text.split(/(\b[\w']+\b)/g);
  return parts
    .map((part) => {
      const word = part.replace(/[^\w']/g, '');
      if (word && word.length >= 2) {
        return `<span class="clickable-word" data-word="${escapeHtml(word.toLowerCase())}">${escapeHtml(part)}</span>`;
      }
      return escapeHtml(part);
    })
    .join('');
}
