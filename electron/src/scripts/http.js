/**
 * http.js — 统一网络请求接口
 *
 * 封装所有与后端的 HTTP/WebSocket 通信，
 * 提供统一的错误处理、请求/响应拦截。
 */

import { BASE_URL } from './api.js';

/* ── 通用请求封装 ───────────────────────────────────── */

/**
 * 通用 JSON 请求
 * @param {string} method
 * @param {string} path
 * @param {object|null} body
 * @param {RequestInit} [extraOpts]
 * @returns {Promise<any>}
 */
export async function request(method, path, body = null, extraOpts = {}) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...extraOpts,
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * GET 请求
 * @param {string} path
 * @param {object} [params]
 * @returns {Promise<any>}
 */
export async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `${path}${qs ? '?' + qs : ''}`);
}

/**
 * POST 请求
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<any>}
 */
export async function post(path, body = {}) {
  return request('POST', path, body);
}

/**
 * DELETE 请求
 * @param {string} path
 * @returns {Promise<any>}
 */
export async function del(path) {
  return request('DELETE', path);
}

/**
 * 上传文件（FormData）
 * @param {string} path
 * @param {Blob|File} file
 * @param {string} [filename]
 * @param {object} [extraFields] - 额外的 FormData 字段
 * @returns {Promise<any>}
 */
export async function upload(path, file, filename, extraFields = {}) {
  const formData = new FormData();
  formData.append('file', file, filename);

  for (const [key, value] of Object.entries(extraFields)) {
    formData.append(key, value);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ── WebSocket 封装 ─────────────────────────────────── */

/**
 * 创建 WebSocket 连接（带自动重连）
 * @param {string} path - WebSocket 路径（不含 BASE_URL）
 * @param {object} [options]
 * @param {function} [options.onMessage] - 消息回调
 * @param {function} [options.onOpen] - 连接成功回调
 * @param {function} [options.onClose] - 连接关闭回调
 * @param {function} [options.onError] - 错误回调
 * @param {boolean} [options.reconnect=true] - 是否自动重连
 * @param {number} [options.reconnectInterval=3000] - 重连间隔(ms)
 * @returns {{ ws: WebSocket, send: function, close: function, reconnect: function }}
 */
export function createWebSocket(path, options = {}) {
  const {
    onMessage,
    onOpen,
    onClose,
    onError,
    reconnect = true,
    reconnectInterval = 3000,
  } = options;

  const wsUrl = BASE_URL.replace('http', 'ws') + path;
  let ws = null;
  let reconnectTimer = null;
  let closed = false;

  function connect() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log(`[WS] Connected: ${path}`);
      onOpen?.();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage?.(data);
      } catch {
        onMessage?.(event.data);
      }
    };

    ws.onclose = () => {
      console.log(`[WS] Disconnected: ${path}`);
      onClose?.();
      if (reconnect && !closed) {
        reconnectTimer = setTimeout(connect, reconnectInterval);
      }
    };

    ws.onerror = (err) => {
      console.error(`[WS] Error: ${path}`, err);
      onError?.(err);
    };
  }

  connect();

  return {
    get ws() { return ws; },
    send(data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      }
    },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      ws?.close();
    },
    reconnect() {
      closed = false;
      clearTimeout(reconnectTimer);
      ws?.close();
      connect();
    },
  };
}

/* ── 轮询工具 ───────────────────────────────────────── */

/**
 * 轮询查询任务状态（增强版：支持进度百分比、自适应间隔）
 * @param {string} taskId
 * @param {function} getStatusFn - 返回 Promise<{status, progress, ...}>
 * @param {object} [options]
 * @param {string} [options.targetStatus='completed'] - 目标状态
 * @param {number} [options.interval=2000] - 初始轮询间隔(ms)
 * @param {number} [options.maxAttempts=180] - 最大尝试次数
 * @param {function} [options.onProgress] - 进度回调 (progress, attempt) => void
 * @returns {Promise<any>} 最终任务结果
 */
export async function pollTask(taskId, getStatusFn, options = {}) {
  const {
    targetStatus = 'completed',
    interval = 2000,
    maxAttempts = 180,
    onProgress,
  } = options;

  let lastProgress = 0;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 自适应间隔：前10次快查，之后正常
    const waitMs = attempt < 10 ? Math.min(interval, 1000) : interval;
    await new Promise(resolve => setTimeout(resolve, waitMs));

    const result = await getStatusFn(taskId);

    // 进度回调
    const progress = result.progress || 0;
    if (onProgress) {
      onProgress(progress, attempt + 1);
    }

    if (result.status === targetStatus) {
      return result;
    } else if (result.status === 'failed') {
      throw new Error(result.message || '任务失败');
    }

    lastProgress = progress;
  }

  throw new Error('任务超时');
}

/* ── 健康检查 ───────────────────────────────────────── */

/**
 * 检查后端是否在线（返回详细状态）
 * @returns {Promise<{alive: boolean, db_connected: boolean, ws_connected: boolean, uptime: number|null}>}
 */
export async function isBackendAlive() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const res = await fetch(`${BASE_URL}/api/health`, { 
      signal: controller.signal,
      method: 'GET',
      cache: 'no-cache'
    });
    
    clearTimeout(timeoutId);

    if (res.ok) {
      const data = await res.json();
      return {
        alive: true,
        db_connected: !!data.db_connected,
        ws_connected: !!data.ws_connected,
        uptime: data.uptime ?? null,
      };
    }
    return { alive: false, db_connected: false, ws_connected: false, uptime: null };
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('[Health Check] Request timeout');
    } else {
      console.log('[Health Check] Backend not reachable:', err.message);
    }
    return { alive: false, db_connected: false, ws_connected: false, uptime: null };
  }
}
