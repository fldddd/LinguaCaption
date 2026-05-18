/**
 * Player Module - 鐐硅鎾斁 -
 *
 * Features:
 *   - 濯掍綋鏂囦欢鎵撳紑锛堣棰?闊抽/锛? *   - SRT/VTT 瀛楀箷瑙ｆ瀽涓庡悓姝? *   - 涓ょ妯″紡锛氭枃浠舵ā寮? 瀹炴椂瀛楀箷妯″紡锛坢ock WebSocket锛? *   - 鐐瑰嚮鍗曡瘝瑙﹀彂璇嶅崱锛團3/F4锛? *
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

/* 鈹€鈹€ State 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

const state = {
  media: null,           // <video> or <audio> element
  mediaFile: '',         // Source audio filename (for API calls)
  subs: [],              // Parsed subtitle entries
  mode: 'file',          // 'file' | 'realtime'
  wsMock: null,          // Mock WebSocket timer
  _blobUrl: '',          // Current blob URL (revoke before creating new one)
};

/* 鈹€鈹€ Persist player state across route switches 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

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
 * 浠?store 鎭㈠ player 鐘舵€侊紙椤甸潰鍒囨崲鍥炴潵鍚庤皟鐢級
 * 鐢?app.js 璺敱 handler 鍦?import player 鍚庤皟鐢? */
