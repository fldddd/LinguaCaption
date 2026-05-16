/**
 * Player Module — 点读播放器
 *
 * Features:
 *   - 媒体文件打开（视频/音频）
 *   - SRT/VTT 字幕解析与同步
 *   - 两种模式：文件模式 / 实时字幕模式（mock WebSocket）
 *   - 点击单词触发词卡（F3/F4）
 *   - 智能自动滚动（用户手动滚动时暂停）
 */

import { updateStatus } from './app.js';
import { parseSubtitle } from './subtitle.js';

/* ── State ────────────────────────────────────────────── */

const state = {
  media: null,           // <video> or <audio> element
  subs: [],              // Parsed subtitle entries
  subEls: [],            // DOM elements for each subtitle line
  activeIdx: -1,         // Current active subtitle index
  animFrameId: null,     // requestAnimationFrame ID
  wordCardEl: null,      // Current word card overlay
  mode: 'file',          // 'file' | 'realtime'
  wsMock: null,          // Mock WebSocket timer
  userScrolled: false,   // User manually scrolled?
  scrollTimer: null,     // Reset userScrolled after idle
};

/* ── Init: Watch Mode (video + subtitles) ────────────── */

export function initPlayer() {
  bindWatchButtons();
}

/* ── Init: Point Mode (audio + subtitles only) ───────── */

export function initPointMode() {
  bindPointButtons();
}

/* ── Button Binding ──────────────────────────────────── */

function bindWatchButtons() {
  const btnFile = document.getElementById('btn-open-file');
  const btnSub = document.getElementById('btn-open-subtitle');
  if (btnFile) btnFile.onclick = () => openMedia('video');
  if (btnSub) btnSub.onclick = () => openSubtitle('subtitle-area');
}

function bindPointButtons() {
  const btnAudio = document.getElementById('btn-point-audio');
  const btnSub = document.getElementById('btn-point-subtitle');
  if (btnAudio) btnAudio.onclick = () => openMedia('audio');
  if (btnSub) btnSub.onclick = () => openSubtitle('subtitle-area-point');
}

/* ── Open Media File ─────────────────────────────────── */

async function openMedia(type) {
  let filePath = null;

  if (window.electronAPI && window.electronAPI.openMedia) {
    filePath = await window.electronAPI.openMedia();
  } else {
    filePath = await openFilePicker(['.mp4', '.mkv', '.webm', '.mp3', '.wav', '.m4a']);
  }

  if (!filePath) return;

  const containerId = type === 'audio' ? 'audio-container' : 'video-container';
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';

  const ext = filePath.split('.').pop().toLowerCase();
  const isAudio = ['mp3', 'wav', 'm4a', 'ogg'].includes(ext);

  state.media = document.createElement(isAudio ? 'audio' : 'video');
  state.media.controls = true;
  state.media.style.width = '100%';
  if (!isAudio) state.media.style.height = '100%';
  state.media.src = filePath;
  state.media.load();
  container.appendChild(state.media);

  updateFileName(filePath);
  updateStatus(`播放: ${fileName(filePath)}`);
  startSync();
}

/* ── Open Subtitle File ──────────────────────────────── */

async function openSubtitle(areaId) {
  let filePath = null;

  if (window.electronAPI && window.electronAPI.openSubtitle) {
    filePath = await window.electronAPI.openSubtitle();
  } else {
    filePath = await openFilePicker(['.srt', '.vtt']);
  }

  if (!filePath) return;

  try {
    const text = await readTextFile(filePath);
    state.subs = parseSubtitle(text, filePath);
    renderSubtitles(areaId);
    updateStatus(`字幕加载完成: ${fileName(filePath)} (${state.subs.length} 条)`);
    stopRealtimeMode();
    state.mode = 'file';
  } catch (err) {
    console.error('Subtitle load error:', err);
    updateStatus('❌ 字幕加载失败');
  }
}

/* ── Render Subtitles ────────────────────────────────── */

