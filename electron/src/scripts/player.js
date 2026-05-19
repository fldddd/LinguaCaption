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
import { parseSubtitle, formatTime } from './subtitle.js';
import { getSettings } from './settings.js';
import { initSubtitleDisplay, loadSubtitleData, startSync, stopSync, rebindMediaElement } from './SubtitleDisplay.js';
import { BASE_URL } from './api.js';
import { set as storeSet, get as storeGet, forgetPlayerState as storeForgetPlayer, recallPlayerState as storeRecallPlayer } from './store.js';
import { recordSubtitleWords } from './wordFreqPanel.js';
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
    currentTime: state.media ? state.media.currentTime : 0,
    playbackRate: state.media ? state.media.playbackRate : 1,
    volume: state.media ? state.media.volume : 1,
    muted: state.media ? state.media.muted : false,
    isPaused: state.media ? state.media.paused : true,
    sourceUrl: state.media ? state.media.src : '',
    isAudio: state.media ? state.media.tagName === 'AUDIO' : false,
    _blobUrl: state._blobUrl || '',
    containerId: 'media-container',
    subtitleAreaId: 'subtitle-area',
  });
}

/**
 * 为路由切换保存播放器完整状态到 store 的 route key 下
 * 在路由离开前调用，确保状态不会丢失
 *
 * @param {string} routeKey - 'player'
 */
export function savePlayerStateForRoute(routeKey) {
  if (!state.media) return;
  const playerState = {
    mediaFile: state.mediaFile,
    subs: state.subs,
    mode: state.mode,
    currentTime: state.media.currentTime,
    playbackRate: state.media.playbackRate,
    volume: state.media.volume,
    muted: state.media.muted,
    isPaused: state.media.paused,
    sourceUrl: state.media.src,
    isAudio: state.media.tagName === 'AUDIO',
    _blobUrl: state._blobUrl || '',
    containerId: 'media-container',
    subtitleAreaId: 'subtitle-area',
  };
  storeForgetPlayer(routeKey, playerState);
}

/**
 * 从 store 恢复 player 状态（页面切换回来后调用）
 * 由 app.js 路由 handler 在 import player 后调用
 *
 * @param {string} [routeKey] - 可选的 route key，如果提供则从 route 特定存储恢复
 * 如果保存状态中包含媒体 src，则重建 <video>/<audio> 元素并跳转到保存的时间点
 */
export function restorePlayerState(routeKey) {
  let saved;
  if (routeKey) {
    // 优先从 route-specific 存储读取（由 savePlayerStateForRoute 保存）
    saved = storeRecallPlayer(routeKey);
  }
  // 回退到全局 playerState key
  if (!saved) {
    saved = storeGet(STORE_KEY);
  }
  if (!saved) return;
  if (saved.mediaFile) state.mediaFile = saved.mediaFile;
  if (saved.mode) state.mode = saved.mode;
  if (Array.isArray(saved.subs) && saved.subs.length > 0) {
    state.subs = saved.subs;
    // 恢复字幕显示
    loadSubtitleData(state.subs);
    updateStatus(`字幕已恢复: ${state.subs.length} 条`);
  }

  // 如果有 blobUrl 记录，恢复引用以防止内存泄漏
  if (saved._blobUrl) {
    state._blobUrl = saved._blobUrl;
  }

  // 如果有关联的 sourceUrl，重建 media element
  if (saved.sourceUrl && !state.media) {
    _rebuildMediaFromSavedState(saved);
  } else if (state.media && saved.currentTime !== undefined) {
    // media 仍然存在（例如同路由刷新），直接恢复播放位置
    try {
      state.media.currentTime = saved.currentTime;
      if (saved.playbackRate !== undefined) state.media.playbackRate = saved.playbackRate;
      if (saved.volume !== undefined) state.media.volume = saved.volume;
      if (saved.muted !== undefined) state.media.muted = saved.muted;
    } catch (e) {
      console.warn('[Player] Failed to restore media position:', e);
    }
  }
}
}

/**
 * 从保存的状态重建 media element
 * 销毁旧的 media 引用，创建新的 <video>/<audio>，设置 src，等待加载后跳转到保存的时间点
 *
 * @param {object} saved - 保存的播放器状态
 */
