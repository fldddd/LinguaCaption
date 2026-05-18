/**
 * Player Module - 点读播放 -
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
import { set as storeSet, get as storeGet } from './store.js';
import {
  escapeHtml,
  fileName,
  showToast,
  openFilePicker,
  openFilePickerWithRef,
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
  _blobUrl: '',          // Current blob URL (revoke before creating new one)
};

/* ── Persist player state across route switches ──────── */

/**
 * Create a blob URL with automatic revoke of the previous one.
 * Prevents memory leaks when media sources are swapped.
 */
function _createBlobUrl(blob) {
  if (state._blobUrl) {
    URL.revokeObjectURL(state._blobUrl);
  }
  state._blobUrl = URL.createObjectURL(blob);
  return state._blobUrl;
}

const STORE_KEY = 'playerState';

function _savePlayerState() {
  storeSet(STORE_KEY, {
    mediaFile: state.mediaFile,
    subs: state.subs,
    mode: state.mode,
  });
}

/**
 * 从 store 恢复 player 状态（页面切换回来后调用）
 * 由 app.js 路由 handler 在 import player 后调用 */
export function restorePlayerState() {
  const saved = storeGet(STORE_KEY);
  if (!saved) return;
  if (saved.mediaFile) state.mediaFile = saved.mediaFile;
  if (saved.mode) state.mode = saved.mode;
  if (Array.isArray(saved.subs) && saved.subs.length > 0) {
    state.subs = saved.subs;
    // 恢复字幕显示
    loadSubtitleData(state.subs);
    updateStatus(`字幕已恢复: ${state.subs.length} 条`);
  }
}

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

    let actualUrl = url;

    // 妫€鏌ユ槸鍚︽槸鐩存帴鐨勫獟浣撴枃浠禪RL
    const mediaExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'];
    const isLikelyWebPage = !mediaExtensions.some(ext => url.toLowerCase().includes(ext));
    if (isLikelyWebPage) {
      // 尝试从视频网页提取真实视频源
      console.log('[Player] This looks like a web page, trying to extract video source...');
      updateStatus('尝试提取视频...');
      
      try {
        const { extractVideoUrl } = await import('./api.js');
        const result = await extractVideoUrl(url);
        if (result.url) {
          // 如果是 proxy_url (防盗链视频源如Bilibili)，使用代理URL
          // 代理URL通过后端转发，添加了 Referer 等必要请求头
          if (result.proxy_url) {
            // 读取用户选择的下流模式
            const toggle = document.getElementById('toggle-download');
            const mode = toggle?.checked ? 'download' : 'stream';
            const sep = result.proxy_url.includes('?') ? '&' : '?';
            // 读取自定义下载目录
            const downloadDir = window.__SETTINGS?.downloadDir || '';
            const dirQuery = downloadDir ? `&download_dir=${encodeURIComponent(downloadDir)}` : '';
            actualUrl = BASE_URL + result.proxy_url + `${sep}mode=${mode}${dirQuery}`;
            console.log('[Player] Using proxy URL:', actualUrl, '(mode:', mode, ', dir:', downloadDir || 'temp', ')');
          } else {
            actualUrl = result.url;
          }
          console.log('[Player] Extracted video URL:', actualUrl);
          showToast('[OK] 视频源提取成功', 'success');
        }
      } catch (err) {
        console.warn('[Warning] Failed to extract video URL:', err);
        // 继续尝试直接加载
        showToast('无法提取视频源，尝试直接加载...', 'warning');
      }
    }

    const container = document.getElementById('video-container');
    if (!container) {
      reject(new Error('视频容器不存在'));
      return;
    }

    updateStatus(`正在加载视频: ${actualUrl}`);

    const oldMedia = state.media;
    if (oldMedia) {
      oldMedia.pause();
      oldMedia.src = '';
      oldMedia.load();
    }

    const video = document.createElement('video');
    video.controls = true;
    video.style.width = '100%';
    video.style.height = '100%';

    let tryFallback = true;

    // 鍏堟坊鍔犱簨浠剁洃鍚櫒锛屽啀设置 src
    video.onloadedmetadata = () => {
      console.log('[Player] Video loaded:', video.videoWidth, 'x', video.videoHeight, 'duration:', video.duration);
    };

    video.oncanplay = () => {
      console.log('[Player] Video can play');
      tryFallback = false;
      state.media = video;
      state.mediaFile = fileName(actualUrl.split('?')[0]) || 'remote-video.mp4';
      _savePlayerState();

      container.innerHTML = '';
      container.appendChild(video);

      initSubtitleDisplay(video, 'subtitle-area');
      startSync();

      updateFileName(url);
      updateStatus(`加载完成: ${state.mediaFile}`);
      showToast('[OK] 视频加载成功', 'success');
      resolve();
    };

    video.onerror = async () => {
      const mediaError = video.error;
      let errorMsg = '未知错误';
      if (mediaError) {
        switch (mediaError.code) {
          case mediaError.MEDIA_ERR_ABORTED:
            errorMsg = '加载被中断';
            break;
          case mediaError.MEDIA_ERR_NETWORK:
            errorMsg = '网络错误';
            break;
          case mediaError.MEDIA_ERR_DECODE:
            errorMsg = '解码失败';
            break;
          case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMsg = '不支持的格式或源无效';
            break;
        }
      }
      console.error('[Error] Video load error:', mediaError, 'code:', mediaError?.code, 'message:', errorMsg);
      
      // 尝试 CORS 代理方案：先 fetch 获取数据，再作为 blob URL 播放
      if (tryFallback && mediaError?.code === mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        console.log('[Player] Trying CORS proxy fallback with fetch...');
        try {
          updateStatus('尝试备用加载方案...');
          const response = await fetch(actualUrl);
          const blob = await response.blob();
          const blobUrl = _createBlobUrl(blob);
          console.log('[Player] Blob created:', blob.size, 'bytes, type:', blob.type);
          
          // 重置错误状态，重新加载
          tryFallback = false;
          video.onerror = () => {
            console.error('[Error] Blob URL also failed');
            updateStatus('视频加载失败');
            showToast('视频加载失败: 无法播放', 'error');
            reject(new Error('Blob URL also failed'));
          };
          video.src = blobUrl;
          return;
        } catch (fetchError) {
          console.error('[Error] Fetch fallback also failed:', fetchError);
        }
      }
      
      updateStatus('视频加载失败');
      showToast(`视频加载失败: ${errorMsg}`, 'error');
      reject(new Error(errorMsg));
    };

    // 先插入 DOM
    container.innerHTML = '';
    container.appendChild(video);

    // 最后设置 src 和 crossOrigin
    video.crossOrigin = 'anonymous';
    video.src = actualUrl;
    console.log('[Player] Setting video src:', actualUrl);
  });
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
      showToast('璇锋嫋鎷芥湁鏁堢殑音频URL', 'warning');
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

  // 打开文件选择器
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
  state.mediaFile = fileName(filePath);
  _savePlayerState();

  // 读取文件到 Blob 以供播放和上传都用它
  let fileBlob = null;
  if (window.electronAPI && window.electronAPI.readFile) {
    // Electron 环境：通过 IPC 读取文件内容
    try {
      const buffer = await window.electronAPI.readFile(filePath);
      // 根据扩展名设置正确的 MIME 类型（后端只接受 audio/*类型）
      const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/x-m4a', ogg: 'audio/ogg',
                        mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
                        flac: 'audio/flac', aac: 'audio/aac', mov: 'video/quicktime' };
      const blobType = mimeMap[ext] || (isAudio ? 'audio/mpeg' : 'video/mp4');
      fileBlob = new Blob([buffer], { type: blobType });
    } catch (err) {
      console.error('[Error] Failed to read file via IPC:', err);
      showToast('无法读取文件', 'error');
      return;
    }
  } else if (window.__lastFilePickerFile) {
    // 浏览器 file picker：直接使用缓存的 File 对象
    fileBlob = window.__lastFilePickerFile;
    window.__lastFilePickerFile = null;
  }

  if (fileBlob) {
    // 使用 blob URL 播放（兼容 http://localhost:5173 环境）
    state.media.src = _createBlobUrl(fileBlob);
    state.media.blob = fileBlob; // 存起来给 transcribeMedia 直接使用
  } else {
    // 兜底：直接设路径（仅 Electron file:// 模式或生产环境有效）
    state.media.src = filePath;
  }

  state.media.load();
  container.appendChild(state.media);

  // 字幕同步
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
    _savePlayerState();

    // Delegate rendering to SubtitleDisplay
    loadSubtitleData(state.subs);

    updateStatus(`字幕加载完成: ${fileName(filePath)} (${state.subs.length}  条`);
    stopRealtimeMode();
    state.mode = 'file';
  } catch (err) {
    console.error('Subtitle load error:', err);
    updateStatus('字幕加载失败');
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
  updateStatus('实时字幕模式已启动');

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

  updateStatus(`[Subtitle] ${text}`);
}

