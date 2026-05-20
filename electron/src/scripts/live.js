/**
 * LinguaCaption - Live Transcription Module
 * Real-time audio transcription with advanced features
 * F3: Recording mode + learning data pipeline
 */

import { exportTranscript as exporterExport } from './live-transcript-exporter.js';
import { addWord, uploadAudio, getTranscription, incrementFamiliarity } from './api.js';
import { initLearning } from './learning.js';
import log from './logger.js';

// === Real-time transcription state ===
let ws = null;
let audioWs = null;
let isTranscribing = false;
let isPaused = false;
let timerInterval = null;
let elapsedSeconds = 0;
let allSegments = [];
let currentFontSize = 18;
let audioLevelInterval = null;
let isLightTheme = false;
let manualStop = false;

// === Recording mode state (F3) ===
let currentMode = 'realtime';       // 'realtime' | 'recording'
let isRecording = false;
let mediaRecorder = null;
let recordingChunks = [];
let recordingTimerInterval = null;
let recordingSeconds = 0;
let transcriptionTaskId = null;
let transcriptionPollTimer = null;

// Config
// WebSocket URLs — 使用 Vite 代理 (dev) 或直连 (Electron)
// Vite 代理 /api → localhost:8000 (含 WebSocket)
const WS_BASE = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
const WS_HOST = window.location.host; // dev: localhost:5173 (通过Vite代理) / electron: localhost:8000
const WS_URL = `${WS_BASE}${WS_HOST}`;
const SUBTITLE_WS = `${WS_URL}/api/ws/subtitle/realtime`;
const AUDIO_WS = `${WS_URL}/api/ws/audio/status`;

/**
 * Initialize the live transcription page
 */
export function initLive(container) {
  renderLivePage(container);
    bindEvents();
  log.info("[Live] Initialized");
}

/**
 * Render the live page HTML
 */
