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

    // Text content with clickable words (with word-level timestamps)
    const textSpan = document.createElement('span');
    textSpan.className = 'subtitle-text';
    textSpan.innerHTML = makeWordsClickable(sub.text, sub.words);

    // Bind hover events for floating card (F4)
    textSpan.querySelectorAll('.clickable-word').forEach((wordEl) => {
      bindHoverToWord(wordEl);
    });

    // Click handler: clickable word → word card + seek to word position
    textSpan.addEventListener('click', (e) => {
      const wordEl = e.target.closest('.clickable-word');
      if (wordEl) {
        const word = wordEl.dataset.word;
        const wordStart = parseFloat(wordEl.dataset.start);
        triggerWordCard(word, sub);
        // 点读跳转：点击单词时跳转到该单词在音频/视频中的位置
        if (!isNaN(wordStart) && mediaElement) {
          mediaElement.currentTime = wordStart;
          // 如果处于暂停状态则自动播放
          if (mediaElement.paused) {
            mediaElement.play().catch(() => {});
          }
        }
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

function makeWordsClickable(text, wordEntries = null) {
  const parts = text.split(/(\b[\w']+\b)/g);

  // Build a lookup from word entries if provided
  const wordMap = {};
  if (wordEntries && Array.isArray(wordEntries)) {
    for (const we of wordEntries) {
      // Use the first occurrence if duplicates exist
      const key = (we.word || '').toLowerCase();
      if (key && !wordMap[key]) {
        wordMap[key] = we;
      }
    }
  }

  let entryIdx = 0;
  return parts
    .map((part) => {
      const word = part.replace(/[^\w']/g, '');
      if (word && word.length >= 2) {
        // Try to find matching word entry by sequential match
        let we = null;
        const wordLower = word.toLowerCase();
        if (wordEntries && entryIdx < wordEntries.length) {
          const candidate = wordEntries[entryIdx];
          if ((candidate.word || '').toLowerCase() === wordLower) {
            we = candidate;
            entryIdx++;
          } else {
            // Fallback: scan for a match
            for (let i = entryIdx; i < wordEntries.length; i++) {
              if ((wordEntries[i].word || '').toLowerCase() === wordLower) {
                we = wordEntries[i];
                entryIdx = i + 1;
                break;
              }
            }
          }
        }

        const dataAttrs = we
          ? ` data-start="${we.start}" data-end="${we.end}"`
          : '';
        return `<span class="clickable-word" data-word="${escapeHtml(wordLower)}"${dataAttrs}>${escapeHtml(part)}</span>`;
      }
      return escapeHtml(part);
    })
    .join('');
}