/* ── Word Card (F3/F4) - exported for SubtitleDisplay ─ */

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
        <button class="word-card-close" id="word-card-close">X</button>
      </div>
      <div class="word-card-pos skeleton" style="height:18px;width:60px;"></div>
      <div class="word-card-phonetic skeleton" style="height:16px;width:100px;margin:6px 0 10px;"></div>
      <div class="word-card-definition skeleton" id="word-def-text" style="height:40px;"></div>
      <div class="word-card-context">"${escapeHtml(context)}"</div>
      <div class="word-card-actions">
        <button class="player-btn" id="word-btn-save">[Save] 收藏</button>
        <button class="player-btn secondary" id="word-btn-pronounce">[Speak] 发音</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  wordCardEl = overlay;

  // Store word + subtitle timing for pronounceWord
  _currentCardWord = word.toLowerCase();
  _currentCardStart = start;
  _currentCardEnd = end;

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
  // Visual feedback on the clicked word element
  const el = document.querySelector(`.clickable-word[data-word="${escapeHtml(word.toLowerCase())}"]`);
  if (el) {
    el.classList.add('playing');
    setTimeout(() => el.classList.remove('playing'), 600);
  }

  // Try real API audio segment first
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
          // If audio fails to play, fall through to TTS
          fallbackTTS(word);
        });
        // Clean up blob URL after playback
        audio.onended = () => URL.revokeObjectURL(audioUrl);
        return;
      }
    } catch {
      // API failed - fall through to TTS
    }
  }

  // Fallback: browser SpeechSynthesis
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

    // Check duplicate (async IndexedDB first, fallback to sync localStorage)
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

    // Use F6.2 sync service: local-first + backend sync
    const result = await saveFavorite({
      word: word.toLowerCase(),
      context,
      definition: def?.definition || '',
      phonetic: def?.phonetic || '',
      pos: def?.pos || '',
    });

    if (result.success) {
      if (result.synced) {
        showToast(`[OK] 已收藏 ${word}`, 'success');
      } else if (result.offline) {
        showToast(`[OK] 已离线收藏 ${word}（上线后自动同步）`, 'success');
      }
      closeWordCard();
    } else {
      showToast('收藏失败', 'error');
    }
  } catch (err) {
    console.error('Save word failed:', err);
    showToast('收藏失败', 'error');
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

    // 妫€鏌ユ槸鍚︽槸鐩存帴鐨勫獟浣撴枃浠禪RL
    const mediaExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'];
    const isLikelyWebPage = !mediaExtensions.some(ext => url.toLowerCase().includes(ext));
    if (isLikelyWebPage) {
      // 先尝试 HEAD 请求检查 Content-Type
      console.log('[Player] Checking URL Content-Type...');
      try {
        const headResp = await fetch(url, { method: 'HEAD' });
        const contentType = headResp.headers.get('content-type') || '';
        if (!contentType.startsWith('video/') && !contentType.startsWith('audio/')) {
          showToast('请输入直接的视频/音频文件链接，而非网页链接', 'warning');
          reject(new Error('Not a direct media URL'));
          return;
        }
      } catch {
        // HEAD 请求失败锛岀粰用户警告
        showToast('提示：请确保输入的是直接的视频/音频文件链接，而非网页链接', 'warning');
      }
    }

    const container = document.getElementById('audio-container');
    if (!container) {
      reject(new Error('音频容器不存在'));
      return;
    }

    updateStatus(`正在加载音频: ${url}`);

    const oldMedia = state.media;
    if (oldMedia) {
      oldMedia.pause();
      oldMedia.src = '';
      oldMedia.load();
    }

    const audio = document.createElement('audio');
    audio.controls = true;
    audio.style.width = '100%';

    let tryFallback = true;

    // 鍏堟坊鍔犱簨浠剁洃鍚櫒锛屽啀设置 src
    audio.onloadedmetadata = () => {
      console.log('[Player] Audio loaded:', 'duration:', audio.duration);
    };

    audio.oncanplay = () => {
      console.log('[Player] Audio can play');
      tryFallback = false;
      state.media = audio;
      state.mediaFile = url.split('/').pop().split('?')[0] || 'remote-audio.mp3';
      _savePlayerState();

      container.innerHTML = '';
      container.appendChild(audio);

      initSubtitleDisplay(audio, 'subtitle-area-point');
      startSync();

      updateFileName(url);
      updateStatus(`加载完成: ${state.mediaFile}`);
      showToast(`[OK] 音频加载成功`, 'success');
      resolve();
    };

    audio.onerror = async () => {
      const mediaError = audio.error;
      let errorMsg = '未知错误';
      if (mediaError) {
        switch (mediaError.code) {
          case mediaError.MEDIA_ERR_ABORTED:
            errorMsg = '加载被中断';
            break;
          case mediaError.MEDIA_ERR_NETWORK:
            errorMsg = '网络错误';
            break;
          case mediaError.MEDIA_ERR_DECODE:
            errorMsg = '解码失败';
            break;
          case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMsg = '不支持的格式或源无效';
            break;
        }
      }
      console.error('[Error] Audio load error:', mediaError, 'code:', mediaError?.code, 'message:', errorMsg);
      
      // 尝试 CORS 代理方案：先 fetch 获取数据，再作为 blob URL 播放
      if (tryFallback && mediaError?.code === mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        console.log('[Player] Trying CORS proxy fallback with fetch...');
        try {
          updateStatus('尝试备用加载方案...');
          const response = await fetch(url);
          const blob = await response.blob();
          const blobUrl = _createBlobUrl(blob);
          console.log('[Player] Blob created:', blob.size, 'bytes, type:', blob.type);
          
          // 重置错误状态，重新加载
          tryFallback = false;
          audio.onerror = () => {
            console.error('[Error] Blob URL also failed');
            updateStatus('音频加载失败');
            showToast('音频加载失败: 无法播放', 'error');
            reject(new Error('Blob URL also failed'));
          };
          audio.src = blobUrl;
          return;
        } catch (fetchError) {
          console.error('[Error] Fetch fallback also failed:', fetchError);
        }
      }
      
      updateStatus('音频加载失败');
      showToast(`音频加载失败: ${errorMsg}`, 'error');
      reject(new Error(errorMsg));
    };

    // 先插入 DOM
    container.innerHTML = '';
    container.appendChild(audio);

    // 最后设置 src 和 crossOrigin
    audio.crossOrigin = 'anonymous';
    audio.src = url;
    console.log('[Player] Setting audio src:', url);
  });
}