function renderLivePage(container) {
  // container passed from router
  if (!container) return;

  const bars = Array(12).fill(0).map(() => '<div class="live-audio-bar" style="height: 4px;"></div>').join("");

  container.innerHTML = `
    <div class="live-container" id="live-container">
      <!-- Header -->
      <div class="live-header">
        <div class="live-title">转录</div>
        <div class="live-audio-viz" id="audio-viz">
          ${bars}
        </div>
        <div class="live-header-actions">
          <button class="live-icon-btn" id="btn-mode-toggle" title="切换模式">🎙️ 录音</button>
          <button class="live-icon-btn" id="btn-theme" title="切换主题">🌙</button>
        </div>
      </div>

      <!-- Mode indicator -->
      <div class="live-mode-bar">
        <span class="live-mode-tag" id="mode-tag">🔄 实时转录</span>
      </div>

      <!-- Controls: Real-time mode -->
      <div class="live-controls" id="live-realtime-controls">
        <div class="live-control-group">
          <label>音频源</label>
          <select class="live-select" id="live-source">
            <option value="system">🖥️ 系统音频</option>
            <option value="microphone">🎤 麦克风</option>
          </select>
        </div>

        <div class="live-control-group">
          <label>设备</label>
          <select class="live-select" id="live-device">
            <option value="-1">默认设备</option>
          </select>
        </div>

        <div class="live-control-group">
          <label>模型</label>
          <select class="live-select" id="live-model">
            <option value="tiny">Tiny (快)</option>
            <option value="base" selected>Base (平衡)</option>
            <option value="small">Small (准)</option>
          </select>
        </div>

        <div class="live-control-group">
          <label>语言</label>
          <select class="live-select" id="live-lang">
            <option value="zh">中文</option>
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="auto">自动检测</option>
          </select>
        </div>

        <div style="margin-left: auto; display: flex; gap: 12px;">
          <button class="live-btn live-btn-primary" id="btn-start">
            <span>▶️</span> 开始
          </button>
          <button class="live-btn live-btn-secondary" id="btn-pause" disabled>
            <span>⏸️</span> 暂停
          </button>
          <button class="live-btn live-btn-danger" id="btn-stop" disabled>
            <span>⏹️</span> 停止
          </button>
        </div>
      </div>

      <!-- Controls: Recording mode -->
      <div class="live-controls" id="live-recording-controls" style="display: none;">
        <div class="live-recording-panel">
          <div class="live-recording-status" id="recording-status">
            <div class="live-recording-dot" id="recording-dot"></div>
            <span id="recording-status-text">准备录音</span>
          </div>
          <div class="live-recording-timer" id="recording-timer">00:00</div>
          <div class="live-recording-actions">
            <button class="live-btn live-btn-danger" id="btn-record-start">
              <span>🔴</span> 开始录音
            </button>
            <button class="live-btn live-btn-primary" id="btn-record-stop" disabled>
              <span>⏹️</span> 停止并转录
            </button>
            <button class="live-btn live-btn-secondary" id="btn-record-cancel" disabled>
              <span>🗑️</span> 取消
            </button>
          </div>
        </div>
      </div>

      <!-- Status Bar -->
      <div class="live-status-bar">
        <div class="live-status-indicator">
          <div class="live-status-dot live-status-idle" id="status-dot"></div>
          <span class="live-status-text" id="status-text">就绪</span>
        </div>
        <div class="live-timer" id="timer">00:00</div>
      </div>

      <!-- Transcript Area -->
      <div class="live-transcript-container">
        <div class="live-transcript-header">
          <span class="live-transcript-title">转录内容</span>
          <div class="live-transcript-actions">
            <div class="live-font-size-control">
              <span style="font-size: 12px; color: rgba(255,255,255,0.4);">A</span>
              <input type="range" class="live-slider" id="font-size-slider" 
                     min="14" max="32" value="18">
              <span style="font-size: 16px; color: rgba(255,255,255,0.4);">A</span>
            </div>
          </div>
        </div>
        <div class="live-transcript" id="transcript">
          <div class="live-empty-state">
            <div class="live-empty-state-icon">🎙️</div>
            <div class="live-empty-state-text">点击「开始」启动实时转录</div>
          </div>
        </div>
      </div>

      <!-- Toolbar -->
      <div class="live-toolbar">
        <div class="live-toolbar-left">
          <button class="live-icon-btn" id="btn-clear" title="清空 (Ctrl+L)">🗑️</button>
          <button class="live-icon-btn" id="btn-copy" title="复制全部">📋</button>
        </div>
        <div class="live-toolbar-right">
          <button class="live-icon-btn" id="btn-export-srt" title="导出 SRT">📝</button>
          <button class="live-icon-btn" id="btn-export-txt" title="导出 TXT">📄</button>
          <button class="live-icon-btn" id="btn-export-json" title="导出 JSON">📊</button>
          <button class="live-icon-btn" id="btn-help" title="快捷键">⌨️</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Bind all event listeners
 */
function bindEvents() {
  // Main controls
  document.getElementById("btn-start")?.addEventListener("click", startTranscription);
  document.getElementById("btn-pause")?.addEventListener("click", togglePause);
  document.getElementById("btn-stop")?.addEventListener("click", stopTranscription);
  
  // Mode switch
  document.getElementById("btn-mode-toggle")?.addEventListener("click", toggleMode);
  
  // Recording controls (F3)
  document.getElementById("btn-record-start")?.addEventListener("click", startRecording);
  document.getElementById("btn-record-stop")?.addEventListener("click", stopRecording);
  document.getElementById("btn-record-cancel")?.addEventListener("click", cancelRecording);
  
  // Toolbar
  document.getElementById("btn-clear")?.addEventListener("click", clearTranscript);
  document.getElementById("btn-copy")?.addEventListener("click", copyAllText);
  document.getElementById("btn-export-srt")?.addEventListener("click", () => exportTranscript("srt"));
  document.getElementById("btn-export-txt")?.addEventListener("click", () => exportTranscript("txt"));
  document.getElementById("btn-export-json")?.addEventListener("click", () => exportTranscript("json"));
  document.getElementById("btn-help")?.addEventListener("click", showHelp);
  document.getElementById("btn-theme")?.addEventListener("click", toggleTheme);
  
  // Font size
  document.getElementById("font-size-slider")?.addEventListener("input", (e) => {
    currentFontSize = parseInt(e.target.value);
    updateFontSize();
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", handleKeyboard);
}

/**
 * Connect to audio status WebSocket for device list and audio levels
 */
function connectAudioStatus() {
  // Close existing connection if any
  if (audioWs) {
    try { audioWs.close(); } catch (e) { /* ignore */ }
    audioWs = null;
  }

  try {
    audioWs = new WebSocket(AUDIO_WS);
    
    audioWs.onopen = () => {
      console.log("[Live] Audio status connected");
      loadDevices();
    };

    audioWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio_devices") {
          updateDeviceList(msg.data);
        } else if (msg.type === "audio_status") {
          updateAudioLevel(msg.data.level || 0);
        }
      } catch (e) {
        console.warn("[Live] Audio status parse error:", e);
      }
    };

    audioWs.onerror = (err) => {
      console.error("[Live] Audio status error:", err);
      // 静默处理 — 不弹 toast
    };
  } catch (err) {
    console.error("[Live] Failed to connect audio status:", err);
  }
}

/**
 * Load available audio devices
 */
function loadDevices() {
  if (audioWs?.readyState === WebSocket.OPEN) {
    audioWs.send(JSON.stringify({ type: "devices" }));
  }
}

/**
 * Update device dropdown
 */
function updateDeviceList(devices) {
  const select = document.getElementById("live-device");
  if (!select || !devices) return;

  const currentValue = select.value;
  select.innerHTML = '<option value="-1">默认设备</option>';

  // 兼容后端返回格式: 数组 或 {devices: [...]}
  const deviceList = Array.isArray(devices) ? devices : (devices.devices || []);
  deviceList.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = device.name || `设备 ${index + 1}`;
    select.appendChild(option);
  });

  select.value = currentValue;
}

/**
 * Update audio visualization
 */
function updateAudioLevel(level) {
  const bars = document.querySelectorAll(".live-audio-bar");
  bars.forEach((bar, index) => {
    const threshold = (index + 1) / bars.length;
    const height = level > threshold ? 4 + Math.random() * 28 : 4;
    bar.style.height = `${height}px`;
  });
}

/**
 * Start transcription
 */
function startTranscription() {
  const source = document.getElementById("live-source")?.value || "system";
  const model = document.getElementById("live-model")?.value || "base";
  const lang = document.getElementById("live-lang")?.value || "zh";

  manualStop = false;
  connectAudioStatus();
  connectWithRetry(source, model, lang, 0, 1);
}

/**
 * Connect WebSocket with exponential backoff retry
 */
function connectWithRetry(source, model, lang, retryCount, delay) {
  if (manualStop) return;

  if (retryCount > 0) {
    updateStatus("connecting", `重连中... (${retryCount}/5)`);
    console.log(`[Live] Reconnecting (${retryCount}/5)...`);
  } else {
    updateStatus("connecting", "连接中...");
  }

  try {
    ws = new WebSocket(SUBTITLE_WS);
  } catch (err) {
    updateStatus("error", "连接失败");
    console.error("[Live] Connection failed:", err.message);
    return;
  }

  ws.onopen = () => {
    // Reset retry state on successful connection
    retryCount = 0;

    isTranscribing = true;
    isPaused = false;
    elapsedSeconds = 0;

    // Start timer
    timerInterval = setInterval(() => {
      if (!isPaused) {
        elapsedSeconds++;
        updateTimer();
      }
    }, 1000);

    // Start audio visualization
    startAudioViz();

    // Send start command
    ws.send(JSON.stringify({
      type: "start",
      language: lang,
      model: model,
    }));

    // Use system audio source
    ws.send(JSON.stringify({
      type: "use_source",
      source: source,
    }));

    updateStatus("listening", "正在聆听...");
    updateButtons({ start: false, pause: true, stop: true });
    clearTranscript();

    console.log("[Live] Transcription started");
  };

  ws.onmessage = handleWebSocketMessage;

  ws.onerror = () => {
    updateStatus("error", "连接出错");
    console.error("[Live] WebSocket 连接错误");
  };

  ws.onclose = () => {
    if (manualStop) {
      // User manually stopped, do not reconnect
      stopTranscription();
      return;
    }

    if (isTranscribing) {
      if (retryCount < 5) {
        const nextDelay = Math.min(delay * 2, 30);
        const nextRetry = retryCount + 1;
        updateStatus("connecting", `重连中... (${nextRetry}/5)`);
        console.log(`[Live] Reconnecting in ${delay}s (attempt ${nextRetry}/5)`);

        setTimeout(() => {
          connectWithRetry(source, model, lang, nextRetry, nextDelay);
        }, delay * 1000);
      } else {
        updateStatus("error", "重连失败");
        console.error("[Live] 重连失败，请手动重新开始");
        stopTranscription();
      }
    }
  };
}

/**
 * Handle WebSocket messages
 */
function handleWebSocketMessage(event) {
  try {
    const msg = JSON.parse(event.data);
    
    switch (msg.type) {
      case "subtitle":
        handleSubtitle(msg.data);
        break;
      case "status":
        handleStatus(msg.data);
        break;
      case "audio_status":
        updateAudioLevel(msg.data?.level || 0);
        break;
    }
  } catch (e) {
    console.warn("[Live] Parse error:", e);
  }
}

/**
 * Handle subtitle message
 */
function handleSubtitle(data) {
  const { text, words, is_final } = data || {};
  if (!text) return;

  if (is_final) {
    appendFinalSegment(text, words);
  } else {
    updateInterimSegment(text);
  }
}

/**
 * Handle status message
 */
function handleStatus(data) {
  const { state } = data || {};
  const statusMap = {
    "listening": "正在聆听...",
    "transcribing": "转录中...",
    "paused": "已暂停",
    "error": "出错",
  };
  updateStatus(state, statusMap[state] || state);
}

/**
 * Toggle pause/resume
 */
function togglePause() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  
  isPaused = !isPaused;
  ws.send(JSON.stringify({ type: isPaused ? "pause" : "resume" }));
  
  const btn = document.getElementById("btn-pause");
  if (btn) {
    btn.innerHTML = isPaused ? "<span>▶️</span> 继续" : "<span>⏸️</span> 暂停";
  }
  
  updateStatus(isPaused ? "paused" : "transcribing", isPaused ? "已暂停" : "转录中...");
}

/**
 * Stop transcription
 */
function stopTranscription() {
  manualStop = true;
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
  }
  
  isTranscribing = false;
  isPaused = false;
  
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  
  stopAudioViz();
  // Close audio status WS
  if (audioWs) {
    try { audioWs.close(); } catch (e) { /* ignore */ }
    audioWs = null;
  }
  ws = null;

  updateStatus("idle", "已停止");
  updateButtons({ start: true, pause: false, stop: false });
  
  // Reset pause button
  const btn = document.getElementById("btn-pause");
  if (btn) {
    btn.innerHTML = "<span>⏸️</span> 暂停";
  }
}

// ══════════════════════════════════════════════════════════════
// F3.1: Recording Mode
// ══════════════════════════════════════════════════════════════

/**
 * Toggle between real-time and recording mode
 */
function toggleMode() {
  if (isTranscribing || isRecording) return;  // 不允许正在运行时切换

  const newMode = currentMode === 'realtime' ? 'recording' : 'realtime';
  switchMode(newMode);
}

/**
 * Switch transcription mode
 */
function switchMode(mode) {
  // 停止当前模式的所有活动
  if (isTranscribing) stopTranscription();
  if (isRecording) cancelRecording();

  currentMode = mode;
  const realtimeControls = document.getElementById("live-realtime-controls");
  const recordingControls = document.getElementById("live-recording-controls");
  const modeTag = document.getElementById("mode-tag");
  const modeBtn = document.getElementById("btn-mode-toggle");

  if (mode === 'recording') {
    if (realtimeControls) realtimeControls.style.display = "none";
    if (recordingControls) recordingControls.style.display = "flex";
    if (modeTag) modeTag.textContent = "🎙️ 录音转录";
    if (modeBtn) modeBtn.textContent = "🔄 实时";
  } else {
    if (realtimeControls) realtimeControls.style.display = "flex";
    if (recordingControls) recordingControls.style.display = "none";
    if (modeTag) modeTag.textContent = "🔄 实时转录";
    if (modeBtn) modeBtn.textContent = "🎙️ 录音";
  }

  // 重置转录区
  clearTranscript();
  console.log(`[Live] Switched to ${mode} mode`);
}

/**
 * Start recording — 使用 MediaRecorder + getUserMedia
 */
async function startRecording() {
  try {
    // 请求麦克风权限
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 初始化 MediaRecorder
    const mimeType = getSupportedMimeType();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    recordingChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordingChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      // 停止所有音轨
      stream.getTracks().forEach(track => track.stop());
    };

    // 开始录制
    mediaRecorder.start(100);  // 每100ms收集数据
    isRecording = true;

    // 更新 UI
    updateRecordingUI('recording');
    setRecordingButtons({ start: false, stop: true, cancel: true });

    // 启动计时器
    recordingSeconds = 0;
    updateRecordingTimer();
    recordingTimerInterval = setInterval(() => {
      recordingSeconds++;
      updateRecordingTimer();
    }, 1000);

    console.log("[Live] Recording started");
    showToast("录音已开始", "info");
  } catch (err) {
    console.warn("[Live] Failed to start recording:", err);
    showToast("无法启动录音: " + err.message, "error");
  }
}

/**
 * Get supported MIME type for MediaRecorder
 */
function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/wav',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

/**
 * Stop recording — 将录音数据上传到后端转录
 */
async function stopRecording() {
  if (!isRecording || !mediaRecorder) return;

  return new Promise((resolve) => {
    const recorder = mediaRecorder;
    const chunks = recordingChunks;

    recorder.onstop = async () => {
      isRecording = false;
      mediaRecorder = null;

      // 停止计时器
      if (recordingTimerInterval) {
        clearInterval(recordingTimerInterval);
        recordingTimerInterval = null;
      }

      // 停止所有音轨（已在 onstop 中处理）
      updateRecordingUI('processing');
      setRecordingButtons({ start: false, stop: false, cancel: false });

      try {
        // 构建音频 Blob
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        const filename = `recording-${Date.now()}.webm`;

        // 上传到后端
        updateRecordingUI('uploading');
        showToast("正在上传录音...", "info");
        const uploadResult = await uploadAudio(blob, filename);
        transcriptionTaskId = uploadResult.task_id;

        console.log("[Live] Audio uploaded, task_id:", transcriptionTaskId);

        // 轮询转录结果
        updateRecordingUI('transcribing');
        showToast("正在转录...", "info");
        const result = await pollTranscriptionTask(transcriptionTaskId);

        if (result.status === 'completed') {
          // 显示转录结果
          displayRecordingResult(result);

          // F3.2: 将单词接入学习数据流程
          updateRecordingUI('learning');
          processTranscriptionWords(result);
        } else {
          showToast("转录失败: " + (result.message || "未知错误"), "error");
        }
      } catch (err) {
        console.warn("[Live] Recording transcription failed:", err);
        showToast("转录失败: " + err.message, "error");
      }

      resetRecordingUI();
      resolve();
    };

    recorder.stop();
  });
}

/**
 * Cancel recording without processing
 */
function cancelRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.ondataavailable = null;
    mediaRecorder.onstop = null;
    mediaRecorder.stop();
  }
  isRecording = false;
  mediaRecorder = null;
  recordingChunks = [];

  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }

  resetRecordingUI();
  console.log("[Live] Recording cancelled");
}

/**
 * Poll transcription task until completed or failed
 */
async function pollTranscriptionTask(taskId) {
  const maxAttempts = 180;   // 最多轮询 180 次（6分钟）
  const interval = 2000;     // 每 2 秒检查一次

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, interval));

    try {
      const result = await getTranscription(taskId);
      console.log(`[Live] Poll task ${attempt + 1}/${maxAttempts}: ${result.status}`);

      if (result.status === 'completed') return result;
      if (result.status === 'failed') return result;
    } catch (err) {
      console.warn("[Live] Poll error:", err.message);
    }
  }

  // 超时
  showToast("转录超时", "warning");
  return { status: 'failed', message: '转录超时' };
}

/**
 * Display recording transcription result in transcript area
 */
function displayRecordingResult(result) {
  const container = document.getElementById("transcript");
  if (!container) return;

  // 清除空状态
  const empty = container.querySelector(".live-empty-state");
  if (empty) empty.remove();

  // 清除旧内容
  container.innerHTML = "";

  const segments = result.segments || [];
  const words = result.words || [];

  // 如果没有分段但有文本，创建一条
  if (segments.length === 0 && result.text) {
    segments.push({ id: 0, start: 0, end: recordingSeconds, text: result.text });
  }

  segments.forEach((seg, idx) => {
    const segment = document.createElement("div");
    segment.className = "live-segment final";

    const startMin = Math.floor(seg.start / 60);
    const startSec = Math.floor(seg.start % 60);
    const timeStr = `${String(startMin).padStart(2, "0")}:${String(startSec).padStart(2, "0")}`;

    // 构建单词 HTML，带学习状态检测
    const segWords = extractWordsFromSegment(seg.text);
    const wordHtml = segWords.map(w => {
      const escaped = escapeHtml(w);
      return `<span class="live-word" data-word="${escaped}">${escaped}</span>`;
    }).join(" ") || escapeHtml(seg.text);

    segment.innerHTML = `
      <span class="live-segment-time">${timeStr}</span>
      <span class="live-segment-text" style="font-size: ${currentFontSize}px;">${wordHtml}</span>
    `;

    // 绑定单词点击事件
    segment.querySelectorAll(".live-word").forEach(wordEl => {
      wordEl.addEventListener("click", () => handleWordClick(wordEl.dataset.word));
    });

    container.appendChild(segment);
  });

  // 保存到 segments 数组
  const fullText = segments.map(s => s.text).join(" ");
  allSegments.push({
    time: formatTime(recordingSeconds),
    text: fullText,
    words: words,
  });

  container.scrollTop = container.scrollHeight;
  showToast("转录完成", "success");
}

/**
 * Extract individual words from segment text (simple split)
 */
function extractWordsFromSegment(text) {
  if (!text) return [];
  // 按空格分割，过滤标点符号
  return text.split(/\s+/).filter(w => w.trim().length > 0);
}

// ══════════════════════════════════════════════════════════════
// F3.2: Learning Data Pipeline — 录音单词接入学习系统
// ══════════════════════════════════════════════════════════════

/**
 * Process all words from transcription result through learning pipeline
 * 对于每个单词:
 *   1. 尝试 incrementFamiliarity(word) — 如果已在词库，熟悉度+1
 *   2. 如果返回 404，调用 addWord({word, context}) 先添加再 increment
 *   3. 最后重新加载低熟悉度单词列表
 */
async function processTranscriptionWords(result) {
  const segments = result.segments || [];
  const allWords = [];

  // 收集所有单词
  segments.forEach(seg => {
    const words = extractWordsFromSegment(seg.text);
    words.forEach(w => {
      // 过滤纯标点符号和非字母单词（中文保留）
      const cleaned = w.replace(/[.,!?;:""''()\[\]{}<>\/\-]/g, '').trim();
      if (cleaned.length > 0 && /[a-zA-Z\u4e00-\u9fff]/.test(cleaned)) {
        allWords.push(cleaned);
      }
    });
  });

  // 去重
  const uniqueWords = [...new Set(allWords.map(w => w.toLowerCase()))];
  console.log(`[Learning] Processing ${uniqueWords.length} unique words from recording`);

  // 逐个处理
  let addedCount = 0;
  let incrementedCount = 0;

  for (const word of uniqueWords) {
    try {
      // 尝试 increment — 如果词已在词库，熟悉度+1
      await incrementFamiliarity(word);
      incrementedCount++;
    } catch (err) {
      // 404: 单词不在词库 -> 先 add 再 increment
      if (err.message && err.message.includes('404')) {
        try {
          await addWord({
            word: word,
            context: `录音转录: ${segments[0]?.text?.substring(0, 100) || ''}`,
          });
          addedCount++;
          // 添加后再 increment
          try {
            await incrementFamiliarity(word);
            incrementedCount++;
          } catch (e) {
            console.warn(`[Learning] Failed to increment after add: ${word}`, e.message);
          }
        } catch (addErr) {
          console.warn(`[Learning] Failed to add word: ${word}`, addErr.message);
        }
      } else {
        console.warn(`[Learning] Failed to process word: ${word}`, err.message);
      }
    }
  }

  console.log(`[Learning] Recording words processed: ${addedCount} added, ${incrementedCount} incremented`);

  // 重新加载低熟悉度单词列表
  try {
    await initLearning();
    console.log("[Learning] Unfamiliar words cache refreshed");
  } catch (err) {
    console.warn("[Learning] Failed to refresh unfamiliar words:", err);
  }

  showToast(`已处理 ${uniqueWords.length} 个单词 (+${addedCount} 新增)`, "success");
}

// ══════════════════════════════════════════════════════════════
// Recording UI helpers
// ══════════════════════════════════════════════════════════════

/**
 * Update recording timer display
 */
function updateRecordingTimer() {
  const el = document.getElementById("recording-timer");
  if (el) el.textContent = formatTime(recordingSeconds);
}

/**
 * Update recording status indicator
 */
function updateRecordingUI(state) {
  const dot = document.getElementById("recording-dot");
  const text = document.getElementById("recording-status-text");
  if (!dot || !text) return;

  const states = {
    'idle': { cls: 'live-recording-dot-idle', text: '准备录音' },
    'recording': { cls: 'live-recording-dot-active', text: '正在录音...' },
    'processing': { cls: 'live-recording-dot-processing', text: '处理中...' },
    'uploading': { cls: 'live-recording-dot-uploading', text: '上传中...' },
    'transcribing': { cls: 'live-recording-dot-transcribing', text: '转录中...' },
    'learning': { cls: 'live-recording-dot-learning', text: '添加生词中...' },
    'done': { cls: 'live-recording-dot-done', text: '完成' },
  };

  const s = states[state] || states.idle;
  dot.className = 'live-recording-dot ' + s.cls;
  text.textContent = s.text;
}

/**
 * Set recording buttons enabled/disabled state
 */
function setRecordingButtons({ start, stop, cancel }) {
  const btnStart = document.getElementById("btn-record-start");
  const btnStop = document.getElementById("btn-record-stop");
  const btnCancel = document.getElementById("btn-record-cancel");

  if (btnStart) btnStart.disabled = !start;
  if (btnStop) btnStop.disabled = !stop;
  if (btnCancel) btnCancel.disabled = !cancel;
}

/**
 * Reset recording UI to idle state
 */
function resetRecordingUI() {
  updateRecordingUI('idle');
  setRecordingButtons({ start: true, stop: false, cancel: false });
  const timer = document.getElementById("recording-timer");
  if (timer) timer.textContent = "00:00";
}

/**
 * Append final segment with clickable words
 */
function appendFinalSegment(text, words) {
  const container = document.getElementById("transcript");
  if (!container) return;

  // Remove empty state
  const empty = container.querySelector(".live-empty-state");
  if (empty) empty.remove();

  // Remove interim segment
  const interim = container.querySelector(".live-segment.interim");
  if (interim) interim.remove();

  // Create segment with clickable words
  const segment = document.createElement("div");
  segment.className = "live-segment final";
  
  const time = formatTime(elapsedSeconds);
  const wordHtml = words?.map(w => 
    `<span class="live-word" data-word="${escapeHtml(w.word)}" data-start="${w.start}" data-end="${w.end}">${escapeHtml(w.word)}</span>`
  ).join(" ") || escapeHtml(text);
  
  segment.innerHTML = `
    <span class="live-segment-time">${time}</span>
    <span class="live-segment-text" style="font-size: ${currentFontSize}px;">${wordHtml}</span>
  `;
  
  // Bind word click events
  segment.querySelectorAll(".live-word").forEach(wordEl => {
    wordEl.addEventListener("click", () => handleWordClick(wordEl.dataset.word));
  });
  
  container.appendChild(segment);
  container.scrollTop = container.scrollHeight;

  // Save to segments array
  allSegments.push({ time, text, words });
}

/**
 * Update interim segment
 */
function updateInterimSegment(text) {
  const container = document.getElementById("transcript");
  if (!container) return;

  let interim = container.querySelector(".live-segment.interim");
  
  if (!interim) {
    interim = document.createElement("div");
    interim.className = "live-segment interim";
    container.appendChild(interim);
  }
  
  const time = formatTime(elapsedSeconds);
  interim.innerHTML = `
    <span class="live-segment-time">${time}</span>
    <span class="live-segment-text" style="font-size: ${currentFontSize}px;">${escapeHtml(text)}</span>
  `;
  
  container.scrollTop = container.scrollHeight;
}

/**
 * Handle word click - show definition and add to vocabulary
 */
function handleWordClick(word) {
  console.log("[Live] Word clicked:", word);
  showWordPopup(word);
}

/**
 * Show word popup with actions
 */
function showWordPopup(word) {
  // Remove existing popup
  document.querySelectorAll(".live-word-popup").forEach(p => p.remove());

  const popup = document.createElement("div");
  popup.className = "live-word-popup";
  popup.innerHTML = `
    <div class="live-word-popup-header">${escapeHtml(word)}</div>
    <div style="color: rgba(255,255,255,0.6); font-size: 14px;">点击收藏添加到生词本</div>
    <div class="live-word-popup-actions">
      <button class="live-btn live-btn-primary" id="popup-add-vocab" style="padding: 8px 16px; font-size: 13px;">⭐ 收藏</button>
      <button class="live-btn live-btn-secondary" id="popup-pronounce" style="padding: 8px 16px; font-size: 13px;">🔊 发音</button>
      <button class="live-btn live-btn-secondary" id="popup-close" style="padding: 8px 16px; font-size: 13px;">✕</button>
    </div>
  `;

  // Position near click
  const selection = window.getSelection();
  if (selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 10}px`;
  } else {
    popup.style.left = "50%";
    popup.style.top = "50%";
    popup.style.transform = "translate(-50%, -50%)";
  }

  document.body.appendChild(popup);

  // Bind popup actions
  document.getElementById("popup-add-vocab")?.addEventListener("click", () => {
    addToVocabulary(word);
    popup.remove();
  });
  
  document.getElementById("popup-pronounce")?.addEventListener("click", () => {
    pronounceWord(word);
  });
  
  document.getElementById("popup-close")?.addEventListener("click", () => {
    popup.remove();
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener("click", function close(e) {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener("click", close);
      }
    });
  }, 100);
}

