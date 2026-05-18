/**
 * RealtimeSubtitle.js — 实时字幕组件
 *
 * Features:
 *   - 实时字幕显示区域
 *   - 开始/停止转录按钮
 *   - WebSocket 连接到后端
 *   - 连接状态指示器
 *   - 错误处理
 *
 * Uses http.js createWebSocket function for WebSocket connection.
 * Imports showToast from utils.js for notifications.
 */

import { createWebSocket } from './http.js';
import { showToast, escapeHtml, uid } from './utils.js';

/* ── State ────────────────────────────────────────────── */

const state = {
  ws: null,                    // WebSocket connection wrapper
  isConnected: false,          // Connection status
  isTranscribing: false,       // Transcription status
  subtitles: [],               // Real-time subtitle entries
  currentSessionId: null,      // Current transcription session ID
  reconnectAttempts: 0,        // Reconnection attempt counter
  maxReconnectAttempts: 5,     // Maximum reconnection attempts
};

/* ── DOM Elements ─────────────────────────────────────── */

let elements = {
  container: null,
  subtitleDisplay: null,
  btnStart: null,
  btnStop: null,
  statusIndicator: null,
  statusText: null,
  errorMessage: null,
};

/* ── Initialization ──────────────────────────────────── */

/**
 * Initialize the RealtimeSubtitle component
 * @param {string} containerId - ID of the container element
 * @returns {Object} Component API
 */
export function initRealtimeSubtitle(containerId) {
  const container = document.getElementById(containerId);
  if (!container) {
    console.error(`[RealtimeSubtitle] Container #${containerId} not found`);
    return null;
  }

  elements.container = container;
  renderComponent();
  bindEvents();

  return {
    start: startTranscription,
    stop: stopTranscription,
    isConnected: () => state.isConnected,
    isTranscribing: () => state.isTranscribing,
    getSubtitles: () => [...state.subtitles],
    clear: clearSubtitles,
    destroy,
  };
}

/**
 * Render the component HTML structure
 */
function renderComponent() {
  elements.container.innerHTML = `
    <div class="realtime-subtitle-container">
      <div class="realtime-header">
        <h3 class="realtime-title">🎙️ 实时字幕</h3>
        <div class="realtime-status">
          <span class="status-indicator" id="rt-status-indicator"></span>
          <span class="status-text" id="rt-status-text">未连接</span>
        </div>
      </div>
      
      <div class="realtime-controls">
        <button class="player-btn" id="rt-btn-start" title="开始实时转录">
          ▶️ 开始转录
        </button>
        <button class="player-btn secondary" id="rt-btn-stop" disabled title="停止实时转录">
          ⏹️ 停止转录
        </button>
        <button class="player-btn secondary" id="rt-btn-clear" title="清空字幕">
          🗑️ 清空
        </button>
      </div>
      
      <div class="realtime-display" id="rt-subtitle-display">
        <p class="placeholder-text">点击「开始转录」启动实时字幕...</p>
      </div>
      
      <div class="realtime-error" id="rt-error-message"></div>
      
      <div class="realtime-info">
        <span class="info-item">
          <span class="info-label">会话ID:</span>
          <span class="info-value" id="rt-session-id">-</span>
        </span>
        <span class="info-item">
          <span class="info-label">字幕数:</span>
          <span class="info-value" id="rt-subtitle-count">0</span>
        </span>
      </div>
    </div>
  `;

  // Cache DOM references
  elements.subtitleDisplay = document.getElementById('rt-subtitle-display');
  elements.btnStart = document.getElementById('rt-btn-start');
  elements.btnStop = document.getElementById('rt-btn-stop');
  elements.btnClear = document.getElementById('rt-btn-clear');
  elements.statusIndicator = document.getElementById('rt-status-indicator');
  elements.statusText = document.getElementById('rt-status-text');
  elements.errorMessage = document.getElementById('rt-error-message');
}

/**
 * Bind event listeners
 */
function bindEvents() {
  if (elements.btnStart) {
    elements.btnStart.addEventListener('click', startTranscription);
  }
  if (elements.btnStop) {
    elements.btnStop.addEventListener('click', stopTranscription);
  }
  if (elements.btnClear) {
    elements.btnClear.addEventListener('click', clearSubtitles);
  }
}

/* ── WebSocket Connection ─────────────────────────────── */

/**
 * Start real-time transcription
 */
