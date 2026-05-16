/**
 * Player Module — 点读播放器
 *
 * Features:
 *   - 媒体文件打开（视频/音频）
 *   - SRT/VTT 字幕解析与同步
 *   - 两种模式：文件模式 / 实时字幕模式（mock WebSocket）
 *   - 点击单词触发词卡（F3/F4）
 *
 * Rendering & sync delegated to SubtitleDisplay module.
 */

import { updateStatus } from './app.js';
import { parseSubtitle } from './subtitle.js';
import { initSubtitleDisplay, loadSubtitleData, startSync, stopSync } from './SubtitleDisplay.js';

/* ── State ────────────────────────────────────────────── */

const state = {
  media: null,           // <video> or <audio> element
  subs: [],              // Parsed subtitle entries
  mode: 'file',          // 'file' | 'realtime'
  wsMock: null,          // Mock WebSocket timer
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

  // Determine subtitle area for current mode
  const areaId = type === 'audio' ? 'subtitle-area-point' : 'subtitle-area';
  initSubtitleDisplay(state.media, areaId);
  startSync();

  updateFileName(filePath);
  updateStatus(`播放: ${fileName(filePath)}`);
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

    // Delegate rendering to SubtitleDisplay
    loadSubtitleData(state.subs);

    updateStatus(`字幕加载完成: ${fileName(filePath)} (${state.subs.length} 条)`);
    stopRealtimeMode();
    state.mode = 'file';
  } catch (err) {
    console.error('Subtitle load error:', err);
    updateStatus('❌ 字幕加载失败');
  }
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

  // Delegate rendering to SubtitleDisplay
  loadSubtitleData(state.subs);

  updateStatus(`📝 ${text}`);
}

/* ── Word Card (F3/F4) — exported for SubtitleDisplay ─ */

let wordCardEl = null;

export function showWordCard(word, context) {
  if (wordCardEl) {
    wordCardEl.remove();
    wordCardEl = null;
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
  wordCardEl = overlay;

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
  if (wordCardEl) {
    wordCardEl.remove();
    wordCardEl = null;
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