/**
 * Add word to vocabulary via backend API
 */
async function addToVocabulary(word) {
  try {
    await addWord({ word });
    console.log("[Live] Added to vocabulary:", word);
    showToast(`已收藏: ${word}`, "success");
    // F1: 增加熟悉度
    import('./learning.js').then(mod => {
      mod.incrementAndCache(word);
    }).catch(() => {});
  } catch (err) {
    console.error("[Live] Failed to add vocabulary:", err);
    showToast(`收藏失败: ${err.message}`, "error");
  }
}

/**
 * Pronounce word
 */
function pronounceWord(word) {
  if ("speechSynthesis" in window) {
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = document.getElementById("live-lang")?.value === "zh" ? "zh-CN" : "en-US";
    window.speechSynthesis.speak(utterance);
  } else {
    showToast("浏览器不支持语音合成", "warning");
  }
}

/**
 * Clear all transcript
 */
function clearTranscript() {
  const container = document.getElementById("transcript");
  if (container) {
    container.innerHTML = `
      <div class="live-empty-state">
        <div class="live-empty-state-icon">🎙️</div>
        <div class="live-empty-state-text">点击「开始」启动实时转录</div>
      </div>
    `;
  }
  allSegments = [];
  showToast("转录内容已清空", "info");
}

/**
 * Copy all text to clipboard
 */