export function restorePlayerState() {
  const saved = storeGet(STORE_KEY);
  if (!saved) return;
  if (saved.mediaFile) state.mediaFile = saved.mediaFile;
  if (saved.mode) state.mode = saved.mode;
  if (Array.isArray(saved.subs) && saved.subs.length > 0) {
    state.subs = saved.subs;
    // 鎭㈠瀛楀箷鏄剧ず
    loadSubtitleData(state.subs);
    updateStatus(`瀛楀箷宸叉仮澶?${state.subs.length} 鏉);
  }
}

/* 鈹€鈹€ Init: Watch Mode (video + subtitles) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

export function initPlayer() {
  bindWatchButtons();
}

/* 鈹€鈹€ Init: Point Mode (audio + subtitles only) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

export function initPointMode() {
  bindPointButtons();
}

/* 鈹€鈹€ Button Binding 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

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
      showToast('璇锋嫋鎷芥湁鏁堢殑瑙嗛URL', 'warning');
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
      showToast('璇疯緭鍏ユ湁鏁堢殑瑙嗛URL', 'warning');
      reject(new Error('URL涓虹┖'));
      return;
    }

    if (!isValidHttpUrl(url)) {
      showToast('璇疯緭鍏ユ湁鏁堢殑HTTP/HTTPS URL', 'warning');
      reject(new Error('鏃犳晥鐨刄RL鏍煎紡'));
      return;
    }

    let actualUrl = url;

    // 妫€鏌ユ槸鍚︽槸鐩存帴鐨勫獟浣撴枃浠禪RL
    const mediaExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'];
    const isLikelyWebPage = !mediaExtensions.some(ext => url.toLowerCase().includes(ext));
    if (isLikelyWebPage) {
      // 灏濊瘯浠庤棰戠綉椤垫彁鍙栫湡瀹炶棰戞簮
      console.log('[Player] This looks like a web page, trying to extract video source...');
      updateStatus('灏濊瘯鎻愬彇瑙嗛...');
      
      try {
        const { extractVideoUrl } = await import('./api.js');
        const result = await extractVideoUrl(url);
        if (result.url) {
          // 濡傛灉鏄?proxy_url (闃茬洍閾捐棰戞簮濡侭ilibili)锛屼娇鐢ㄤ唬鐞哢RL
          // 浠ｇ悊URL閫氳繃鍚庣杞彂锛屾坊鍔犱簡 Referer 绛夊繀瑕佽姹傚ご
          if (result.proxy_url) {
            // 璇诲彇鐢ㄦ埛閫夋嫨鐨勪笅娓告祦寮忔ā寮?            const toggle = document.getElementById('toggle-download');
            const mode = toggle?.checked ? 'download' : 'stream';
            const sep = result.proxy_url.includes('?') ? '&' : '?';
            // 璇诲彇鑷畾涔変笅杞界洰褰?            const downloadDir = window.__SETTINGS?.downloadDir || '';
            const dirQuery = downloadDir ? `&download_dir=${encodeURIComponent(downloadDir)}` : '';
            actualUrl = BASE_URL + result.proxy_url + `${sep}mode=${mode}${dirQuery}`;
            console.log('[Player] Using proxy URL:', actualUrl, '(mode:', mode, ', dir:', downloadDir || 'temp');
          } else {
            actualUrl = result.url;
          }
          console.log('[Player] Extracted video URL:', actualUrl);
          showToast('[OK] 瑙嗛婧愭彁鍙栨垚鍔?, 'success');
        }
      } catch (err) {
        console.warn('[Warning] Failed to extract video URL:', err);
        // 缁х画灏濊瘯鐩存帴鍔犺浇
        showToast('鏃犳硶鎻愬彇瑙嗛婧愶紝灏濊瘯鐩存帴鍔犺浇...', 'warning');
      }
    }

    const container = document.getElementById('video-container');
    if (!container) {
      reject(new Error('瑙嗛瀹瑰櫒涓嶅瓨鍦?));
      return;
    }

    updateStatus(`姝ｅ湪鍔犺浇瑙嗛: ${actualUrl}`);

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

    // 鍏堟坊鍔犱簨浠剁洃鍚櫒锛屽啀璁剧疆 src
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
      updateStatus(`鍔犺浇瀹屾垚: ${state.mediaFile}`);
      showToast('[OK] 瑙嗛鍔犺浇鎴愬姛', 'success');
      resolve();
    };

    video.onerror = async () => {
      const mediaError = video.error;
      let errorMsg = '鏈煡閿欒';
      if (mediaError) {
        switch (mediaError.code) {
          case mediaError.MEDIA_ERR_ABORTED:
            errorMsg = '鍔犺浇琚腑鏂?;
            break;
          case mediaError.MEDIA_ERR_NETWORK:
            errorMsg = '缃戠粶閿欒';
            break;
          case mediaError.MEDIA_ERR_DECODE:
            errorMsg = '瑙ｇ爜澶辫触';
            break;
          case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMsg = '涓嶆敮鎸佺殑鏍煎紡鎴栨簮鏃犳晥';
            break;
        }
      }
      console.error('[Error] Video load error:', mediaError, 'code:', mediaError?.code, 'message:', errorMsg);
      
      // 灏濊瘯 CORS 浠ｇ悊鏂规锛氬厛 fetch 鑾峰彇鏁版嵁锛屽啀浣滀负 blob URL 鎾斁
      if (tryFallback && mediaError?.code === mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        console.log('[Player] Trying CORS proxy fallback with fetch...');
        try {
          updateStatus('灏濊瘯澶囩敤鍔犺浇鏂规...');
          const response = await fetch(actualUrl);
          const blob = await response.blob();
          const blobUrl = _createBlobUrl(blob);
          console.log('[Player] Blob created:', blob.size, 'bytes, type:', blob.type);
          
          // 閲嶇疆閿欒鐘舵€侊紝閲嶆柊鍔犺浇
          tryFallback = false;
          video.onerror = () => {
            console.error('[Error] Blob URL also failed');
            updateStatus('瑙嗛鍔犺浇澶辫触');
            showToast('瑙嗛鍔犺浇澶辫触: 鏃犳硶鎾斁', 'error');
            reject(new Error('Blob URL also failed'));
          };
          video.src = blobUrl;
          return;
        } catch (fetchError) {
          console.error('[Error] Fetch fallback also failed:', fetchError);
        }
      }
      
      updateStatus('瑙嗛鍔犺浇澶辫触');
      showToast(`瑙嗛鍔犺浇澶辫触: ${errorMsg}`, 'error');
      reject(new Error(errorMsg));
    };

    // 鍏堟彃鍏?DOM
    container.innerHTML = '';
    container.appendChild(video);

    // 鏈€鍚庤缃?src 鍜?crossOrigin
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
      showToast('璇锋嫋鎷芥湁鏁堢殑闊抽URL', 'warning');
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

/* 鈹€鈹€ Open Media File 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

async function openMedia(type) {
  let filePath = null;
  const defaultPath = window.__SETTINGS?.downloadDir || undefined;

  // 鎵撳紑鏂囦欢閫夋嫨鍣?  if (window.electronAPI && window.electronAPI.openMedia) {
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

  // 璇诲彇鏂囦欢鍒?Blob 浠ヤ緵鎾斁鍜屼笂浼犻兘鐢ㄥ畠
  let fileBlob = null;
  if (window.electronAPI && window.electronAPI.readFile) {
    // Electron 鐜锛氶€氳繃 IPC 璇诲彇鏂囦欢鍐呭
    try {
      const buffer = await window.electronAPI.readFile(filePath);
      // 鏍规嵁鎵╁睍鍚嶈缃纭殑 MIME 绫诲瀷锛堝悗绔彧鎺ュ彈 audio/*绫诲瀷锛?      const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/x-m4a', ogg: 'audio/ogg',
                        mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
                        flac: 'audio/flac', aac: 'audio/aac', mov: 'video/quicktime' };
      const blobType = mimeMap[ext] || (isAudio ? 'audio/mpeg' : 'video/mp4');
      fileBlob = new Blob([buffer], { type: blobType });
    } catch (err) {
      console.error('[Error] Failed to read file via IPC:', err);
      showToast('鏃犳硶璇诲彇鏂囦欢', 'error');
      return;
    }
  } else if (window.__lastFilePickerFile) {
    // 娴忚鍣?file picker锛氱洿鎺ヤ娇鐢ㄧ紦瀛樼殑 File 瀵硅薄
    fileBlob = window.__lastFilePickerFile;
    window.__lastFilePickerFile = null;
  }

  if (fileBlob) {
    // 浣跨敤 blob URL 鎾斁锛堝吋瀹?http://localhost:5173 鐜锛?    state.media.src = _createBlobUrl(fileBlob);
    state.media.blob = fileBlob; // 瀛樿捣鏉ョ粰 transcribeMedia 鐩存帴浣跨敤
  } else {
    // 鍏滃簳锛氱洿鎺ヨ璺緞锛堜粎 Electron file:// 妯″紡鎴栫敓浜х幆澧冩湁鏁堬級
    state.media.src = filePath;
  }

  state.media.load();
  container.appendChild(state.media);

  // 瀛楀箷鍚屾
  const areaId = type === 'audio' ? 'subtitle-area-point' : 'subtitle-area';
  initSubtitleDisplay(state.media, areaId);
  startSync();

  updateFileName(filePath);
  updateStatus(`鎾斁: ${fileName(filePath)}`);
}

/* 鈹€鈹€ Open Subtitle File 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

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

    updateStatus(`瀛楀箷鍔犺浇瀹屾垚: ${fileName(filePath)} (${state.subs.length} 鏉?`);
    stopRealtimeMode();
    state.mode = 'file';
  } catch (err) {
    console.error('Subtitle load error:', err);
    updateStatus('瀛楀箷鍔犺浇澶辫触');
  }
}

/* 鈹€鈹€ Mode Switching 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

export function switchMode(mode) {
  if (mode === state.mode) return;
  stopRealtimeMode();

  if (mode === 'realtime') {
    startRealtimeMode();
  } else {
    state.mode = 'file';
    updateStatus('宸插垏鎹㈠埌鏂囦欢妯″紡');
  }
}

function startRealtimeMode() {
  state.mode = 'realtime';
  state.subs = [];
  const area = document.getElementById('subtitle-area') || document.getElementById('subtitle-area-point');
  if (area) {
    area.innerHTML = '<p class="placeholder-text">绛夊緟瀹炴椂瀛楀箷...</p>';
  }
  updateStatus('瀹炴椂瀛楀箷妯″紡宸插惎鍔?);

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

/* 鈹€鈹€ Word Card (F3/F4) - exported for SubtitleDisplay 鈹€ */

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
        <button class="player-btn" id="word-btn-save">[Save] 鏀惰棌</button>
        <button class="player-btn secondary" id="word-btn-pronounce">[Speak] 鍙戦煶</button>
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
      defEl.textContent = '鏈壘鍒伴噴涔?;
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
      showToast(`"${word}" 宸插湪鐢熻瘝鏈腑`, 'warning');
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
        showToast(`[OK] 宸叉敹钘?${word}`, 'success');
      } else if (result.offline) {
        showToast(`[OK] 宸茬绾挎敹钘?${word}锛堜笂绾垮悗鑷姩鍚屾锛塦, 'success');
      }
      closeWordCard();
    } else {
      showToast('鏀惰棌澶辫触', 'error');
    }
  } catch (err) {
    console.error('Save word failed:', err);
    showToast('鏀惰棌澶辫触', 'error');
  }
}

