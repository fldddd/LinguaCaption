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
import { BASE_URL } from './api.js';
import {
  escapeHtml,
  fileName,
  showToast,
  openFilePicker,
  openFilePickerWithRef,
  isDirectMediaUrl,
  isValidHttpUrl,
  parseMediaError,
  getExtension,
  isAudioExtension
} from './utils.js';
import { get, post, upload, pollTask } from './http.js';

/* ── State ────────────────────────────────────────────── */

const state = {
  media: null,           // <video> or <audio> element
  mediaFile: '',         // Source audio filename (for API calls)
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
  const urlInput = document.getElementById('watch-url-input');
  const btnTranscribe = document.getElementById('btn-watch-transcribe');
  const btnSub = document.getElementById('btn-open-subtitle');

  if (btnFile) btnFile.onclick = () => {
    const url = urlInput?.value?.trim();
    if (url && /^https?:\/\//i.test(url)) {
      loadVideoFromUrl();
    } else {
      openMedia('video');
    }
  };

  if (urlInput) urlInput.onkeydown = (e) => { if (e.key === 'Enter') loadVideoFromUrl(); };

  if (btnTranscribe) btnTranscribe.onclick = () => {
    const url = urlInput?.value?.trim();
    if (url && /^https?:\/\//i.test(url) && !state.media) {
      loadVideoFromUrl().then(() => transcribeMedia());
    } else {
      transcribeMedia();
    }
  };

  if (btnSub) btnSub.onclick = () => openSubtitle('subtitle-area');
  bindWatchDragDrop();
}

function bindWatchDragDrop() {
  const urlInput = document.getElementById('watch-url-input');
  const videoContainer = document.getElementById('video-container');

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.remove('drag-over');
    videoContainer?.classList.remove('drag-over');

    const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');

    if (text) {
      let url = text.trim();

      if (/^https?:\/\//i.test(url)) {
        if (urlInput) urlInput.value = url;
        loadVideoFromUrl();
        return;
      }
    }

    const isMediaFile = e.dataTransfer.files.length > 0;
    if (!isMediaFile) {
      showToast('请拖拽有效的视频URL', 'warning');
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.add('drag-over');
    videoContainer?.classList.add('drag-over');
  }

  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.remove('drag-over');
    videoContainer?.classList.remove('drag-over');
  }

  if (urlInput) {
    urlInput.addEventListener('drop', handleDrop);
    urlInput.addEventListener('dragover', handleDragOver);
    urlInput.addEventListener('dragleave', handleDragLeave);
  }

  if (videoContainer) {
    videoContainer.addEventListener('drop', handleDrop);
    videoContainer.addEventListener('dragover', handleDragOver);
    videoContainer.addEventListener('dragleave', handleDragLeave);
  }
}

/**
 * 从URL加载视频 - 主协调器
 * @returns {Promise<void>}
 */
function loadVideoFromUrl() {
  return new Promise(async (resolve, reject) => {
    const urlInput = document.getElementById('watch-url-input');
    const url = urlInput?.value?.trim();

    if (!url) {
      showToast('请输入有效的视频URL', 'warning');
      reject(new Error('URL为空'));
      return;
    }

    if (!isValidHttpUrl(url)) {
      showToast('请输入有效的HTTP/HTTPS URL', 'warning');
      reject(new Error('无效的URL格式'));
      return;
    }

    const actualUrl = await resolveVideoUrl(url);
    const container = document.getElementById('video-container');
    if (!container) {
      reject(new Error('视频容器不存在'));
      return;
    }

    updateStatus(`正在加载视频: ${actualUrl}`);
    cleanupOldMedia();

    const video = createVideoElement();
    setupVideoEventHandlers(video, actualUrl, container, url, resolve, reject);

    container.innerHTML = '';
    container.appendChild(video);

    video.crossOrigin = 'anonymous';
    video.src = actualUrl;
    console.log('🚀 Setting video src:', actualUrl);
  });
}

/**
 * 解析视频URL，处理代理和提取逻辑
 * @param {string} url - 原始URL
 * @returns {Promise<string>} 解析后的URL
 */