function _rebuildMediaFromSavedState(saved) {
  const containerId = saved.containerId || 'media-container';
  const container = document.getElementById(containerId);
  if (!container) {
    console.warn('[Player] Container not found for media restoration:', containerId);
    return;
  }

  // 清理旧的 media 元素（在 player.js state 和 DOM 中）
  if (state.media) {
    state.media.pause();
    state.media.src = '';
    state.media.load();
  }
  state.media = null;

  // 清理 container
  const oldMedia = container.querySelector('video, audio');
  if (oldMedia) oldMedia.remove();
  const placeholder = container.querySelector('.placeholder-text');
  if (placeholder) placeholder.remove();

  // 创建新的 media element
  const tagName = saved.isAudio ? 'audio' : 'video';
  const mediaEl = document.createElement(tagName);
  mediaEl.controls = true;
  mediaEl.style.width = '100%';
  if (!saved.isAudio) mediaEl.style.height = '100%';

  // 恢复播放速率、音量、静音状态
  if (saved.playbackRate !== undefined) mediaEl.playbackRate = saved.playbackRate;
  if (saved.volume !== undefined) mediaEl.volume = saved.volume;
  if (saved.muted !== undefined) mediaEl.muted = saved.muted;

  container.appendChild(mediaEl);

  // 监听 canplay 事件，seek 到保存的时间点
  const savedTime = saved.currentTime || 0;
  const wasPaused = saved.isPaused !== false; // 默认暂停

  mediaEl.addEventListener('canplay', function onCanPlay() {
    mediaEl.removeEventListener('canplay', onCanPlay);
    console.log('[Player] Media rebuilt, seeking to:', savedTime);

    state.media = mediaEl;
    state.mediaFile = saved.mediaFile || state.mediaFile;

    // 跳转到保存的时间点
    try {
      mediaEl.currentTime = savedTime;
    } catch (e) {
      console.warn('[Player] Could not seek:', e);
    }

    // 如果之前正在播放，恢复播放
    if (!wasPaused) {
      mediaEl.play().catch((err) => {
        console.warn('[Player] Could not auto-resume playback:', err);
      });
    }

    // 重新绑定 SubtitleDisplay
    const areaId = saved.subtitleAreaId || 'subtitle-area';
    initSubtitleDisplay(mediaEl, areaId);
    rebindMediaElement(mediaEl);

    // 恢复字幕同步
    if (Array.isArray(saved.subs) && saved.subs.length > 0) {
      state.subs = saved.subs;
    }
    startSync();

    // PiP 按钮更新
    if (!saved.isAudio) {
      updatePiPButton();
      mediaEl.addEventListener('enterpictureinpicture', updatePiPButton);
      mediaEl.addEventListener('leavepictureinpicture', updatePiPButton);
    }

    updateStatus(`播放已恢复: ${state.mediaFile}`);
    showToast('✅ 播放状态已恢复', 'success');
  });

  mediaEl.onerror = () => {
    console.error('[Player] Failed to load media for restoration');
    updateStatus('媒体恢复失败，请重新打开文件');
    showToast('⚠️ 媒体恢复失败，请重新打开文件', 'error');
  };

  // 设置 src 开始加载
  mediaEl.src = saved.sourceUrl;
  console.log('[Player] Restoring media from:', saved.sourceUrl);
}

/* ── Init: Unified Player (video/audio auto-detect) ─── */

export function initPlayer() {
  bindPlayerButtons();
}

/* ── Picture-in-Picture ─────────────────────────────── */

function togglePiP() {
  const video = state.media;
  if (!video) {
    showToast('请先加载视频', 'warning');
    return;
  }

  if (!document.pictureInPictureEnabled) {
    showToast('您的浏览器不支持画中画', 'error');
    return;
  }

  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(err => {
      console.error('[PiP] Exit failed:', err);
    });
  } else {
    video.requestPictureInPicture().catch(err => {
      console.error('[PiP] Enter failed:', err);
      showToast('画中画模式启动失败', 'error');
    });
  }
}

function updatePiPButton() {
  const pipBtn = document.getElementById('pip-btn');
  if (!pipBtn) return;

  if (state.media && document.pictureInPictureEnabled) {
    pipBtn.classList.remove('hidden');
    pipBtn.classList.toggle('active', document.pictureInPictureElement === state.media);
  } else {
    pipBtn.classList.add('hidden');
  }
}

/* ── Seek / Playback Control ──────────────────────────── */