function startTranscription() {
  if (state.isTranscribing) {
    showToast('实时转录已在进行中', 'warning');
    return;
  }

  state.currentSessionId = uid();
  updateSessionId(state.currentSessionId);
  
  try {
    // Create WebSocket connection using http.js createWebSocket
    state.ws = createWebSocket('/ws/realtime-transcribe', {
      onOpen: handleWsOpen,
      onMessage: handleWsMessage,
      onClose: handleWsClose,
      onError: handleWsError,
      reconnect: true,
      reconnectInterval: 3000,
    });

    updateUIState('connecting');
    showToast('正在连接实时转录服务...', 'success');
  } catch (err) {
    console.error('[RealtimeSubtitle] Failed to create WebSocket:', err);
    handleError('创建 WebSocket 连接失败', err);
  }
}

/**
 * Stop real-time transcription
 */
function stopTranscription() {
  if (!state.isTranscribing && !state.ws) {
    showToast('实时转录未启动', 'warning');
    return;
  }

  // Send stop command to backend
  if (state.ws && state.isConnected) {
    state.ws.send({
      type: 'stop',
      sessionId: state.currentSessionId,
    });
  }

  // Close WebSocket connection
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }

  state.isTranscribing = false;
  state.isConnected = false;
  updateUIState('disconnected');
  showToast('实时转录已停止', 'success');
}

/**
 * Handle WebSocket open event
 */
function handleWsOpen() {
  console.log('[RealtimeSubtitle] WebSocket connected');
  state.isConnected = true;
  state.isTranscribing = true;
  state.reconnectAttempts = 0;
  
  updateUIState('connected');
  showToast('实时转录服务已连接', 'success');

  // Send start transcription command
  state.ws.send({
    type: 'start',
    sessionId: state.currentSessionId,
    timestamp: Date.now(),
  });

  // Update display
  if (elements.subtitleDisplay) {
    elements.subtitleDisplay.innerHTML = '<p class="placeholder-text">等待音频输入...</p>';
  }
}

/**
 * Handle WebSocket message event
 * @param {Object} data - Message data from server
 */
function handleWsMessage(data) {
  console.log('[RealtimeSubtitle] Received message:', data);

  switch (data.type) {
    case 'subtitle':
      handleSubtitleMessage(data);
      break;
    case 'partial':
      handlePartialMessage(data);
      break;
    case 'error':
      handleServerError(data);
      break;
    case 'status':
      handleStatusMessage(data);
      break;
    default:
      console.log('[RealtimeSubtitle] Unknown message type:', data.type);
  }
}

/**
 * Handle subtitle message (final result)
 * @param {Object} data - Subtitle data
 */
function handleSubtitleMessage(data) {
  const subtitle = {
    id: state.subtitles.length + 1,
    text: data.text || '',
    start: data.start || Date.now(),
    end: data.end || Date.now(),
    confidence: data.confidence || 0,
    isFinal: true,
  };

  state.subtitles.push(subtitle);
  updateSubtitleDisplay();
  updateSubtitleCount();
}

/**
 * Handle partial transcription message (interim result)
 * @param {Object} data - Partial data
 */
function handlePartialMessage(data) {
  const partialText = data.text || '';
  
  if (elements.subtitleDisplay) {
    // Remove previous partial if exists
    const existingPartial = elements.subtitleDisplay.querySelector('.subtitle-partial');
    if (existingPartial) {
      existingPartial.remove();
    }

    // Add new partial
    if (partialText) {
      const partialEl = document.createElement('div');
      partialEl.className = 'subtitle-item subtitle-partial';
      partialEl.innerHTML = `
        <span class="subtitle-text">${escapeHtml(partialText)}</span>
        <span class="subtitle-indicator">...</span>
      `;
      elements.subtitleDisplay.appendChild(partialEl);
      scrollToBottom();
    }
  }
}

/**
 * Handle status message from server
 * @param {Object} data - Status data
 */
function handleStatusMessage(data) {
  const status = data.status || 'unknown';
  console.log('[RealtimeSubtitle] Server status:', status);
  
  if (elements.statusText) {
    elements.statusText.textContent = getStatusText(status);
  }
}

/**
 * Handle server error message
 * @param {Object} data - Error data
 */
function handleServerError(data) {
  const errorMsg = data.message || '服务器错误';
  console.error('[RealtimeSubtitle] Server error:', errorMsg);
  handleError(errorMsg);
}

/**
 * Handle WebSocket close event
 */
function handleWsClose() {
  console.log('[RealtimeSubtitle] WebSocket closed');
  state.isConnected = false;
  state.isTranscribing = false;
  updateUIState('disconnected');
}

/**
 * Handle WebSocket error event
 * @param {Error} err - Error object
 */
function handleWsError(err) {
  console.error('[RealtimeSubtitle] WebSocket error:', err);
  state.reconnectAttempts++;
  
  if (state.reconnectAttempts >= state.maxReconnectAttempts) {
    handleError('WebSocket 连接失败，已达到最大重试次数');
    stopTranscription();
  } else {
    handleError(`连接错误，正在重试 (${state.reconnectAttempts}/${state.maxReconnectAttempts})...`);
  }
}