async function resolveVideoUrl(url) {
  const mediaExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'];
  const isLikelyWebPage = !mediaExtensions.some(ext => url.toLowerCase().includes(ext));

  if (!isLikelyWebPage) {
    return url;
  }

  console.log('🔍 This looks like a web page, trying to extract video source...');
  updateStatus('尝试提取视频源...');

  try {
    const { extractVideoUrl } = await import('./api.js');
    const result = await extractVideoUrl(url);
    if (result.url) {
      return buildProxyUrl(result);
    }
  } catch (err) {
    console.warn('⚠️ Failed to extract video URL:', err);
    showToast('无法提取视频源，尝试直接加载...', 'warning');
  }

  return url;
}

/**
 * 构建代理URL
 * @param {Object} result - 提取结果
 * @returns {string} 代理URL
 */
function buildProxyUrl(result) {
  if (result.proxy_url) {
    const toggle = document.getElementById('toggle-download');
    const mode = toggle?.checked ? 'download' : 'stream';
    const sep = result.proxy_url.includes('?') ? '&' : '?';
    const downloadDir = window.__SETTINGS?.downloadDir || '';
    const dirQuery = downloadDir ? `&download_dir=${encodeURIComponent(downloadDir)}` : '';
    const proxyUrl = BASE_URL + result.proxy_url + `${sep}mode=${mode}${dirQuery}`;
    console.log('✅ Using proxy URL:', proxyUrl, '(mode:', mode, ', dir:', downloadDir || 'temp');
    return proxyUrl;
  }
  console.log('✅ Extracted video URL:', result.url);
  showToast('🎬 视频源提取成功', 'success');
  return result.url;
}

/**
 * 创建视频元素
 * @returns {HTMLVideoElement}
 */
function createVideoElement() {
  const video = document.createElement('video');
  video.controls = true;
  video.style.width = '100%';
  video.style.height = '100%';
  return video;
}

/**
 * 清理旧媒体元素
 */
function cleanupOldMedia() {
  const oldMedia = state.media;
  if (oldMedia) {
    oldMedia.pause();
    oldMedia.src = '';
    oldMedia.load();
  }
}

/**
 * 设置视频事件处理器
 * @param {HTMLVideoElement} video - 视频元素
 * @param {string} actualUrl - 实际URL
 * @param {HTMLElement} container - 容器元素
 * @param {string} originalUrl - 原始URL
 * @param {Function} resolve - Promise resolve
 * @param {Function} reject - Promise reject
 */
function setupVideoEventHandlers(video, actualUrl, container, originalUrl, resolve, reject) {
  let tryFallback = true;

  video.onloadedmetadata = () => {
    console.log('📹 Video loaded:', video.videoWidth, 'x', video.videoHeight, 'duration:', video.duration);
  };

  video.oncanplay = () => {
    console.log('✅ Video can play');
    tryFallback = false;
    state.media = video;
    state.mediaFile = fileName(actualUrl.split('?')[0]) || 'remote-video.mp4';

    container.innerHTML = '';
    container.appendChild(video);

    initSubtitleDisplay(video, 'subtitle-area');
    startSync();

    updateFileName(originalUrl);
    updateStatus(`加载完成: ${state.mediaFile}`);
    showToast(`🎬 视频加载成功`, 'success');
    resolve();
  };

  video.onerror = async () => {
    const mediaError = video.error;
    const errorMsg = parseMediaError(mediaError);
    console.error('❌ Video load error:', mediaError, 'code:', mediaError?.code, 'message:', errorMsg);

    if (tryFallback && mediaError?.code === mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      const fallbackSuccess = await tryProxyVideoLoad(video, actualUrl, container, reject);
      if (fallbackSuccess) {
        tryFallback = false;
        return;
      }
    }

    handleVideoError(errorMsg, reject);
  };
}

/**
 * 尝试代理/Blob加载视频
 * @param {HTMLVideoElement} video - 视频元素
 * @param {string} url - URL
 * @param {HTMLElement} container - 容器元素
 * @param {Function} reject - Promise reject
 * @returns {Promise<boolean>} 是否成功
 */