/**
 * Seek the media to a specific time (in seconds).
 * If the media is paused, automatically resume playback.
 * Intended for word-click seek (F6) and other programmatic jumps.
 *
 * @param {number} seconds - Target time in seconds
 */
export function seekTo(seconds) {
  if (!state.media) {
    console.warn('[Player] No media element to seek');
    return;
  }
  const wasPaused = state.media.paused;
  state.media.currentTime = seconds;
  if (wasPaused) {
    state.media.play().catch((err) => {
      console.warn('[Player] Auto-play after seek failed:', err);
    });
  }
}

/* ── Button Binding ──────────────────────────────────── */

function bindPlayerButtons() {
  const btnFile = document.getElementById('btn-open-file');
  const urlInput = document.getElementById('player-url-input');
  const btnTranscribe = document.getElementById('btn-transcribe');
  const btnSub = document.getElementById('btn-open-subtitle');
  
  if (btnFile) btnFile.onclick = () => {
    const url = urlInput?.value?.trim();
    if (url && /^https?:\/\//i.test(url)) {
      loadMediaFromUrl();
    } else {
      openMedia();
    }
  };
  
  if (urlInput) urlInput.onkeydown = (e) => { if (e.key === 'Enter') loadMediaFromUrl(); };
  
  if (btnTranscribe) btnTranscribe.onclick = () => {
    const url = urlInput?.value?.trim();
    if (url && /^https?:\/\//i.test(url) && !state.media) {
      loadMediaFromUrl().then(() => transcribeMedia());
    } else {
      transcribeMedia();
    }
  };
  
  if (btnSub) btnSub.onclick = () => openSubtitle('subtitle-area');

  const pipBtn = document.getElementById('pip-btn');
  if (pipBtn) {
    pipBtn.onclick = () => togglePiP();
  }

  bindPlayerDragDrop();
}