function copyAllText() {
  const text = allSegments.map(s => s.text).join("\n");
  if (!text) {
    showToast("没有可复制的内容", "warning");
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    showToast("已复制到剪贴板", "success");
  }).catch(() => {
    showToast("复制失败", "error");
  });
}

// Delegate export functions to the exporter module
function exportTranscript(format) {
  exporterExport(format, allSegments, showToast);
}

/**
 * Update UI status
 */
function updateStatus(state, text) {
  const dot = document.getElementById("status-dot");
  const label = document.getElementById("status-text");
  
  if (dot) {
    dot.className = "live-status-dot live-status-" + state;
  }
  if (label) {
    label.textContent = text;
  }
}

/**
 * Update buttons state
 */
function updateButtons(states) {
  const btnStart = document.getElementById("btn-start");
  const btnPause = document.getElementById("btn-pause");
  const btnStop = document.getElementById("btn-stop");

  if (btnStart) btnStart.disabled = !states.start;
  if (btnPause) btnPause.disabled = !states.pause;
  if (btnStop) btnStop.disabled = !states.stop;
}

/**
 * Update timer display
 */
function updateTimer() {
  const el = document.getElementById("timer");
  if (el) el.textContent = formatTime(elapsedSeconds);
}

/**
 * Update font size
 */