async function tryProxyVideoLoad(video, url, container, reject) {
  console.log('🔄 Trying CORS proxy fallback with fetch...');
  try {
    updateStatus('尝试备用加载方案...');
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    console.log('✅ Blob created:', blob.size, 'bytes, type:', blob.type);

    video.onerror = () => {
      console.error('❌ Blob URL also failed');
      updateStatus('视频加载失败');
      showToast('视频加载失败: 无法播放', 'error');
      reject(new Error('Blob URL also failed'));
    };

    video.src = blobUrl;
    return true;
  } catch (fetchError) {
    console.error('❌ Fetch fallback also failed:', fetchError);
    return false;
  }
}

/**
 * 处理视频加载错误
 * @param {string} errorMsg - 错误消息
 * @param {Function} reject - Promise reject
 */
function handleVideoError(errorMsg, reject) {
  updateStatus('视频加载失败');
  showToast(`视频加载失败: ${errorMsg}`, 'error');
  reject(new Error(errorMsg));
}

function bindPointButtons() {
  const btnAudio = document.getElementById('btn-point-audio');
  const urlInput = document.getElementById('point-url-input');
  const btnTranscribe = document.getElementById('btn-point-transcribe');

  if (btnAudio) btnAudio.onclick = () => {
    const url = urlInput?.value?.trim();
    if (url && /^https?:\/\//i.test(url)) {
      loadAudioFromUrl();
    } else {
      openMedia('audio');
    }
  };

  if (urlInput) urlInput.onkeydown = (e) => { if (e.key === 'Enter') loadAudioFromUrl(); };

  if (btnTranscribe) btnTranscribe.onclick = () => {
    const url = urlInput?.value?.trim();
    if (url && /^https?:\/\//i.test(url) && !state.media) {
      loadAudioFromUrl().then(() => transcribeMedia());
    } else {
      transcribeMedia();
    }
  };

  bindDragDrop();
}

function bindDragDrop() {
  const urlInput = document.getElementById('point-url-input');
  const audioContainer = document.getElementById('audio-container');

  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.remove('drag-over');
    audioContainer?.classList.remove('drag-over');

    const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');

    if (text) {
      let url = text.trim();

      if (/^https?:\/\//i.test(url)) {
        if (urlInput) urlInput.value = url;
        loadAudioFromUrl();
        return;
      }
    }

    const isAudioFile = e.dataTransfer.files.length > 0;
    if (!isAudioFile) {
      showToast('请拖拽有效的音频URL', 'warning');
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.add('drag-over');
    audioContainer?.classList.add('drag-over');
  }

  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.remove('drag-over');
    audioContainer?.classList.remove('drag-over');
  }

  if (urlInput) {
    urlInput.addEventListener('drop', handleDrop);
    urlInput.addEventListener('dragover', handleDragOver);
    urlInput.addEventListener('dragleave', handleDragLeave);
  }

  if (audioContainer) {
    audioContainer.addEventListener('drop', handleDrop);
    audioContainer.addEventListener('dragover', handleDragOver);
    audioContainer.addEventListener('dragleave', handleDragLeave);
  }
}

/* ── Open Media File ─────────────────────────────────── */

async function openMedia(type) {
  let filePath = null;
  const defaultPath = window.__SETTINGS?.downloadDir || undefined;

  if (window.electronAPI && window.electronAPI.openMedia) {
    filePath = await window.electronAPI.openMedia(defaultPath);
  } else {
    const fileObj = await openFilePickerWithRef(['.mp4', '.mkv', '.webm', '.mp3', '.wav', '.m4a']);
    filePath = fileObj.url;
    state._mediaFileRef = fileObj.file;
  }

  if (!filePath) return;

  const containerId = type === 'audio' ? 'audio-container' : 'video-container';
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';

  const ext = getExtension(filePath);
  const isAudio = isAudioExtension(ext);

  state.media = document.createElement(isAudio ? 'audio' : 'video');
  state.media.controls = true;
  state.media.style.width = '100%';
  if (!isAudio) state.media.style.height = '100%';
  state.media.src = filePath;
  state.media.load();

  state.mediaFile = fileName(filePath);
  container.appendChild(state.media);

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

  loadSubtitleData(state.subs);

  updateStatus(`📝 ${text}`);
}

