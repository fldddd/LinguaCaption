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

async function loadVideoFromUrl() {
  const urlInput = document.getElementById('watch-url-input');
  const url = urlInput?.value?.trim();
  
  if (!url) {
    showToast('请输入有效的视频URL', 'warning');
    return;
  }

  if (!/^https?:\/\//i.test(url)) {
    showToast('请输入有效的HTTP/HTTPS URL', 'warning');
    return;
  }

  const container = document.getElementById('video-container');
  if (!container) return;

  updateStatus(`正在加载视频: ${url}`);

  try {
    state.media = document.createElement('video');
    state.media.controls = true;
    state.media.style.width = '100%';
    state.media.style.height = '100%';
    state.media.src = url;
    
    state.mediaFile = url.split('/').pop().split('?')[0] || 'remote-video.mp4';

    container.innerHTML = '';
    container.appendChild(state.media);

    initSubtitleDisplay(state.media, 'subtitle-area');
    startSync();

    updateFileName(url);
    updateStatus(`加载完成: ${state.mediaFile}`);
    showToast(`🎬 视频加载成功`, 'success');
    
  } catch (err) {
    console.error('Failed to load video from URL:', err);
    updateStatus('视频加载失败');
    showToast(`加载失败: ${err.message}`, 'error');
  }
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

  // Store the media filename for use by the pronunciation API
  state.mediaFile = fileName(filePath);
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
      // API failed — fall through to TTS
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

/* ── Load Audio from URL ─────────────────────────────── */

async function loadAudioFromUrl() {
  const urlInput = document.getElementById('point-url-input');
  const url = urlInput?.value?.trim();
  
  if (!url) {
    showToast('请输入有效的音频URL', 'warning');
    return;
  }

  // 简单的URL验证
  if (!/^https?:\/\//i.test(url)) {
    showToast('请输入有效的HTTP/HTTPS URL', 'warning');
    return;
  }

  const container = document.getElementById('audio-container');
  if (!container) return;

  updateStatus(`正在加载音频: ${url}`);

  try {
    // 创建音频元素
    state.media = document.createElement('audio');
    state.media.controls = true;
    state.media.style.width = '100%';
    state.media.src = url;
    
    // 从URL提取文件名
    state.mediaFile = url.split('/').pop().split('?')[0] || 'remote-audio.mp3';

    container.innerHTML = '';
    container.appendChild(state.media);

    // 初始化字幕显示
    initSubtitleDisplay(state.media, 'subtitle-area-point');
    startSync();

    updateFileName(url);
    updateStatus(`加载完成: ${state.mediaFile}`);
    showToast(`🎵 音频加载成功`, 'success');
    
  } catch (err) {
    console.error('Failed to load audio from URL:', err);
    updateStatus('音频加载失败');
    showToast(`加载失败: ${err.message}`, 'error');
  }
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
    statusEl.textContent = '⏳ 正在上传...';
    updateStatus('正在上传媒体进行转录...');

    const mediaUrl = state.media.src;
    if (!mediaUrl) {
      showToast('无法获取媒体文件', 'error');
      return;
    }

    const response = await fetch(mediaUrl);
    const blob = await response.blob();
    
    const ext = state.mediaFile?.split('.').pop()?.toLowerCase() || 'mp3';
    const filename = state.mediaFile || `media.${ext}`;
    
    const { uploadAudio, getTranscription } = await import('./api.js');
    const result = await uploadAudio(blob, filename);

    if (!result.task_id) {
      showToast('转录任务创建失败', 'error');
      return;
    }

    statusEl.textContent = '🔄 正在转录中...';
    updateStatus('正在转录，请稍候...');

    const taskId = result.task_id;
    let attempts = 0;
    const maxAttempts = 120;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      try {
        const transResult = await getTranscription(taskId);
        
        if (transResult.status === 'completed') {
          const subs = convertToSubtitles(transResult.segments, transResult.words);
          
          state.subs = subs;
          loadSubtitleData(state.subs);
          
          statusEl.textContent = '✓ 转录完成';
          updateStatus(`转录完成: ${subs.length} 条字幕`);
          showToast(`🎉 转录完成，共 ${subs.length} 条字幕`, 'success');
          
          setTimeout(() => {
            if (statusEl) statusEl.textContent = '';
          }, 3000);
          
          return;
        } else if (transResult.status === 'failed') {
          throw new Error(transResult.message || '转录失败');
        }
        
        attempts++;
      } catch (err) {
        console.error('Transcription poll error:', err);
        throw err;
      }
    }
    
    throw new Error('转录超时');
    
  } catch (err) {
    console.error('Transcription error:', err);
    statusEl.textContent = '❌ 转录失败';
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
      
      // 每5个词一组，或者间隔超过1秒则分组
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