function updateFontSize() {
  document.querySelectorAll(".live-segment-text").forEach(el => {
    el.style.fontSize = currentFontSize + "px";
  });
}

/**
 * Start audio visualization
 */
function startAudioViz() {
  audioLevelInterval = setInterval(() => {
    // Simulated visualization - real data comes from WebSocket
    const level = Math.random() * 0.5 + 0.2;
    updateAudioLevel(level);
  }, 100);
}

/**
 * Stop audio visualization
 */
function stopAudioViz() {
  if (audioLevelInterval) {
    clearInterval(audioLevelInterval);
    audioLevelInterval = null;
  }
  // Reset bars
  document.querySelectorAll(".live-audio-bar").forEach(bar => {
    bar.style.height = "4px";
  });
}

/**
 * Toggle light/dark theme
 */
function toggleTheme() {
  const container = document.getElementById("live-container");
  const btn = document.getElementById("btn-theme");
  
  isLightTheme = !isLightTheme;
  
  if (container) {
    if (isLightTheme) {
      container.classList.add("light-theme");
      if (btn) btn.textContent = "☀️";
    } else {
      container.classList.remove("light-theme");
      if (btn) btn.textContent = "🌙";
    }
  }
}

/**
 * Show help dialog with custom modal
 */
function showHelp() {
  // Remove existing help modal
  document.querySelectorAll(".live-help-modal").forEach(m => m.remove());

  const modal = document.createElement("div");
  modal.className = "live-help-modal";
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.6); z-index: 10000;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
  `;

  modal.innerHTML = `
    <div style="
      background: #1e1e3a; border: 1px solid rgba(255,255,255,0.1);
      border-radius: 12px; padding: 28px 32px; max-width: 420px; width: 90%;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    ">
      <h3 style="margin: 0 0 16px 0; color: #fff; font-size: 18px; display: flex; align-items: center; gap: 8px;">
        ⌨️ 快捷键说明
      </h3>
      <div style="display: flex; flex-direction: column; gap: 10px; color: rgba(255,255,255,0.85); font-size: 14px; line-height: 1.6;">
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 6px;">
          <span>Space</span>
          <span style="color: rgba(255,255,255,0.5);">暂停/继续转录</span>
        </div>
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 6px;">
          <span>ESC</span>
          <span style="color: rgba(255,255,255,0.5);">停止转录</span>
        </div>
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 6px;">
          <span>Ctrl + S</span>
          <span style="color: rgba(255,255,255,0.5);">导出为 TXT</span>
        </div>
        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 6px;">
          <span>Ctrl + L</span>
          <span style="color: rgba(255,255,255,0.5);">清空转录内容</span>
        </div>
        <p style="margin: 8px 0 0 0; color: rgba(255,255,255,0.45); font-size: 12px;">
          点击转录中的单词可以查看详情并收藏到生词本。
        </p>
      </div>
      <button id="btn-help-close" style="
        margin-top: 20px; width: 100%; padding: 10px; border: none;
        border-radius: 8px; background: rgba(255,255,255,0.08);
        color: #fff; font-size: 14px; cursor: pointer;
      ">关闭</button>
    </div>
  `;

  document.body.appendChild(modal);

  // Close on overlay click
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Close button
  document.getElementById("btn-help-close")?.addEventListener("click", () => {
    modal.remove();
  });
}

/**
 * Handle keyboard shortcuts
 */
function handleKeyboard(e) {
  // Space to pause/resume when transcribing
  if (e.code === "Space" && isTranscribing && !e.target.matches("input, select, textarea")) {
    e.preventDefault();
    togglePause();
  }
  
  // ESC to stop
  if (e.code === "Escape" && isTranscribing) {
    stopTranscription();
  }
  
  // Ctrl+S to save
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    exportTranscript("txt");
  }
  
  // Ctrl+L to clear
  if (e.ctrlKey && e.key === "l") {
    e.preventDefault();
    clearTranscript();
  }
}

/**
 * Format seconds to MM:SS
 */
function formatTime(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * Escape HTML
 */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Show toast notification
 */
function showToast(message, type = "info") {
  // Remove existing toast
  document.querySelectorAll(".live-toast").forEach(t => t.remove());
  
  const toast = document.createElement("div");
  toast.className = `live-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  // Auto remove after 3 seconds
  setTimeout(() => {
    toast.style.animation = "live-toast-in 0.3s ease reverse";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