/* ── Word Card (F3/F4) — exported for SubtitleDisplay ─ */

let wordCardEl = null;

/** Store the current word card's subtitle timing for pronounceWord */
let _currentCardWord = '';
let _currentCardStart = 0;
let _currentCardEnd = 0;

export function showWordCard(word, context, start = 0, end = 0) {
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

  _currentCardWord = word.toLowerCase();
  _currentCardStart = start;
  _currentCardEnd = end;

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
  _currentCardWord = '';
  _currentCardStart = 0;
  _currentCardEnd = 0;
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

async function pronounceWord(word) {
  const el = document.querySelector(`.clickable-word[data-word="${escapeHtml(word.toLowerCase())}"]`);
  if (el) {
    el.classList.add('playing');
    setTimeout(() => el.classList.remove('playing'), 600);
  }

  const wordLower = word.toLowerCase();
  const shouldUseApi = state.mediaFile && wordLower === _currentCardWord;
  const start = shouldUseApi ? _currentCardStart : 0;
  const end = shouldUseApi ? _currentCardEnd : 0;

  if (shouldUseApi) {
    try {
      const { getAudioSegment } = await import('./api.js');
      const audioUrl = await getAudioSegment(word, {
        sourceAudio: state.mediaFile,
        start,
        end,
      });

      if (audioUrl) {
        const audio = new Audio(audioUrl);
        audio.play().catch(() => {
          fallbackTTS(word);
        });
        audio.onended = () => URL.revokeObjectURL(audioUrl);
        return;
      }
    } catch {
      // API failed — fall through to TTS
    }
  }

  fallbackTTS(word);
}

function fallbackTTS(word) {
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.9;
  speechSynthesis.speak(utterance);
}

async function saveWord(word, context) {
  try {
    const existing = await import('./storage.js');
    const { getWords, saveFavorite, asyncHasWord } = existing;

    let isDuplicate = false;
    try {
      isDuplicate = await asyncHasWord(word);
    } catch {
      isDuplicate = getWords().some((w) => w.word.toLowerCase() === word.toLowerCase());
    }

    if (isDuplicate) {
      showToast(`"${word}" 已在生词本中`, 'warning');
      return;
    }

    const def = await fetchWordDefinition(word);

    const result = await saveFavorite({
      word: word.toLowerCase(),
      context,
      definition: def?.definition || '',
      phonetic: def?.phonetic || '',
      pos: def?.pos || '',
    });

    if (result.success) {
      if (result.synced) {
        showToast(`📌 已收藏: ${word}`, 'success');
      } else if (result.offline) {
        showToast(`📌 已离线收藏: ${word}（上线后自动同步）`, 'success');
      }
      closeWordCard();
    } else {
      showToast('❌ 收藏失败', 'error');
    }
  } catch (err) {
    console.error('Save word failed:', err);
    showToast('❌ 收藏失败', 'error');
  }
}

/* ── Helpers ─────────────────────────────────────────── */

function updateFileName(path) {
  const el = document.getElementById('file-name') || document.getElementById('point-file-name');
  if (el) el.textContent = fileName(path);
}

async function readTextFile(path) {
  if (window.electronAPI) {
    const resp = await fetch(`file://${path}`);
    return resp.text();
  }
  throw new Error('Text file reading only supported in Electron');
}

/* ── Load Audio from URL ─────────────────────────────── */

/**
 * 从URL加载音频 - 主协调器
 * @returns {Promise<void>}
 */
function loadAudioFromUrl() {
  return new Promise(async (resolve, reject) => {
    const urlInput = document.getElementById('point-url-input');
    const url = urlInput?.value?.trim();

    if (!url) {
      showToast('请输入有效的音频URL', 'warning');
      reject(new Error('URL为空'));
      return;
    }

    if (!isValidHttpUrl(url)) {
      showToast('请输入有效的HTTP/HTTPS URL', 'warning');
      reject(new Error('无效的URL格式'));
      return;
    }

    if (!await validateAudioUrl(url)) {
      reject(new Error('Not a direct media URL'));
      return;
    }

    const container = document.getElementById('audio-container');
    if (!container) {
      reject(new Error('音频容器不存在'));
      return;
    }

    updateStatus(`正在加载音频: ${url}`);
    cleanupOldMedia();

    const audio = createAudioElement();
    setupAudioEventHandlers(audio, url, container, resolve, reject);

    container.innerHTML = '';
    container.appendChild(audio);

    audio.crossOrigin = 'anonymous';
    audio.src = url;
    console.log('🚀 Setting audio src:', url);
  });
}

/**
 * 验证音频URL
 * @param {string} url - URL
 * @returns {Promise<boolean>} 是否有效
 */
async function validateAudioUrl(url) {
  const mediaExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'];
  const isLikelyWebPage = !mediaExtensions.some(ext => url.toLowerCase().includes(ext));

  if (!isLikelyWebPage) {
    return true;
  }

  console.log('🔍 Checking URL Content-Type...');
  try {
    const headResp = await fetch(url, { method: 'HEAD' });
    const contentType = headResp.headers.get('content-type') || '';
    if (!contentType.startsWith('video/') && !contentType.startsWith('audio/')) {
      showToast('请输入直接的视频/音频文件链接，而非网页链接', 'warning');
      return false;
    }
  } catch {
    showToast('提示：请确保输入的是直接的视频/音频文件链接，而非网页链接', 'warning');
  }

  return true;
}

/**
 * 创建音频元素
 * @returns {HTMLAudioElement}
 */
function createAudioElement() {
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.style.width = '100%';
  return audio;
}

/**
 * 设置音频事件处理器
 * @param {HTMLAudioElement} audio - 音频元素
 * @param {string} url - URL
 * @param {HTMLElement} container - 容器元素
 * @param {Function} resolve - Promise resolve
 * @param {Function} reject - Promise reject
 */
function setupAudioEventHandlers(audio, url, container, resolve, reject) {
  let tryFallback = true;

  audio.onloadedmetadata = () => {
    console.log('🎵 Audio loaded:', 'duration:', audio.duration);
  };

  audio.oncanplay = () => {
    console.log('✅ Audio can play');
    tryFallback = false;
    state.media = audio;
    state.mediaFile = fileName(url.split('?')[0]) || 'remote-audio.mp3';

    container.innerHTML = '';
    container.appendChild(audio);

    initSubtitleDisplay(audio, 'subtitle-area-point');
    startSync();

    updateFileName(url);
    updateStatus(`加载完成: ${state.mediaFile}`);
    showToast(`🎵 音频加载成功`, 'success');
    resolve();
  };

  audio.onerror = async () => {
    const mediaError = audio.error;
    const errorMsg = parseMediaError(mediaError);
    console.error('❌ Audio load error:', mediaError, 'code:', mediaError?.code, 'message:', errorMsg);

    if (tryFallback && mediaError?.code === mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      const fallbackSuccess = await fetchAndLoadAudio(audio, url, container, reject);
      if (fallbackSuccess) {
        tryFallback = false;
        return;
      }
    }

    updateAudioUI(url, null, errorMsg, reject);
  };
}

/**
 * 获取Blob并加载音频
 * @param {HTMLAudioElement} audio - 音频元素
 * @param {string} url - URL
 * @param {HTMLElement} container - 容器元素
 * @param {Function} reject - Promise reject
 * @returns {Promise<boolean>} 是否成功
 */
async function fetchAndLoadAudio(audio, url, container, reject) {
  console.log('🔄 Trying CORS proxy fallback with fetch...');
  try {
    updateStatus('尝试备用加载方案...');
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    console.log('✅ Blob created:', blob.size, 'bytes, type:', blob.type);

    audio.onerror = () => {
      console.error('❌ Blob URL also failed');
      updateStatus('音频加载失败');
      showToast('音频加载失败: 无法播放', 'error');
      reject(new Error('Blob URL also failed'));
    };

    audio.src = blobUrl;
    return true;
  } catch (fetchError) {
    console.error('❌ Fetch fallback also failed:', fetchError);
    return false;
  }
}

/**
 * 更新音频UI
 * @param {string} url - URL
 * @param {number|null} size - Blob大小
 * @param {string} errorMsg - 错误消息
 * @param {Function} reject - Promise reject
 */
function updateAudioUI(url, size, errorMsg, reject) {
  updateStatus('音频加载失败');
  showToast(`音频加载失败: ${errorMsg}`, 'error');
  reject(new Error(errorMsg));
}

/* ── Transcription ───────────────────────────────────── */

/**
 * 转录媒体 - 主协调器
 */
async function transcribeMedia() {
  if (!state.media) {
    showToast('请先选择媒体文件', 'warning');
    return;
  }

  const isPointMode = document.getElementById('btn-point-transcribe') !== null;
  const btnTranscribe = document.getElementById(isPointMode ? 'btn-point-transcribe' : 'btn-watch-transcribe');
  const statusEl = document.getElementById(isPointMode ? 'transcribe-status' : 'watch-transcribe-status');

  if (btnTranscribe) btnTranscribe.disabled = true;

  try {
    statusEl.textContent = '⏳ 正在上传...';
    updateStatus('正在上传媒体进行转录...');

    const data = await prepareTranscriptionData();
    if (!data) {
      if (btnTranscribe) btnTranscribe.disabled = false;
      return;
    }

    const result = await uploadAndTranscribe(data);
    if (!result.task_id) {
      showToast('转录任务创建失败', 'error');
      if (btnTranscribe) btnTranscribe.disabled = false;
      return;
    }

    await pollTranscriptionResult(result.task_id, statusEl);
  } catch (err) {
    await handleTranscriptionError(err, statusEl);
  } finally {
    if (btnTranscribe) btnTranscribe.disabled = false;
  }
}

/**
 * 准备转录数据
 * @returns {Promise<Blob|null>} 媒体Blob
 */
async function prepareTranscriptionData() {
  const mediaUrl = state.media.src;
  if (!mediaUrl) {
    showToast('无法获取媒体文件', 'error');
    return null;
  }

  console.log('📡 Media URL:', mediaUrl);

  if (state._mediaFileRef) {
    console.log('🔵 Using saved File reference:', state._mediaFileRef.name, 'size:', state._mediaFileRef.size);
    return state._mediaFileRef;
  }

  if (mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) {
    console.log('🔵 Fetching blob URL:', mediaUrl);
    const blobResponse = await fetch(mediaUrl);
    return await blobResponse.blob();
  }

  if (mediaUrl.startsWith('file://') || mediaUrl.startsWith('/') || mediaUrl.match(/^[A-Za-z]:/)) {
    return await loadLocalFile(mediaUrl);
  }

  return await loadNetworkUrl(mediaUrl);
}

/**
 * 加载本地文件
 * @param {string} mediaUrl - 媒体URL
 * @returns {Promise<Blob|null>}
 */
async function loadLocalFile(mediaUrl) {
  console.log('💾 Loading local file via Electron IPC');
  try {
    if (window.electronAPI && window.electronAPI.readFileAsBase64) {
      const result = await window.electronAPI.readFileAsBase64(mediaUrl);
      const binaryStr = atob(result.data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: result.mime });
      console.log('📦 File loaded via IPC:', result.filename, 'size:', blob.size);
      return blob;
    }
    console.warn('⚠️ electronAPI not available, trying direct fetch');
    const response = await fetch(mediaUrl);
    return await response.blob();
  } catch (err) {
    console.error('❌ Local file read failed:', err);
    showToast('本地文件无法访问: ' + err.message, 'error');
    return null;
  }
}

