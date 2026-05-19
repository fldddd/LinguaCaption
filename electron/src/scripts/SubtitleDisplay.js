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
import { isUnfamiliar } from './learning.js';
import { BASE_URL } from './api.js';

/* ── 词性着色 ──────────────────────────────────────────── */
const POS_CLASSES = {
  'NOUN': 'pos-noun', 'PROPN': 'pos-noun',
  'VERB': 'pos-verb', 'AUX': 'pos-verb',
  'ADJ': 'pos-adj',
  'ADV': 'pos-adv',
  'ADP': 'pos-prep', 'PREP': 'pos-prep',
  'PRON': 'pos-pron',
  'DET': 'pos-det',
  'CONJ': 'pos-conj', 'CCONJ': 'pos-conj', 'SCONJ': 'pos-conj',
  'NUM': 'pos-num',
  'PART': 'pos-part',
  'INTJ': 'pos-intj',
  'X': 'pos-unk',
};
const posCache = new Map(); // word 小写 → { pos: string }

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

    // Text content with clickable words (with word-level timestamps)
    const textSpan = document.createElement('span');
    textSpan.className = 'subtitle-text';
    textSpan.innerHTML = makeWordsClickable(sub.text, sub.words);

    // Bind hover events for floating card (F4)
    textSpan.querySelectorAll('.clickable-word').forEach((wordEl) => {
      bindHoverToWord(wordEl);
    });

    // Click handler: clickable word → word card + seek to word position (F6)
    textSpan.addEventListener('click', (e) => {
      const wordEl = e.target.closest('.clickable-word');
      if (wordEl) {
        const word = wordEl.dataset.word;
        const wordStart = parseFloat(wordEl.dataset.start);
        triggerWordCard(word, sub);
    if (!isNaN(wordStart) && mediaElement) {
        // 点读跳转：点击单词时跳转到该单词在音频/视频中的位置
        mediaElement.currentTime = wordStart;
        // 如果处于暂停状态则自动播放
        if (mediaElement.paused) {
          mediaElement.play().catch(() => {});
        }
      } else {
        // F6: seek to this subtitle's start time
        import('./player.js').then((mod) => {
          if (typeof mod.seekTo === 'function') {
            mod.seekTo(sub.start || 0);
          }
        }).catch((err) => {
          console.warn('[SubtitleDisplay] seekTo not available:', err);
        });
      }
      }
    });

    line.appendChild(timeBadge);
    line.appendChild(textSpan);
    area.appendChild(line);
    subtitleElements.push(line);
  });
  // 懒加载词性着色
  fetchAndApplyPosClasses();
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

  // F1: Auto-increment familiarity when user clicks a word
  import('./learning.js').then((mod) => {
    if (mod.isUnfamiliar(word)) {
      mod.incrementAndCache(word);
    }
  }).catch(() => {});
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
        let cls = isUnfamiliar(wordLower) ? 'clickable-word unfamiliar-word' : 'clickable-word';
        // 如果缓存已有词性信息，添加词性 class
        const cached = posCache.get(wordLower);
        if (cached && cached.pos) {
          const posClass = POS_CLASSES[cached.pos];
          if (posClass) cls += ' ' + posClass;
        }
        return `<span class="${cls}" data-word="${escapeHtml(wordLower)}"${dataAttrs}>${escapeHtml(part)}</span>`;
      }
      return escapeHtml(part);
    })
    .join('');
}

/* ── 词性着色（懒加载） ────────────────────────────── */

/**
 * 扫描字幕区域中尚未着色的 clickable-word，从后端查询词性并添加 CSS class
 */
async function fetchAndApplyPosClasses() {
  const area = document.getElementById(areaId);
  if (!area) return;

  // 收集所有尚未有词性 class 的单词 span
  const wordEls = area.querySelectorAll('.clickable-word');
  const wordMap = {}; // wordLower → [elements]

  wordEls.forEach(el => {
    const word = el.dataset.word;
    if (!word) return;

    // 如果该单词已在缓存中且有关联 class，直接应用
    if (posCache.has(word)) {
      const cached = posCache.get(word);
      if (cached && cached.pos) {
        const posClass = POS_CLASSES[cached.pos];
        if (posClass) el.classList.add(posClass);
      }
      return;
    }

    // 尚未缓存，加入待查询列表
    if (!wordMap[word]) wordMap[word] = [];
    wordMap[word].push(el);
  });

  const wordsToFetch = Object.keys(wordMap);
  if (wordsToFetch.length === 0) return;

  // 逐个查询后端（API 暂不支持批量，保持简单）
  const promises = wordsToFetch.map(async (word) => {
    try {
      const res = await fetch(`${BASE_URL}/api/words/syntactic/${encodeURIComponent(word)}`);
      if (!res.ok) {
        posCache.set(word, { pos: '' });
        return;
      }
      const data = await res.json();
      const pos = (data && data.pos) || '';
      posCache.set(word, { pos });

      const posClass = POS_CLASSES[pos];
      if (posClass && wordMap[word]) {
        wordMap[word].forEach(el => el.classList.add(posClass));
      }
    } catch (err) {
      // 静默失败，不影响字幕展示
      console.debug('[SubtitleDisplay] POS fetch failed for:', word, err.message);
      posCache.set(word, { pos: '' });
    }
  });

  await Promise.allSettled(promises);
}