/* ── UI Updates ───────────────────────────────────────── */

/**
 * Update the subtitle display
 */
function updateSubtitleDisplay() {
  if (!elements.subtitleDisplay) return;

  if (state.subtitles.length === 0) {
    elements.subtitleDisplay.innerHTML = '<p class="placeholder-text">等待音频输入...</p>';
    return;
  }

  const html = state.subtitles.map((sub, index) => `
    <div class="subtitle-item ${sub.isFinal ? 'subtitle-final' : 'subtitle-partial'}" data-id="${sub.id}">
      <span class="subtitle-index">${index + 1}</span>
      <span class="subtitle-text">${escapeHtml(sub.text)}</span>
      ${sub.confidence ? `<span class="subtitle-confidence">${Math.round(sub.confidence * 100)}%</span>` : ''}
    </div>
  `).join('');

  elements.subtitleDisplay.innerHTML = html;
  scrollToBottom();
}

/**
 * Scroll subtitle display to bottom
 */
function scrollToBottom() {
  if (elements.subtitleDisplay) {
    elements.subtitleDisplay.scrollTop = elements.subtitleDisplay.scrollHeight;
  }
}

/**
 * Update UI state based on connection status
 * @param {string} status - Connection status
 */
function updateUIState(status) {
  const statusConfig = {
    connected: {
      indicatorClass: 'status-connected',
      text: '已连接',
      startDisabled: true,
      stopDisabled: false,
    },
    connecting: {
      indicatorClass: 'status-connecting',
      text: '连接中...',
      startDisabled: true,
      stopDisabled: false,
    },
    disconnected: {
      indicatorClass: 'status-disconnected',
      text: '未连接',
      startDisabled: false,
      stopDisabled: true,
    },
    error: {
      indicatorClass: 'status-error',
      text: '连接错误',
      startDisabled: false,
      stopDisabled: true,
    },
  };

  const config = statusConfig[status] || statusConfig.disconnected;

  // Update status indicator
  if (elements.statusIndicator) {
    elements.statusIndicator.className = 'status-indicator ' + config.indicatorClass;
  }
  if (elements.statusText) {
    elements.statusText.textContent = config.text;
  }

  // Update buttons
  if (elements.btnStart) {
    elements.btnStart.disabled = config.startDisabled;
  }
  if (elements.btnStop) {
    elements.btnStop.disabled = config.stopDisabled;
  }
}

/**
 * Get human-readable status text
 * @param {string} status - Server status
 * @returns {string} Human-readable text
 */
function getStatusText(status) {
  const statusMap = {
    'idle': '空闲',
    'listening': '正在监听',
    'processing': '处理中',
    'error': '错误',
    'completed': '已完成',
  };
  return statusMap[status] || status;
}

/**
 * Update session ID display
 * @param {string} sessionId - Session ID
 */
function updateSessionId(sessionId) {
  const el = document.getElementById('rt-session-id');
  if (el) {
    el.textContent = sessionId ? sessionId.slice(0, 8) + '...' : '-';
  }
}

/**
 * Update subtitle count display
 */
function updateSubtitleCount() {
  const el = document.getElementById('rt-subtitle-count');
  if (el) {
    el.textContent = state.subtitles.length;
  }
}

/* ── Error Handling ──────────────────────────────────── */

/**
 * Handle and display error
 * @param {string} message - Error message
 * @param {Error} [err] - Error object
 */
function handleError(message, err = null) {
  console.error('[RealtimeSubtitle] Error:', message, err);
  
  if (elements.errorMessage) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.style.display = 'block';
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
      if (elements.errorMessage) {
        elements.errorMessage.style.display = 'none';
      }
    }, 5000);
  }

  showToast(`实时字幕错误: ${message}`, 'error');
  updateUIState('error');
}

/* ── Public Methods ──────────────────────────────────── */

/**
 * Clear all subtitles
 */
function clearSubtitles() {
  state.subtitles = [];
  updateSubtitleDisplay();
  updateSubtitleCount();
  showToast('字幕已清空', 'success');
}

/**
 * Destroy the component and clean up resources
 */
function destroy() {
  stopTranscription();
  
  if (elements.container) {
    elements.container.innerHTML = '';
  }

  elements = {
    container: null,
    subtitleDisplay: null,
    btnStart: null,
    btnStop: null,
    statusIndicator: null,
    statusText: null,
    errorMessage: null,
  };

  state.subtitles = [];
  state.currentSessionId = null;
  state.reconnectAttempts = 0;
}

/* ── Export for testing ──────────────────────────────── */

export const __test__ = {
  state,
  elements,
  handleWsMessage,
  handleSubtitleMessage,
  handlePartialMessage,
};