/**
 * 加载网络URL
 * @param {string} mediaUrl - 媒体URL
 * @returns {Promise<Blob|null>}
 */
async function loadNetworkUrl(mediaUrl) {
  console.log('🌐 Loading network URL');
  try {
    const response = await fetch(mediaUrl);
    return await response.blob();
  } catch (err) {
    console.error('❌ Network fetch failed:', err);
    showToast(`网络获取失败: ${err.message}`, 'error');
    return null;
  }
}

/**
 * 上传并开始转录
 * @param {Blob} blob - 媒体Blob
 * @returns {Promise<Object>} 转录结果
 */
async function uploadAndTranscribe(blob) {
  console.log('📊 Response status: OK');
  console.log('📦 Blob size:', blob.size, 'bytes, type:', blob.type);

  const ext = getExtension(state.mediaFile) || 'mp3';
  const filename = state.mediaFile || `media.${ext}`;

  const { uploadAudio } = await import('./api.js');
  return await uploadAudio(blob, filename);
}

/**
 * 轮询转录结果
 * @param {string} taskId - 任务ID
 * @param {HTMLElement} statusEl - 状态元素
 */
async function pollTranscriptionResult(taskId, statusEl) {
  statusEl.textContent = '🔄 正在转录中...';
  updateStatus('正在转录，请稍候...');

  console.log('🎯 Transcription task created:', taskId);

  const maxAttempts = 180;

  for (let attempts = 0; attempts < maxAttempts; attempts++) {
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      const { getTranscription } = await import('./api.js');
      const transResult = await getTranscription(taskId);
      console.log('🔍 Poll result:', transResult.status, `attempt ${attempts+1}/${maxAttempts}`);

      if (transResult.status === 'completed') {
        await handleTranscriptionSuccess(transResult, statusEl);
        return;
      } else if (transResult.status === 'failed') {
        throw new Error(transResult.message || '转录失败');
      } else if (transResult.status === 'processing') {
        statusEl.textContent = `🔄 正在转录中... (${attempts + 1})`;
      }
    } catch (err) {
      console.error('❌ Transcription poll error:', err);
      throw err;
    }
  }

  throw new Error('转录超时');
}