function renderSubtitles(areaId) {
  const area = document.getElementById(areaId);
  if (!area) return;

  area.innerHTML = '';
  state.subEls = [];

  state.subs.forEach((sub, i) => {
    const line = document.createElement('div');
    line.className = 'subtitle-line';
    line.dataset.index = i;

    const idxSpan = document.createElement('span');
    idxSpan.className = 'subtitle-index';
    idxSpan.textContent = sub.id || i + 1;

    const textSpan = document.createElement('span');
    textSpan.className = 'subtitle-text';
    textSpan.innerHTML = makeWordsClickable(escapeHtml(sub.text));
    textSpan.addEventListener('click', (e) => {
      const wordEl = e.target.closest('.clickable-word');
      if (wordEl) {
        showWordCard(wordEl.dataset.word, sub.text);
      }
    });
    // Hover: 0.3s delay (F4.4) — only on .clickable-word
    textSpan.addEventListener('mouseenter', (e) => {
      const wordEl = e.target.closest('.clickable-word');
      if (wordEl) {
        const word = wordEl.dataset.word;
        wordEl._hoverTimer = setTimeout(() => {
          showWordCard(word, sub.text);
        }, 300);
      }
    });
    textSpan.addEventListener('mouseleave', (e) => {
      const wordEl = e.target.closest('.clickable-word');
      if (wordEl && wordEl._hoverTimer) {
        clearTimeout(wordEl._hoverTimer);
        wordEl._hoverTimer = null;
      }
    });

    line.appendChild(idxSpan);
    line.appendChild(textSpan);
    area.appendChild(line);
    state.subEls.push(line);
  });

  // Bind smart scroll detection
  area.addEventListener('scroll', onSubtitleScroll, { passive: true });
}

/* ── Smart Auto-Scroll ───────────────────────────────── */

function onSubtitleScroll() {
  state.userScrolled = true;
  clearTimeout(state.scrollTimer);
  state.scrollTimer = setTimeout(() => {
    state.userScrolled = false;
  }, 3000); // 3s idle → resume auto-scroll
}