function bindPlayerDragDrop() {
  const urlInput = document.getElementById('player-url-input');
  const mediaContainer = document.getElementById('media-container');
  
  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.remove('drag-over');
    mediaContainer?.classList.remove('drag-over');
    
    const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
    
    if (text) {
      let url = text.trim();
      
      if (/^https?:\/\//i.test(url)) {
        if (urlInput) urlInput.value = url;
        loadMediaFromUrl();
        return;
      }
    }
    
    const hasFile = e.dataTransfer.files.length > 0;
    if (!hasFile) {
      showToast('请拖拽有效的视频或音频URL', 'warning');
    }
  }
  
  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.add('drag-over');
    mediaContainer?.classList.add('drag-over');
  }
  
  function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    urlInput?.classList.remove('drag-over');
    mediaContainer?.classList.remove('drag-over');
  }
  
  if (urlInput) {
    urlInput.addEventListener('drop', handleDrop);
    urlInput.addEventListener('dragover', handleDragOver);
    urlInput.addEventListener('dragleave', handleDragLeave);
  }
  
  if (mediaContainer) {
    mediaContainer.addEventListener('drop', handleDrop);
    mediaContainer.addEventListener('dragover', handleDragOver);
    mediaContainer.addEventListener('dragleave', handleDragLeave);
  }
}
function loadMediaFromUrl() {
  return new Promise(async (resolve, reject) => {
    const urlInput = document.getElementById('player-url-input');
    const url = urlInput?.value?.trim();

    if (!url) {
      showToast('请输入有效的视频/音频URL', 'warning');
      reject(new Error('URL为空'));
      return;
    }

    if (!isValidHttpUrl(url)) {
      showToast('请输入有效的HTTP/HTTPS URL', 'warning');
      reject(new Error('无效的URL格式'));
      return;
    }

    // 自动检测文件类型
    const ext = getExtension(url.split('?')[0].split('/').pop());
    const isAudio = isAudioExtension(ext);

    let actualUrl = url;

    // 检查是否是直接的媒体文件URL
    const mediaExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'];
    const isLikelyWebPage = !mediaExtensions.some(me => url.toLowerCase().includes(me));
    if (isLikelyWebPage) {
      console.log('[Player] This looks like a web page, trying to extract video source...');
      updateStatus('尝试提取视频...');

      try {
        const { extractVideoUrl } = await import('./api.js');
        const result = await extractVideoUrl(url);
        if (result.url) {
          const isDownload = window.__SETTINGS?.downloadEnabled !== false;
          const downloadDir = window.__SETTINGS?.downloadDir || '';
          const dirQuery = downloadDir ? `&download_dir=${encodeURIComponent(downloadDir)}` : '';

          if (result.proxy_url) {
            // 代理URL通过后端转发，添加了 Referer 等必要请求头
            const sep = result.proxy_url.includes('?') ? '&' : '?';
            actualUrl = BASE_URL + result.proxy_url + `${sep}mode=stream${dirQuery}`;
            console.log('[Player] Using proxy URL:', actualUrl);

            // 下载模式：直接保存到本地磁盘，不播放
            if (isDownload) {
              // 从原始 URL 提取文件名
              const urlParts = url.split('/');
              const lastSegment = urlParts[urlParts.length - 1]?.split('?')[0] || '';
              const filename = lastSegment.endsWith('.mp4') || lastSegment.endsWith('.webm') || lastSegment.endsWith('.mkv')
                ? lastSegment
                : `${lastSegment || 'video'}.mp4`;
              updateStatus(`正在下载: ${filename}`);
              try {
                if (window.electronAPI && window.electronAPI.downloadFile) {
                  const dlResult = await window.electronAPI.downloadFile(actualUrl, filename, downloadDir || undefined);
                  const sizeMB = (dlResult.size / 1024 / 1024).toFixed(1);
                  updateStatus(`下载完成: ${filename} (${sizeMB}MB)`);
                  showToast(`✅ 已下载到本地: ${dlResult.path}`, 'success');
                } else {
                  // 非 Electron 环境：走后端下载模式
                  actualUrl = BASE_URL + result.proxy_url + `${result.proxy_url.includes('?') ? '&' : '?'}mode=download${dirQuery}`;
                  showToast('浏览器环境，将通过后端下载', 'info');
                }
              } catch (err) {
                console.error('[Player] Download failed:', err);
                showToast(`下载失败: ${err.message}`, 'error');
                updateStatus('下载失败');
              }
              return; // 下载模式不继续播放
            }
          } else {
            actualUrl = result.url;
          }
          console.log('[Player] Extracted video URL:', actualUrl);
          showToast('[OK] 视频源提取成功', 'success');
        }
      } catch (err) {
        console.warn('[Warning] Failed to extract video URL:', err);
        showToast('无法提取视频源，尝试直接加载...', 'warning');
      }
    }

    const container = document.getElementById('media-container');
    if (!container) {
      reject(new Error('媒体容器不存在'));
      return;
    }

    updateStatus(`正在加载媒体: ${actualUrl}`);

    const oldMedia = state.media;
    if (oldMedia) {
      oldMedia.pause();
      oldMedia.src = '';
      oldMedia.load();
    }

    const tagName = isAudio ? 'audio' : 'video';
    const media = document.createElement(tagName);
    media.controls = true;
    media.style.width = '100%';
    if (!isAudio) media.style.height = '100%';

    let tryFallback = true;

    media.onloadedmetadata = () => {
      console.log('[Player] Media loaded:', tagName, 'duration:', media.duration);
    };

    media.oncanplay = () => {
      console.log('[Player] Media can play');
      tryFallback = false;
      state.media = media;
      state.mediaFile = fileName(actualUrl.split('?')[0]) || `remote-${tagName}.mp4`;
      _savePlayerState();

      const old = container.querySelector('video, audio');
      if (old) old.remove();
      const placeholder = container.querySelector('.placeholder-text');
      if (placeholder) placeholder.remove();
      container.appendChild(media);

      // 更新布局：音频模式垂直排列
      const body = document.getElementById('watch-body');
      if (body) {
        body.classList.toggle('point-mode', isAudio);
      }

      if (!isAudio) {
        updatePiPButton();
        media.addEventListener('enterpictureinpicture', updatePiPButton);
        media.addEventListener('leavepictureinpicture', updatePiPButton);
      }

      initSubtitleDisplay(media, 'subtitle-area');
      startSync();

      updateFileName(url);
      updateStatus(`加载完成: ${state.mediaFile}`);
      showToast('[OK] 媒体加载成功', 'success');
      resolve();
    };

    media.onerror = async () => {
      const mediaError = media.error;
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

      // 尝试 CORS 代理方案
      if (tryFallback && mediaError?.code === mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        console.log('[Player] Trying CORS proxy fallback with fetch...');
        try {
          updateStatus('尝试备用加载方案...');
          const response = await fetch(actualUrl);
          const blob = await response.blob();
          const blobUrl = _createBlobUrl(blob);
          console.log('[Player] Blob created:', blob.size, 'bytes, type:', blob.type);

          tryFallback = false;
          media.onerror = () => {
            console.error('[Error] Blob URL also failed');
            updateStatus('媒体加载失败');
            showToast('媒体加载失败: 无法播放', 'error');
            reject(new Error('Blob URL also failed'));
          };
          media.src = blobUrl;
          return;
        } catch (fetchError) {
          console.error('[Error] Fetch fallback also failed:', fetchError);
        }
      }
      console.error('[Error] Media load error:', mediaError, 'code:', mediaError?.code, 'message:', errorMsg);
      updateStatus('媒体加载失败');
      showToast(`媒体加载失败: ${errorMsg}`, 'error');
      reject(new Error(errorMsg));
    };

    container.innerHTML = '';
    container.appendChild(media);

    media.crossOrigin = 'anonymous';
    media.src = actualUrl;
    console.log('[Player] Setting media src:', actualUrl);
  });
}