/* ── Transcription ───────────────────────────────────── */

async function transcribeMedia() {
  if (!state.media) {
    showToast('请先选择媒体文件', 'warning');
    return;
  }

  // 检测当前模式
  const isPointMode = document.getElementById('btn-point-transcribe') !== null;
  const btnTranscribe = document.getElementById(isPointMode ? 'btn-point-transcribe' : 'btn-watch-transcribe');
  const statusEl = document.getElementById(isPointMode ? 'transcribe-status' : 'watch-transcribe-status');
  
  if (btnTranscribe) btnTranscribe.disabled = true;
  
  try {
    statusEl.textContent = '正在上传...';
    updateStatus('正在上传媒体进行转录...');

    const mediaUrl = state.media.src;
    if (!mediaUrl) {
      showToast('无法获取媒体文件', 'error');
      return;
    }

    console.log('[Player] Media URL:', mediaUrl);
    let blob;

    // 优先使用 openMedia() 时已读取的 blob（本地文件）
    if (state.media.blob) {
      console.log('[Player] Using cached blob from openMedia:', state.media.blob.size, 'bytes');
      blob = state.media.blob;
    } else if (mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) {
      // Blob URL 和 Data URL 通过 fetch 获取内容
      console.log('[Player] Fetching blob from URL');
      const blobResponse = await fetch(mediaUrl);
      blob = await blobResponse.blob();
    } else {
      // 网络 URL
      console.log('[Player] Fetching network URL');
      const response = await fetch(mediaUrl);
      blob = await response.blob();
    }

    console.log('[Player] Response status: OK');
    console.log('[Player] Blob size:', blob.size, 'bytes, type:', blob.type);
    
    const ext = state.mediaFile?.split('.').pop()?.toLowerCase() || 'mp3';
    const filename = state.mediaFile || `media.${ext}`;
    
    const { uploadAudio, getTranscription } = await import('./api.js');
    const result = await uploadAudio(blob, filename);

    if (!result.task_id) {
      showToast('转录任务创建失败', 'error');
      return;
    }

    statusEl.textContent = '正在转录...';
    updateStatus('正在转录，请稍候...');

    const taskId = result.task_id;
    console.log('[Player] Transcription task created:', taskId);
    
    let attempts = 0;
    const maxAttempts = 180; // 6鍒嗛挓超时
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        const transResult = await getTranscription(taskId);
        console.log('[Player] Poll result:', transResult.status, `attempt ${attempts+1}/${maxAttempts}`);
        
        if (transResult.status === 'completed') {
          console.log('[Player] Transcription completed!');
          const subs = convertToSubtitles(transResult.segments, transResult.words);
          
          state.subs = subs;
          loadSubtitleData(state.subs);
          _savePlayerState();
          
          statusEl.textContent = '转录完成';
          updateStatus(`转录完成: ${subs.length} 条字幕`);
          showToast(`[OK] 转录完成，共 ${subs.length} 条字幕`, 'success');
          
          setTimeout(() => {
            if (statusEl) statusEl.textContent = '';
          }, 3000);
          
          return;
        } else if (transResult.status === 'failed') {
          throw new Error(transResult.message || '转录失败');
        } else if (transResult.status === 'processing') {
          statusEl.textContent = `正在转录... (${attempts + 1})`;
        }
        
        attempts++;
      } catch (err) {
        console.error('[Error] Transcription poll error:', err);
        throw err;
      }
    }
    
    throw new Error('转录超时');
    
  } catch (err) {
    console.error('Transcription error:', err);
    statusEl.textContent = '转录失败';
    showToast(`转录失败: ${err.message}`, 'error');
    updateStatus('转录失败');
    
    setTimeout(() => {
      if (statusEl) statusEl.textContent = '';
    }, 3000);
  } finally {
    if (btnTranscribe) btnTranscribe.disabled = false;
  }
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
    // 如果没有segments，用words分组
    let currentGroup = [];
    let groupStart = 0;
    
    for (const word of words) {
      if (currentGroup.length === 0) {
        groupStart = word.start;
      }
      currentGroup.push(word.word);
      
      // 5个词一组，或者间隔超过3秒则分组
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