/**
 * 处理转录成功
 * @param {Object} result - 转录结果
 * @param {HTMLElement} statusEl - 状态元素
 */
async function handleTranscriptionSuccess(result, statusEl) {
  console.log('✅ Transcription completed!');
  const subs = convertToSubtitles(result.segments, result.words);

  state.subs = subs;
  loadSubtitleData(state.subs);

  statusEl.textContent = '✓ 转录完成';
  updateStatus(`转录完成: ${subs.length} 条字幕`);
  showToast(`🎉 转录完成，共 ${subs.length} 条字幕`, 'success');

  setTimeout(() => {
    if (statusEl) statusEl.textContent = '';
  }, 3000);
}

/**
 * 处理转录错误
 * @param {Error} error - 错误对象
 * @param {HTMLElement} statusEl - 状态元素
 */
async function handleTranscriptionError(error, statusEl) {
  console.error('Transcription error:', error);
  statusEl.textContent = '❌ 转录失败';
  showToast(`转录失败: ${error.message}`, 'error');
  updateStatus('转录失败');

  setTimeout(() => {
    if (statusEl) statusEl.textContent = '';
  }, 3000);
}

// 保留原函数名作为别名，兼容 point 模式
const transcribeAudio = transcribeMedia;

function convertToSubtitles(segments, words) {
  const subs = [];
  let id = 1;

  if (segments && segments.length > 0) {
    for (const seg of segments) {
      subs.push({
        id: id++,
        start: seg.start || 0,
        end: seg.end || (seg.start || 0) + 3,
        text: seg.text || '',
      });
    }
  } else if (words && words.length > 0) {
    let currentGroup = [];
    let groupStart = 0;

    for (const word of words) {
      if (currentGroup.length === 0) {
        groupStart = word.start;
      }
      currentGroup.push(word.word);

      if (currentGroup.length >= 5 ||
          (word.end && currentGroup.length > 1 && word.end - groupStart > 3)) {
        subs.push({
          id: id++,
          start: groupStart,
          end: word.end || groupStart + 3,
          text: currentGroup.join(' '),
        });
        currentGroup = [];
      }
    }

    if (currentGroup.length > 0) {
      subs.push({
        id: id++,
        start: groupStart,
        end: groupStart + 3,
        text: currentGroup.join(' '),
      });
    }
  }

  return subs;
}