/* ── Open Media File ─────────────────────────────────── */

function openMedia() {
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

  const container = document.getElementById('media-container');
  if (!container) return;

  const oldMedia = container.querySelector('video, audio');
  if (oldMedia) {
    oldMedia.remove();
  }
  const placeholder = container.querySelector('.placeholder-text');
  if (placeholder) {
    placeholder.remove();
  }

  const ext = getExtension(filePath);
  const isAudio = isAudioExtension(ext);

  state.media = document.createElement(isAudio ? 'audio' : 'video');
  state.media.controls = true;
  state.media.style.width = '100%';
  if (!isAudio) state.media.style.height = '100%';
  state.mediaFile = fileName(filePath);
  _savePlayerState();

  // 更新布局：音频模式垂直排列
  const body = document.getElementById('watch-body');
  if (body) {
    body.classList.toggle('point-mode', isAudio);
  }

  // 读取文件到 Blob 以供播放和上传都用它
  let fileBlob = null;
  if (window.electronAPI && window.electronAPI.readFile) {
    try {
      const buffer = await window.electronAPI.readFile(filePath);
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
    fileBlob = window.__lastFilePickerFile;
    window.__lastFilePickerFile = null;
  }

  if (fileBlob) {
    state.media.src = _createBlobUrl(fileBlob);
    state.media.blob = fileBlob;
  } else {
    state.media.src = filePath;
  }

  state.media.load();
  container.appendChild(state.media);

  if (!isAudio) {
    updatePiPButton();
    state.media.addEventListener('enterpictureinpicture', updatePiPButton);
    state.media.addEventListener('leavepictureinpicture', updatePiPButton);
  }

  // 字幕同步（统一使用 subtitle-area）
  initSubtitleDisplay(state.media, 'subtitle-area');
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
  const area = document.getElementById('subtitle-area');
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

  // Record words for frequency statistics
  recordSubtitleWords(text, state.mediaFile || 'realtime', text, now, now + 2);

  updateStatus(`📝 ${text}`);
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
        // F1: 增加熟悉度
        import('./learning.js').then(mod => {
          mod.incrementAndCache(word);
        }).catch(() => {});
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
  const el = document.getElementById('file-name');
  if (el) el.textContent = fileName(path);
}

async function readTextFile(path) {
  if (window.electronAPI) {
    const resp = await fetch(`file://${path}`);
    return resp.text();
  }
  throw new Error('Text file reading only supported in Electron');
}

/* ── Transcription ───────────────────────────────────── */

async function transcribeMedia() {
  if (!state.media) {
    showToast('请先选择媒体文件', 'warning');
    return;
  }

  const btnTranscribe = document.getElementById('btn-transcribe');
  const statusEl = document.getElementById('transcribe-status');
  
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
      console.log('[Player] Fetching blob from URL');
      const blobResponse = await fetch(mediaUrl);
      blob = await blobResponse.blob();
    } else {
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

    statusEl.textContent = '正在转录... 0%';
    updateStatus('正在转录，请稍候... 0%');

    const taskId = result.task_id;
    console.log('[Player] Transcription task created:', taskId);
    
    let attempts = 0;
    const maxAttempts = 180; // 6分钟超时
    let lastProgress = 0;
    let staleCount = 0;
    
    while (attempts < maxAttempts) {
      // 自适应轮询间隔：开始时快速，后期可稍慢
      const interval = attempts < 10 ? 1000 : 2000;
      await new Promise(resolve => setTimeout(resolve, interval));
      
      try {
        const transResult = await getTranscription(taskId);
        console.log('[Player] Poll result:', transResult.status, `attempt ${attempts+1}/${maxAttempts}`);
        
        // 显示进度百分比
        const progress = transResult.progress || 0;
        if (progress > 0) {
          statusEl.textContent = `正在转录... ${Math.round(progress)}%`;
          updateStatus(`正在转录... ${Math.round(progress)}%`);
        } else {
          statusEl.textContent = `正在转录... (${attempts + 1})`;
          updateStatus(`正在转录... (${attempts + 1})`);
        }
        
        if (transResult.status === 'completed') {
          console.log('[Player] Transcription completed!');
          const subs = convertToSubtitles(transResult.segments, transResult.words);
          
          state.subs = subs;
          loadSubtitleData(state.subs);
          _savePlayerState();

          // Record words for frequency statistics
          for (const sub of subs) {
            recordSubtitleWords(sub.text, state.mediaFile || 'transcription', sub.text, sub.start, sub.end);
          }

          statusEl.textContent = '转录完成 ✅ 100%';
          updateStatus(`转录完成: ${subs.length} 条字幕`);
          showToast(`[OK] 转录完成，共 ${subs.length} 条字幕`, 'success');
          
          setTimeout(() => {
            if (statusEl) statusEl.textContent = '';
          }, 3000);
          
          return;
        } else if (transResult.status === 'failed') {
          throw new Error(transResult.message || '转录失败');
        }
        
        // 检测进度是否停滞（连续5次无进展）
        if (progress === lastProgress && progress > 0) {
          staleCount++;
          if (staleCount >= 5) {
            // 依然等待完成，但用户能看到进度没变
            statusEl.textContent = `正在转录... ${Math.round(progress)}% (处理中)`;
          }
        } else {
          staleCount = 0;
          lastProgress = progress;
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

function convertToSubtitles(segments, words) {
  const subs = [];
  let id = 1;

  if (segments && segments.length > 0) {
    for (const seg of segments) {
      const wordEntries = [];
      if (seg.words && Array.isArray(seg.words)) {
        for (const w of seg.words) {
          wordEntries.push({
            word: w.word || w.text || '',
            start: w.start || 0,
            end: w.end || 0,
          });
        }
      }
      subs.push({
        id: id++,
        start: seg.start || 0,
        end: seg.end || (seg.start || 0) + 3,
        text: seg.text || '',
        words: wordEntries.length > 0 ? wordEntries : (seg.text || '').split(/\s+/).filter(w => w).map((w, i, arr) => {
          // 如果没有单词级时间戳，根据句子时间戳均分估算
          const segStart = seg.start || 0;
          const segEnd = seg.end || (seg.start || 0) + 3;
          const dur = (segEnd - segStart) / arr.length;
          return { word: w, start: segStart + i * dur, end: segStart + (i + 1) * dur };
        }),
      });
    }
  } else if (words && words.length > 0) {
    // 如果没有segments，用words分组
    let currentGroup = [];
    let groupStart = 0;
    let groupWords = [];

    for (const word of words) {
      if (currentGroup.length === 0) {
        groupStart = word.start;
      }
      currentGroup.push(word.word || word.text || '');
      groupWords.push({
        word: word.word || word.text || '',
        start: word.start || 0,
        end: word.end || 0,
      });

      // 每5个词一组，或者间隔超过3秒则分组
      if (currentGroup.length >= 5 || 
          (word.end && currentGroup.length > 1 && word.end - groupStart > 3)) {
        subs.push({
          id: id++,
          start: groupStart,
          end: word.end || groupStart + 3,
          text: currentGroup.join(' '),
          words: [...groupWords],
        });
        currentGroup = [];
        groupWords = [];
      }
    }

    if (currentGroup.length > 0) {
      subs.push({
        id: id++,
        start: groupStart,
        end: groupStart + 3,
        text: currentGroup.join(' '),
        words: [...groupWords],
      });
    }
  }

  return subs;
}


