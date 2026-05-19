/**
 * utils.js — 统一工具方法模块
 *
 * 提取自 player.js 和 app.js 中的公共方法，
 * 避免代码重复，统一接口。
 */

/**
 * HTML 转义，防止 XSS
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 从路径中提取文件名
 * @param {string} path
 * @returns {string}
 */
export function fileName(path) {
  return path.split(/[/\\]/).pop();
}

/**
 * Toast 通知（统一实现，支持堆叠）
 * @param {string} msg
 * @param {'success'|'error'|'warning'|''} type
 * @param {number} duration - 显示时长(ms)，默认2500
 */
export function showToast(msg, type = '', duration = 2500) {
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
  }, duration);
}

/**
 * 打开文件选择器，返回 blob URL
 * @param {string[]} extensions
 * @returns {Promise<string|null>}
 */
export function openFilePicker(extensions) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.join(',');
    input.onchange = () => resolve(input.files[0] ? URL.createObjectURL(input.files[0]) : null);
    input.click();
  });
}

/**
 * 打开文件选择器，同时返回 File 对象（防止 blob URL 被 GC）
 * @param {string[]} extensions
 * @returns {Promise<{file: File, url: string}|null>}
 */
export function openFilePickerWithRef(extensions) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.join(',');
    input.onchange = () => {
      const file = input.files[0];
      if (file) {
        resolve({ file, url: URL.createObjectURL(file) });
      } else {
        resolve(null);
      }
    };
    input.click();
  });
}

/**
 * 读取文本文件（仅 Electron 环境）
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readTextFile(path) {
  if (window.electronAPI) {
    const resp = await fetch(`file://${path}`);
    return resp.text();
  }
  throw new Error('Text file reading only supported in Electron');
}

/**
 * 判断 URL 是否为直接媒体文件链接
 * @param {string} url
 * @returns {boolean}
 */
export function isDirectMediaUrl(url) {
  const mediaExtensions = ['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.m4a', '.ogg'];
  return mediaExtensions.some(ext => url.toLowerCase().includes(ext));
}

/**
 * 判断 URL 是否为有效 HTTP(S) URL
 * @param {string} url
 * @returns {boolean}
 */
export function isValidHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

/**
 * 解析媒体错误码为可读消息
 * @param {MediaError} mediaError
 * @returns {string}
 */
export function parseMediaError(mediaError) {
  if (!mediaError) return '未知错误';
  switch (mediaError.code) {
    case mediaError.MEDIA_ERR_ABORTED: return '加载被中止';
    case mediaError.MEDIA_ERR_NETWORK: return '网络错误';
    case mediaError.MEDIA_ERR_DECODE: return '解码失败';
    case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: return '不支持的格式或源无效';
    default: return '未知错误';
  }
}

/**
 * 从 Blob 创建可播放的 URL（CORS 代理降级方案）
 * @param {string} url
 * @returns {Promise<{blobUrl: string, size: number, type: string}|null>}
 */
export async function fetchAsBlobUrl(url) {
  const response = await fetch(url);
  const blob = await response.blob();
  return {
    blobUrl: URL.createObjectURL(blob),
    size: blob.size,
    type: blob.type,
  };
}

/**
 * 获取媒体文件的扩展名
 * @param {string} filename
 * @returns {string}
 */
export function getExtension(filename) {
  return (filename || '').split('.').pop().toLowerCase();
}

/**
 * 判断扩展名是否为音频类型
 * @param {string} ext
 * @returns {boolean}
 */
export function isAudioExtension(ext) {
  return ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'].includes(ext);
}

/**
 * 防抖函数
 * @param {Function} fn
 * @param {number} delay
 * @returns {Function}
 */
export function debounce(fn, delay = 300) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * 节流函数
 * @param {Function} fn
 * @param {number} interval
 * @returns {Function}
 */
export function throttle(fn, interval = 200) {
  let lastTime = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastTime >= interval) {
      lastTime = now;
      fn.apply(this, args);
    }
  };
}

/**
 * 格式化文件大小
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/**
 * 生成唯一 ID
 * @returns {string}
 */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
