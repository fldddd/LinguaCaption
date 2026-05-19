/**
 * LinguaCaption — Main Application Entry
 *
 * Registers SPA routes and initializes the app.
 * Routes: #/player (统一媒体播放器), #/review (复习), #/live (实时转录)
 * Alias: #/watch, #/point → #/player (向后兼容)
 *
 * Architecture:
 * - Route handlers use store.forget/recall to persist UI state across switches
 * - Player/review state is stored in global store (survives route changes)
 */
import { registerRoute, startRouter, onBeforeRouteChange, ROUTES } from './router.js';
import * as api from './api.js';
import * as storage from './storage.js';
import { showToast, escapeHtml } from './utils.js';
import { isBackendAlive } from './http.js';
import { forget as saveState, recall as restoreState, clear as clearRouteState } from './store.js';
import log from './logger.js';

// ── Route State Keys ──────────────────────────────────────

const ROUTE_SELECTORS = {
  [ROUTES.PLAYER]: {
    'urlInput': '#player-url-input',
    'statusText': '#transcribe-status',
  },
  [ROUTES.REVIEW]: {
    'search': '#review-search',
    'sort': '#review-sort',
  },
  [ROUTES.LIVE]: {
    'statusText': '#live-status',
  },
};

// Strip leading / for store keys
function routeKey(path) {
  return path.replace(/^\//, '') || 'player';
}

// ── Routes ──────────────────────────────────────────────

/** #/player — 统一媒体播放器（视频/音频自动识别） */
registerRoute(ROUTES.PLAYER, (container) => {
  container.innerHTML = `
    <div class="watch-layout">
      <div class="watch-controls">
        <button class="player-btn" id="btn-open-file">📂 选择文件</button>
        <input type="text" class="url-input" id="player-url-input" placeholder="或输入视频/音频URL..." />
        <button class="player-btn" id="btn-transcribe">✍️ 转录字幕</button>
        <button class="player-btn secondary" id="btn-open-subtitle">📄 选择字幕</button>
        <span id="file-name" class="watch-file-label">未选择文件</span>
        <div class="transcribe-status" id="transcribe-status"></div>
      </div>

      <div class="watch-body watch-body-player" id="watch-body">
        <div class="video-container" id="media-container">
          <p class="placeholder-text">点击「选择文件」选择视频或音频文件</p>
          <button class="pip-btn hidden" id="pip-btn" title="画中画模式">[PiP]</button>
        </div>
        <div class="subtitle-panel" id="subtitle-panel">
          <div class="subtitle-area" id="subtitle-area">
            <p class="placeholder-text">选择媒体文件后点击「转录字幕」生成字幕</p>
          </div>
        </div>
      </div>
    </div>
  `;

  // 恢复播放器页面 UI 状态
  restoreState('player', ROUTE_SELECTORS[ROUTES.PLAYER]);

  import('./player.js').then((mod) => {
    mod.initPlayer();
    mod.restorePlayerState?.('player');
  }).catch((err) => {
    log.warn('Player module deferred:', err);
    showToast('⚠️ 播放器模块加载失败', 'error');
  });
});

// #/watch 和 #/point 作为别名，路由层自动映射到 /player
// 见 router.js handleRoute() 中的 ALIASES 解析

/** #/review — 生词复习页 */
registerRoute(ROUTES.REVIEW, (container) => {
  container.innerHTML = `
    <div class="review-page">
      <div class="review-header">
        <h2>📖 生词复习</h2>
        <div class="review-toolbar">
          <input type="text" class="review-search" id="review-search" placeholder="搜索单词..." />
          <select class="review-sort" id="review-sort">
            <option value="time">按收藏时间</option>
            <option value="alpha">按字母顺序</option>
          </select>
        </div>
      </div>
      <div class="review-list" id="review-list">
        <p class="review-empty">还没有收藏单词</p>
      </div>
    </div>
  `;

  // 恢复 review 页面 UI 状态
  restoreState('review', ROUTE_SELECTORS[ROUTES.REVIEW]);

  import('./review.js').then((mod) => {
    mod.initReview();
  }).catch((err) => {
    log.warn('Review module deferred:', err);
    showToast('⚠️ 复习模块加载失败', 'error');
  });
});

/** #/live — 实时转录页 */
registerRoute(ROUTES.LIVE, (container) => {
  // 动态加载实时转录模块（由 live.js 自行渲染）
  import('./live.js').then((mod) => {
    mod.initLive(container);
  }).catch((err) => {
    log.warn('Live transcription module deferred:', err);
    showToast('⚠️ 实时转录模块加载失败', 'error');
  });
});

// ── Initialization ─────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

/** Main entry point - orchestrates all initialization */
function init() {
  try {
    // 注册路由切换前的钩子：保存当前路由的播放器状态
    onBeforeRouteChange((nextPath) => {
      const currentHash = window.location.hash.slice(1) || ROUTES.WATCH;
      const currentKey = routeKey(currentHash);
      const nextKey = routeKey(nextPath);
      // 只在路由实际变化时保存状态
      if (currentKey !== nextKey) {
        // 保存当前路由的 DOM 状态
        const currentSelectors = ROUTE_SELECTORS[currentHash];
        if (currentSelectors) saveState(currentKey, currentSelectors);
        // 保存当前路由的播放器状态
        import('./player.js').then((mod) => {
          if (typeof mod.savePlayerStateForRoute === 'function') {
            mod.savePlayerStateForRoute(currentKey);
          }
        }).catch((err) => {
          log.warn('[App] Failed to save player state before route change:', err);
        });
      }
    });

    initRouter();
    initEventListeners();
    initBackendCheck();
    // F1: 初始化学习数据（加载低熟悉度单词）
    import('./learning.js').then((mod) => {
      mod.initLearning();
    }).catch((err) => {
      log.warn('[App] Learning module init failed:', err);
    });
    updateStatus('就绪');
  } catch (err) {
    log.error('Initialization failed:', err);
    showToast('⚠️ 应用初始化失败，请刷新重试', 'error');
  }
}

/** Initialize hash router with page transitions */
function initRouter() {
  startRouter();
  renderCurrentRoute();
}

/** Bind DOM event listeners */
function initEventListeners() {
  const btnSettings = document.getElementById('btn-settings');
  if (btnSettings) {
    btnSettings.addEventListener('click', openSettingsModal);
  }

  const btnOverlayToggle = document.getElementById('btn-overlay-toggle');
  if (btnOverlayToggle) {
    btnOverlayToggle.addEventListener('click', () => {
      if (window.electronAPI?.overlayToggle) {
        window.electronAPI.overlayToggle();
      }
    });
  }
}

/** Check backend health status silently — updates indicator dot */
let _consecutiveFailures = 0;
const FAILURE_THRESHOLD = 3;  // 连续 3 次失败才标记为断开
const HEALTH_CHECK_INTERVAL = 60000;  // 每分钟检查一次

/**
 * Update the backend status indicator dot in the header
 * @param {'checking'|'connected'|'disconnected'} state
 * @param {object} [detail]
 */
function updateBackendIndicator(state, detail = {}) {
  const dot = document.getElementById('backend-status-dot');
  if (!dot) return;

  // Remove all state classes
  dot.classList.remove('connected', 'disconnected', 'checking');

  switch (state) {
    case 'connected':
      dot.classList.add('connected');
      dot.title = detail.uptime
        ? `✅ 后端已连接 (运行 ${Math.round(detail.uptime / 60)} 分钟)`
        : '✅ 后端已连接';
      break;
    case 'disconnected':
      dot.classList.add('disconnected');
      dot.title = '❌ 后端未连接';
      break;
    default:
      dot.classList.add('checking');
      dot.title = '⏳ 后端状态检查中…';
      break;
  }
}

async function initBackendCheck() {
  // Set initial state to checking
  updateBackendIndicator('checking');

  const check = async () => {
    try {
      const status = await isBackendAlive();
      if (status.alive) {
        // Reset failure counter on success
        _consecutiveFailures = 0;
        updateBackendIndicator('connected', status);
      } else {
        _consecutiveFailures++;
        if (_consecutiveFailures >= FAILURE_THRESHOLD) {
          updateBackendIndicator('disconnected');
        }
        // Never show toast — silently handle
        log.debug(`[Health Check] Backend not alive (failure ${_consecutiveFailures}/${FAILURE_THRESHOLD})`);
      }
    } catch (err) {
      _consecutiveFailures++;
      if (_consecutiveFailures >= FAILURE_THRESHOLD) {
        updateBackendIndicator('disconnected');
      }
      log.warn('[Health Check] Backend health check failed:', err);
      // No toast — errors are internal only
    }
  };

  // Run first check immediately
  await check();
  // Then every HEALTH_CHECK_INTERVAL ms
  setInterval(check, HEALTH_CHECK_INTERVAL);
}

/** Render based on current hash with smooth transition */
function renderCurrentRoute() {
  const container = document.getElementById('app-container');
  if (!container) return;

  container.classList.add('page-transition-out');

  setTimeout(() => {
    container.classList.remove('page-transition-out');
    container.classList.add('page-transition-in');

    requestAnimationFrame(() => {
      setTimeout(() => {
        container.classList.remove('page-transition-in');
      }, 300);
    });
  }, 150);
}

// ── Settings Modal ─────────────────────────────────────

/** Open settings modal dialog */
function openSettingsModal() {
  import('./settings.js').then((settings) => {
    const cur = settings.getSettings();
    const existing = document.getElementById('settings-modal');
    if (existing) existing.remove();

    const modal = createSettingsModal(cur);
    document.body.appendChild(modal);
    bindSettingsEvents(modal, settings);
  }).catch((err) => {
    log.error('Failed to load settings:', err);
    showToast('⚠️ 设置模块加载失败', 'error');
  });
}

/** Create settings modal DOM element */
function createSettingsModal(settings) {
  const modal = document.createElement('div');
  modal.id = 'settings-modal';
  modal.className = 'settings-overlay';
  
  const downloadMode = settings.downloadMode || 'download';
  const rt = settings.realtimeSubtitle || {};
  const rtEnabled = rt.enabled || false;
  const rtLanguage = rt.language || 'zh-CN';
  const rtAutoTranslate = rt.autoTranslate || false;
  const rtTargetLang = rt.targetLanguage || 'en';
  const rtShowBilingual = rt.showBilingual || false;
  
  modal.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>⚙ 设置</h2>
        <button class="settings-close" id="settings-close">✕</button>
      </div>
      <div class="settings-body">
        <!-- 下载模式设置 -->
        <div class="settings-group">
          <label class="settings-label">📥 下载模式</label>
          <p class="settings-hint">选择视频播放方式。下载模式将视频保存到本地再播放，适合网络不稳定时；流式模式直接在线播放，无需等待下载。</p>
          <div class="settings-radio-group">
            <label class="settings-radio">
              <input type="radio" name="download-mode" value="download" ${downloadMode === 'download' ? 'checked' : ''} />
              <span>📥 下载到本地</span>
            </label>
            <label class="settings-radio">
              <input type="radio" name="download-mode" value="stream" ${downloadMode === 'stream' ? 'checked' : ''} />
              <span>🌐 在线流式播放</span>
            </label>
          </div>
        </div>
        
        <!-- 视频下载目录 -->
        <div class="settings-group">
          <label class="settings-label">📁 视频下载目录</label>
          <p class="settings-hint">B站视频下载到本地的保存位置。留空则使用系统临时目录。</p>
          <div class="settings-dir-row">
            <input type="text" class="settings-dir-input" id="settings-download-dir"
                   value="${escapeHtml(settings.downloadDir || '')}" placeholder="留空=系统临时目录" />
            <button class="player-btn secondary" id="settings-browse-dir">📂 浏览</button>
          </div>
        </div>
        
        <!-- 实时字幕设置 -->
        <div class="settings-group">
          <label class="settings-label">🎤 实时字幕</label>
          <div class="settings-toggle-row">
            <label class="settings-toggle">
              <input type="checkbox" id="rt-enabled" ${rtEnabled ? 'checked' : ''} />
              <span class="toggle-slider"></span>
              <span class="toggle-label">开启实时字幕</span>
            </label>
          </div>
          <div id="rt-options" class="rt-options ${rtEnabled ? '' : 'hidden'}">
            <div class="settings-select-row">
              <label>识别语言：</label>
              <select id="rt-language">
                <option value="zh-CN" ${rtLanguage === 'zh-CN' ? 'selected' : ''}>中文</option>
                <option value="en" ${rtLanguage === 'en' ? 'selected' : ''}>English</option>
                <option value="ja" ${rtLanguage === 'ja' ? 'selected' : ''}>日本語</option>
                <option value="ko" ${rtLanguage === 'ko' ? 'selected' : ''}>한국어</option>
              </select>
            </div>
            <div class="settings-toggle-row">
              <label class="settings-toggle">
                <input type="checkbox" id="rt-auto-translate" ${rtAutoTranslate ? 'checked' : ''} />
                <span class="toggle-slider"></span>
                <span class="toggle-label">自动翻译</span>
              </label>
            </div>
            <div id="rt-target-lang-row" class="settings-select-row ${rtAutoTranslate ? '' : 'hidden'}">
              <label>目标语言：</label>
              <select id="rt-target-language">
                <option value="zh-CN" ${rtTargetLang === 'zh-CN' ? 'selected' : ''}>中文</option>
                <option value="en" ${rtTargetLang === 'en' ? 'selected' : ''}>English</option>
                <option value="ja" ${rtTargetLang === 'ja' ? 'selected' : ''}>日本語</option>
                <option value="ko" ${rtTargetLang === 'ko' ? 'selected' : ''}>한국어</option>
              </select>
            </div>
            <div class="settings-toggle-row">
              <label class="settings-toggle">
                <input type="checkbox" id="rt-bilingual" ${rtShowBilingual ? 'checked' : ''} />
                <span class="toggle-slider"></span>
                <span class="toggle-label">显示双语字幕</span>
              </label>
            </div>
          </div>
        </div>
      </div>
      <div class="settings-footer">
        <button class="player-btn" id="settings-save">保存</button>
      </div>
    </div>
  `;
  return modal;
}

/** Bind settings modal events */
function bindSettingsEvents(modal, settings) {
  // 浏览按钮
  document.getElementById('settings-browse-dir').onclick = async () => {
    try {
      const dir = await settings.pickDirectory();
      if (dir) {
        document.getElementById('settings-download-dir').value = dir;
      }
    } catch (err) {
      log.error('Directory pick failed:', err);
      showToast(`⚠️ ${err.message || '目录选择失败'}`, 'error');
    }
  };
  
  // 实时字幕开关切换
  const rtEnabledToggle = document.getElementById('rt-enabled');
  const rtOptions = document.getElementById('rt-options');
  if (rtEnabledToggle && rtOptions) {
    rtEnabledToggle.addEventListener('change', (e) => {
      rtOptions.classList.toggle('hidden', !e.target.checked);
    });
  }
  
  // 自动翻译开关切换
  const rtAutoTranslateToggle = document.getElementById('rt-auto-translate');
  const rtTargetLangRow = document.getElementById('rt-target-lang-row');
  if (rtAutoTranslateToggle && rtTargetLangRow) {
    rtAutoTranslateToggle.addEventListener('change', (e) => {
      rtTargetLangRow.classList.toggle('hidden', !e.target.checked);
    });
  }

  // 保存按钮
  document.getElementById('settings-save').onclick = () => {
    try {
      const downloadDir = document.getElementById('settings-download-dir').value.trim();
      
      // 获取下载模式
      const downloadModeRadio = document.querySelector('input[name="download-mode"]:checked');
      const downloadMode = downloadModeRadio ? downloadModeRadio.value : 'download';
      
      // 获取实时字幕设置
      const rtEnabled = document.getElementById('rt-enabled')?.checked || false;
      const rtLanguage = document.getElementById('rt-language')?.value || 'zh-CN';
      const rtAutoTranslate = document.getElementById('rt-auto-translate')?.checked || false;
      const rtTargetLanguage = document.getElementById('rt-target-language')?.value || 'en';
      const rtShowBilingual = document.getElementById('rt-bilingual')?.checked || false;
      
      settings.saveSettings({
        downloadDir,
        downloadMode,
        realtimeSubtitle: {
          enabled: rtEnabled,
          language: rtLanguage,
          autoTranslate: rtAutoTranslate,
          targetLanguage: rtTargetLanguage,
          showBilingual: rtShowBilingual,
        },
      });
      modal.remove();
      showToast('✅ 设置已保存', 'success');
    } catch (err) {
      log.error('Settings save failed:', err);
      showToast('⚠️ 设置保存失败', 'error');
    }
  };

  // 关闭按钮
  document.getElementById('settings-close').onclick = () => modal.remove();
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ── Utilities ──────────────────────────────────────────

/** Update status bar text */
export function updateStatus(text) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = text;
}

export { api, storage };