/* 鈹€鈹€ Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */


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

/* 鈹€鈹€ Load Audio from URL 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

function loadAudioFromUrl() {
  return new Promise(async (resolve, reject) => {
    const urlInput = document.getElementById('point-url-input');
    const url = urlInput?.value?.trim();
    
    if (!url) {
      showToast('璇疯緭鍏ユ湁鏁堢殑闊抽URL', 'warning');
      reject(new Error('URL涓虹┖'));
      return;
    }

    if (!isValidHttpUrl(url)) {
      showToast('璇疯緭鍏ユ湁鏁堢殑HTTP/HTTPS URL', 'warning');
      reject(new Error('鏃犳晥鐨刄RL鏍煎紡'));
      return;
    }

    // 妫€鏌ユ槸鍚︽槸鐩存帴鐨勫獟浣撴枃浠禪RL
    const mediaExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'];
    const isLikelyWebPage = !mediaExtensions.some(ext => url.toLowerCase().includes(ext));
    if (isLikelyWebPage) {
      // 鍏堝皾璇?HEAD 璇锋眰妫€鏌?Content-Type
      console.log('[Player] Checking URL Content-Type...');
      try {
        const headResp = await fetch(url, { method: 'HEAD' });
        const contentType = headResp.headers.get('content-type') || '';
        if (!contentType.startsWith('video/') && !contentType.startsWith('audio/')) {
          showToast('璇疯緭鍏ョ洿鎺ョ殑瑙嗛/闊抽鏂囦欢閾炬帴锛岃€岄潪缃戦〉閾炬帴', 'warning');
          reject(new Error('Not a direct media URL'));
          return;
        }
      } catch {
        // HEAD 璇锋眰澶辫触锛岀粰鐢ㄦ埛璀﹀憡
        showToast('鎻愮ず锛氳纭繚杈撳叆鐨勬槸鐩存帴鐨勮棰?闊抽鏂囦欢閾炬帴锛岃€岄潪缃戦〉閾炬帴', 'warning');
      }
    }

    const container = document.getElementById('audio-container');
    if (!container) {
      reject(new Error('闊抽瀹瑰櫒涓嶅瓨鍦?));
      return;
    }

    updateStatus(`姝ｅ湪鍔犺浇闊抽: ${url}`);

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

    // 鍏堟坊鍔犱簨浠剁洃鍚櫒锛屽啀璁剧疆 src
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
      updateStatus(`鍔犺浇瀹屾垚: ${state.mediaFile}`);
      showToast(`[OK] 闊抽鍔犺浇鎴愬姛`, 'success');
      resolve();
    };

    audio.onerror = async () => {
      const mediaError = audio.error;
      let errorMsg = '鏈煡閿欒';
      if (mediaError) {
        switch (mediaError.code) {
          case mediaError.MEDIA_ERR_ABORTED:
            errorMsg = '鍔犺浇琚腑鏂?;
            break;
          case mediaError.MEDIA_ERR_NETWORK:
            errorMsg = '缃戠粶閿欒';
            break;
          case mediaError.MEDIA_ERR_DECODE:
            errorMsg = '瑙ｇ爜澶辫触';
            break;
          case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMsg = '涓嶆敮鎸佺殑鏍煎紡鎴栨簮鏃犳晥';
            break;
        }
      }
      console.error('[Error] Audio load error:', mediaError, 'code:', mediaError?.code, 'message:', errorMsg);
      
      // 灏濊瘯 CORS 浠ｇ悊鏂规锛氬厛 fetch 鑾峰彇鏁版嵁锛屽啀浣滀负 blob URL 鎾斁
      if (tryFallback && mediaError?.code === mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        console.log('[Player] Trying CORS proxy fallback with fetch...');
        try {
          updateStatus('灏濊瘯澶囩敤鍔犺浇鏂规...');
          const response = await fetch(url);
          const blob = await response.blob();
          const blobUrl = _createBlobUrl(blob);
          console.log('[Player] Blob created:', blob.size, 'bytes, type:', blob.type);
          
          // 閲嶇疆閿欒鐘舵€侊紝閲嶆柊鍔犺浇
          tryFallback = false;
          audio.onerror = () => {
            console.error('[Error] Blob URL also failed');
            updateStatus('闊抽鍔犺浇澶辫触');
            showToast('闊抽鍔犺浇澶辫触: 鏃犳硶鎾斁', 'error');
            reject(new Error('Blob URL also failed'));
          };
          audio.src = blobUrl;
          return;
        } catch (fetchError) {
          console.error('[Error] Fetch fallback also failed:', fetchError);
        }
      }
      
      updateStatus('闊抽鍔犺浇澶辫触');
      showToast(`闊抽鍔犺浇澶辫触: ${errorMsg}`, 'error');
      reject(new Error(errorMsg));
    };

    // 鍏堟彃鍏?DOM
    container.innerHTML = '';
    container.appendChild(audio);

    // 鏈€鍚庤缃?src 鍜?crossOrigin
    audio.crossOrigin = 'anonymous';
    audio.src = url;
    console.log('[Player] Setting audio src:', url);
  });
}

/* 鈹€鈹€ Transcription 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

async function transcribeMedia() {
  if (!state.media) {
    showToast('璇峰厛閫夋嫨濯掍綋鏂囦欢', 'warning');
    return;
  }

  // 妫€娴嬪綋鍓嶆ā寮?  const isPointMode = document.getElementById('btn-point-transcribe') !== null;
  const btnTranscribe = document.getElementById(isPointMode ? 'btn-point-transcribe' : 'btn-watch-transcribe');
  const statusEl = document.getElementById(isPointMode ? 'transcribe-status' : 'watch-transcribe-status');
  
  if (btnTranscribe) btnTranscribe.disabled = true;
  
  try {
    statusEl.textContent = '姝ｅ湪涓婁紶...';
    updateStatus('姝ｅ湪涓婁紶濯掍綋杩涜杞綍...');

    const mediaUrl = state.media.src;
    if (!mediaUrl) {
      showToast('鏃犳硶鑾峰彇濯掍綋鏂囦欢', 'error');
      return;
    }

    console.log('[Player] Media URL:', mediaUrl);
    let blob;

    // 浼樺厛浣跨敤 openMedia() 鏃跺凡璇诲彇鐨?blob锛堟湰鍦版枃浠讹級
    if (state.media.blob) {
      console.log('[Player] Using cached blob from openMedia:', state.media.blob.size, 'bytes');
      blob = state.media.blob;
    } else if (mediaUrl.startsWith('blob:') || mediaUrl.startsWith('data:')) {
      // Blob URL 鍜?Data URL 閫氳繃 fetch 鑾峰彇鍐呭
      console.log('[Player] Fetching blob from URL');
      const blobResponse = await fetch(mediaUrl);
      blob = await blobResponse.blob();
    } else {
      // 缃戠粶 URL
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
      showToast('杞綍浠诲姟鍒涘缓澶辫触', 'error');
      return;
    }

    statusEl.textContent = '姝ｅ湪杞綍...';
    updateStatus('姝ｅ湪杞綍锛岃绋嶅€?..');

    const taskId = result.task_id;
    console.log('[Player] Transcription task created:', taskId);
    
    let attempts = 0;
    const maxAttempts = 180; // 6鍒嗛挓瓒呮椂
    
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
          
          statusEl.textContent = '杞綍瀹屾垚';
          updateStatus(`杞綍瀹屾垚: ${subs.length} 鏉″瓧骞昤);
          showToast(`[OK] 杞綍瀹屾垚锛屽叡 ${subs.length} 鏉″瓧骞昤, 'success');
          
          setTimeout(() => {
            if (statusEl) statusEl.textContent = '';
          }, 3000);
          
          return;
        } else if (transResult.status === 'failed') {
          throw new Error(transResult.message || '杞綍澶辫触');
        } else if (transResult.status === 'processing') {
          statusEl.textContent = `姝ｅ湪杞綍... (${attempts + 1})`;
        }
        
        attempts++;
      } catch (err) {
        console.error('[Error] Transcription poll error:', err);
        throw err;
      }
    }
    
    throw new Error('杞綍瓒呮椂');
    
  } catch (err) {
    console.error('Transcription error:', err);
    statusEl.textContent = '杞綍澶辫触';
    showToast(`杞綍澶辫触: ${err.message}`, 'error');
    updateStatus('杞綍澶辫触');
    
    setTimeout(() => {
      if (statusEl) statusEl.textContent = '';
    }, 3000);
  } finally {
    if (btnTranscribe) btnTranscribe.disabled = false;
  }
}

// 淇濈暀鍘熷嚱鏁板悕浣滀负鍒悕锛屽吋瀹?point 妯″紡
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
    // 濡傛灉娌℃湁segments锛岀敤words鍒嗙粍
    let currentGroup = [];
    let groupStart = 0;
    
    for (const word of words) {
      if (currentGroup.length === 0) {
        groupStart = word.start;
      }
      currentGroup.push(word.word);
      
      // 5涓瘝涓€缁勶紝鎴栬€呴棿闅旇秴杩?绉掑垯鍒嗙粍
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