function scrollToActiveLine(idx) {
  if (state.userScrolled) return;
  const el = state.subEls[idx];
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ── Subtitle Sync ───────────────────────────────────── */

function startSync() {
  if (state.animFrameId) cancelAnimationFrame(state.animFrameId);
  syncLoop();
}

function syncLoop() {
  if (!state.media || state.media.paused || state.media.ended) {
    state.animFrameId = requestAnimationFrame(syncLoop);
    return;
  }

  const t = state.media.currentTime;
  let found = -1;
  for (let i = 0; i < state.subs.length; i++) {
    if (t >= state.subs[i].start && t < state.subs[i].end) {
      found = i;
      break;
    }
  }

  if (found !== state.activeIdx) {
    state.subEls.forEach((el, i) => el.classList.toggle('active', i === found));
    if (found >= 0) scrollToActiveLine(found);
    state.activeIdx = found;
  }

  state.animFrameId = requestAnimationFrame(syncLoop);
}

/* ── Mode Switching ──────────────────────────────────── */

export function switchMode(mode) {
  if (mode === state.mode) return;
  stopRealtimeMode();

  if (mode === 'realtime') {
    startRealtimeMode();
  } else {
    state.mode = 'file';
    updateStatus('已切换到文件模式');
  }
}

function startRealtimeMode() {
  state.mode = 'realtime';
  state.subs = [];
  state.subEls = [];
  const area = document.getElementById('subtitle-area') || document.getElementById('subtitle-area-point');
  if (area) {
    area.innerHTML = '<p class="placeholder-text">等待实时字幕...</p>';
  }
  updateStatus('🔄 实时字幕模式已启动');

  // Mock WebSocket: push a fake subtitle line every 2s
  let idx = 0;
  const mockLines = [
    'Hello, welcome to LinguaCaption.',
    'This is a real-time subtitle simulation.',
    'You can click any word to look up its definition.',
    'The built-in dictionary supports pronunciation too.',
    'Bookmark words you want to review later.',
    'Happy learning and enjoy the experience!',
  ];
  state.wsMock = setInterval(() => {
    if (idx >= mockLines.length) {
      stopRealtimeMode();
      return;
    }
    pushRealtimeSubtitle(mockLines[idx]);
    idx++;
  }, 2000);
}

function stopRealtimeMode() {
  if (state.wsMock) {
    clearInterval(state.wsMock);
    state.wsMock = null;
  }
}

function pushRealtimeSubtitle(text) {
  const now = state.media ? state.media.currentTime : 0;
  const sub = {
    id: state.subs.length + 1,
    start: now,
    end: now + 2,
    text,
  };
  state.subs.push(sub);

  const area = document.getElementById('subtitle-area') || document.getElementById('subtitle-area-point');
  if (!area) return;

  // Clear placeholder if first line
  if (state.subs.length === 1) area.innerHTML = '';

  const line = document.createElement('div');
  line.className = 'subtitle-line active';
  line.dataset.index = state.subs.length - 1;

  const textSpan = document.createElement('span');
  textSpan.className = 'subtitle-text';
  textSpan.innerHTML = makeWordsClickable(escapeHtml(text));
  textSpan.addEventListener('click', (e) => {
    const wordEl = e.target.closest('.clickable-word');
    if (wordEl) showWordCard(wordEl.dataset.word, text);
  });
  // Hover: 0.3s delay (F4.4)
  textSpan.addEventListener('mouseenter', (e) => {
    const wordEl = e.target.closest('.clickable-word');
    if (wordEl) {
      wordEl._hoverTimer = setTimeout(() => {
        showWordCard(wordEl.dataset.word, text);
      }, 300);
    }
  });
  textSpan.addEventListener('mouseleave', (e) => {
    const wordEl = e.target.closest('.clickable-word');
    if (wordEl && wordEl._hoverTimer) {
      clearTimeout(wordEl._hoverTimer);
      wordEl._hoverTimer = null;
    }
  });

  line.appendChild(textSpan);
  area.appendChild(line);
  state.subEls.push(line);

  // Auto-scroll
  line.scrollIntoView({ behavior: 'smooth', block: 'center' });
  updateStatus(`📝 ${text}`);
}

/* ── Word Card (F3/F4) ───────────────────────────────── */

function showWordCard(word, context) {
  if (state.wordCardEl) {
    state.wordCardEl.remove();
    state.wordCardEl = null;
  }

  const overlay = document.createElement('div');
  overlay.className = 'word-card-overlay';

  overlay.innerHTML = `
    <div class="word-card">
      <div class="word-card-header">
        <span class="word-card-word">${escapeHtml(word)}</span>
        <button class="word-card-close" id="word-card-close">✕</button>
      </div>
      <div class="word-card-pos skeleton" style="height:18px;width:60px;"></div>
      <div class="word-card-phonetic skeleton" style="height:16px;width:100px;margin:6px 0 10px;"></div>
      <div class="word-card-definition skeleton" id="word-def-text" style="height:40px;"></div>
      <div class="word-card-context">"${escapeHtml(context)}"</div>
      <div class="word-card-actions">
        <button class="player-btn" id="word-btn-save">📌 收藏</button>
        <button class="player-btn secondary" id="word-btn-pronounce">🔊 发音</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  state.wordCardEl = overlay;

  // Boundary detection (F4.5): reposition card if it overflows viewport
  requestAnimationFrame(() => {
    const card = overlay.querySelector('.word-card');
    if (card) {
      const rect = card.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (rect.right > vw) card.style.marginLeft = `${vw - rect.right - 16}px`;
      if (rect.bottom > vh) card.style.marginTop = `${vh - rect.bottom - 16}px`;
      if (rect.left < 0) card.style.marginLeft = `${-rect.left + 16}px`;
      if (rect.top < 0) card.style.marginTop = `${-rect.top + 16}px`;
    }
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWordCard(); });
  document.getElementById('word-card-close').onclick = closeWordCard;
  document.getElementById('word-btn-save').onclick = () => saveWord(word, context);
  document.getElementById('word-btn-pronounce').onclick = () => pronounceWord(word);

  fetchWordDefinition(word).then((def) => {
    const defEl = document.getElementById('word-def-text');
    const posEl = overlay.querySelector('.word-card-pos');
    const phoEl = overlay.querySelector('.word-card-phonetic');
    if (def) {
      if (def.pos) { posEl.textContent = def.pos; posEl.className = 'word-card-pos'; }
      else { posEl.textContent = ''; posEl.className = 'word-card-pos'; }
      if (def.phonetic) { phoEl.textContent = def.phonetic; phoEl.className = 'word-card-phonetic'; }
      else { phoEl.textContent = ''; phoEl.className = 'word-card-phonetic'; }
      if (def.definition) { defEl.textContent = def.definition; defEl.className = 'word-card-definition'; }
    } else {
      defEl.textContent = '未找到释义';
      defEl.className = 'word-card-definition';
    }
  });
}

function closeWordCard() {
  if (state.wordCardEl) {
    state.wordCardEl.remove();
    state.wordCardEl = null;
  }
}

async function fetchWordDefinition(word) {
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data[0] && data[0].meanings) {
      const m = data[0];
      const meaning = m.meanings[0];
      const def = meaning.definitions[0].definition;
      const pos = meaning.partOfSpeech ? `[${meaning.partOfSpeech}]` : '';
      const phonetic = m.phonetic || m.phonetics?.find(p => p.text)?.text || '';
      return { word: m.word, phonetic, pos, definition: def };
    }
    return null;
  } catch {
    return null;
  }
}

function pronounceWord(word) {
  const el = document.querySelector(`.clickable-word[data-word="${escapeHtml(word.toLowerCase())}"]`);
  if (el) {
    el.classList.add('playing');
    setTimeout(() => el.classList.remove('playing'), 600);
  }

  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.9;
  speechSynthesis.speak(utterance);
}

async function saveWord(word, context) {
  try {
    // Check duplicate in localStorage
    const { getWords, addWord } = await import('./storage.js');
    const existing = getWords();
    if (existing.some((w) => w.word.toLowerCase() === word.toLowerCase())) {
      showToast(`"${word}" 已在生词本中`, 'warning');
      return;
    }

    const def = await fetchWordDefinition(word);
    await addWord({
      word: word.toLowerCase(),
      context,
      definition: def?.definition || '',
      phonetic: def?.phonetic || '',
      pos: def?.pos || '',
      savedAt: new Date().toISOString(),
      reviewCount: 0,
    });
    showToast(`📌 已收藏: ${word}`, 'success');
    closeWordCard();
  } catch (err) {
    console.error('Save word failed:', err);
    showToast('❌ 收藏失败', 'error');
  }
}

/* ── Toast Notification ──────────────────────────────── */

function showToast(msg, type = '') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/* ── Helpers ─────────────────────────────────────────── */

function fileName(path) {
  return path.split(/[/\\]/).pop();
}

function updateFileName(path) {
  const el = document.getElementById('file-name') || document.getElementById('point-file-name');
  if (el) el.textContent = fileName(path);
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeWordsClickable(text) {
  const parts = text.split(/(\b[\w']+\b)/g);
  return parts.map((part) => {
    const word = part.replace(/[^\w']/g, '');
    if (word && word.length >= 2) {
      return `<span class="clickable-word" data-word="${escapeHtml(word.toLowerCase())}">${escapeHtml(part)}</span>`;
    }
    return escapeHtml(part);
  }).join('');
}

function openFilePicker(extensions) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.join(',');
    input.onchange = () => resolve(input.files[0] ? URL.createObjectURL(input.files[0]) : null);
    input.click();
  });
}

async function readTextFile(path) {
  if (window.electronAPI) {
    const resp = await fetch(`file://${path}`);
    return resp.text();
  }
  throw new Error('Text file reading only supported in Electron');
}
