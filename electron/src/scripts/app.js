/**
 * LinguaCaption — Main Application Entry
 *
 * Registers SPA routes and initializes the app.
 * Routes: #/watch (点读), #/point (纯点读), #/review (复习)
 *
 * Architecture:
 * - Route handlers use store.forget/recall to persist UI state across switches
 * - Player/review state is stored in global store (survives route changes)
 */
import { registerRoute, startRouter, ROUTES } from './router.js';
import * as api from './api.js';
import * as storage from './storage.js';
import { showToast, escapeHtml } from './utils.js';
import { isBackendAlive } from './http.js';
import { forget as saveState, recall as restoreState, clear as clearRouteState } from './store.js';

// ── Route State Keys ──────────────────────────────────────

const ROUTE_SELECTORS = {
  [ROUTES.WATCH]: {
    'urlInput': '#watch-url-input',
    'downloadToggle': '#toggle-download',
    'statusText': '#watch-transcribe-status',
  },
  [ROUTES.POINT]: {
    'urlInput': '#point-url-input',
    'statusText': '#transcribe-status',
  },
  [ROUTES.REVIEW]: {
    'search': '#review-search',
    'sort': '#review-sort',
  },
};

// Strip leading / for store keys
function routeKey(path) {
  return path.replace(/^\//, '') || 'watch';
}

// ── Routes ──────────────────────────────────────────────

/** #/watch — 点读播放器（视频 + 字幕同步） */
registerRoute(ROUTES.WATCH, (container) => {
  // 保存前一个页面的状态
  const prevPath = window.location.hash.slice(1) || ROUTES.WATCH;
  const prevKey = routeKey(prevPath);
  if (prevKey !== 'watch') {
    const prevSelectors = ROUTE_SELECTORS[prevPath];
    if (prevSelectors) saveState(prevKey, prevSelectors);
  }

  container.innerHTML = `
    <div class="watch-layout">
      <div class="watch-controls">
        <button class="player-btn" id="btn-open-file">📂 打开视频</button>
        <input type="text" class="url-input" id="watch-url-input" placeholder="或输入视频URL..." />
        <button class="player-btn" id="btn-watch-transcribe">✍️ 转录字幕</button>
        <button class="player-btn secondary" id="btn-open-subtitle">📄 选择字幕</button>
        <span id="file-name" class="watch-file-label">未选择文件</span>
        <div class="transcribe-status" id="watch-transcribe-status"></div>
      </div>
      <div class="watch-controls-row2">
        <label class="mode-toggle" title="下载模式将视频保存到本地再播放，流式模式直接在线播放">
          <input type="checkbox" id="toggle-download" checked />
          <span class="toggle-slider"></span>
          <span class="toggle-label">📥 下载到本地</span>
        </label>
      </div>
      <div class="watch-body">
        <div class="video-container" id="video-container">
          <p class="placeholder-text">点击「打开视频」选择媒体文件或输入URL</p>
        </div>
        <div class="subtitle-panel" id="subtitle-panel">
          <div class="subtitle-area" id="subtitle-area">
            <p class="placeholder-text">选择视频后点击「转录字幕」生成字幕</p>
          </div>
        </div>
      </div>
    </div>
  `;

  // 恢复 watch 页面状态
  restoreState('watch', ROUTE_SELECTORS[ROUTES.WATCH]);

  import('./player.js').then((mod) => {
    mod.initPlayer();
    mod.restorePlayerState?.();
  }).catch((err) => {
    console.warn('Player module deferred:', err);
    showToast('⚠️ 播放器模块加载失败', 'error');
  });
});

/** #/point — 纯点读模式（无视频，仅字幕+音频） */
registerRoute(ROUTES.POINT, (container) => {
  // 保存前一个页面的状态
  const prevPath = window.location.hash.slice(1) || ROUTES.WATCH;
  const prevKey = routeKey(prevPath);
  if (prevKey !== 'point') {
    const prevSelectors = ROUTE_SELECTORS[prevPath];
    if (prevSelectors) saveState(prevKey, prevSelectors);
  }

  container.innerHTML = `
    <div class="watch-layout">
      <div class="watch-controls">
        <button class="player-btn" id="btn-point-audio">🎵 选择音频文件</button>
        <input type="text" class="url-input" id="point-url-input" placeholder="或输入音频URL..." />
        <button class="player-btn" id="btn-point-transcribe">✍️ 转录字幕</button>
        <span id="point-file-name" class="watch-file-label">未选择文件</span>
        <div class="transcribe-status" id="transcribe-status"></div>
      </div>
      <div class="watch-body point-mode">
        <div class="audio-container" id="audio-container">
          <p class="placeholder-text">选择音频文件或输入URL开始点读</p>
        </div>
        <div class="subtitle-panel" id="subtitle-panel-point">
          <div class="subtitle-area" id="subtitle-area-point">
            <p class="placeholder-text">选择音频后点击「转录字幕」生成字幕</p>
          </div>
        </div>
      </div>
    </div>
  `;

  // 恢复 point 页面状态
  restoreState('point', ROUTE_SELECTORS[ROUTES.POINT]);

  import('./player.js').then((mod) => {
    mod.initPointMode();
    mod.restorePlayerState?.();
  }).catch((err) => {
    console.warn('Point mode deferred:', err);
    showToast('⚠️ 点读模式加载失败', 'error');
  });
});

/** #/review — 生词复习页 */
registerRoute(ROUTES.REVIEW, (container) => {
  // 保存前一个页面的状态
  const prevPath = window.location.hash.slice(1) || ROUTES.WATCH;
  const prevKey = routeKey(prevPath);
  if (prevKey !== 'review') {
    const prevSelectors = ROUTE_SELECTORS[prevPath];
    if (prevSelectors) saveState(prevKey, prevSelectors);
  }

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

  // 恢复 review 页面状态
  restoreState('review', ROUTE_SELECTORS[ROUTES.REVIEW]);

  import('./review.js').then((mod) => {
    mod.initReview();
  }).catch((err) => {
    console.warn('Review module deferred:', err);
    showToast('⚠️ 复习模块加载失败', 'error');
  });
});

// ── Initialization ─────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

/** Main entry point - orchestrates all initialization */
function init() {
  try {
    initRouter();
    initEventListeners();
    initBackendCheck();
    updateStatus('就绪');
  } catch (err) {
    console.error('Initialization failed:', err);
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
}

/** Check backend health status */
async function initBackendCheck() {
  try {
    const isAlive = await isBackendAlive();
    if (!isAlive) {
      showToast('⚠️ 后端服务未启动，部分功能可能不可用', 'warning');
    }
  } catch (err) {
    console.warn('Backend health check failed:', err);
    showToast('⚠️ 无法连接后端服务', 'warning');
  }
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
    console.error('Failed to load settings:', err);
    showToast('⚠️ 设置模块加载失败', 'error');
  });
}

/** Create settings modal DOM element */
function createSettingsModal(settings) {
  const modal = document.createElement('div');
  modal.id = 'settings-modal';
  modal.className = 'settings-overlay';
  modal.innerHTML = `
    <div class="settings-panel">
      <div class="settings-header">
        <h2>⚙ 设置</h2>
        <button class="settings-close" id="settings-close">✕</button>
      </div>
      <div class="settings-body">
        <div class="settings-group">
          <label class="settings-label">📥 视频下载目录</label>
          <p class="settings-hint">B站视频下载到本地的保存位置。留空则使用系统临时目录。</p>
          <div class="settings-dir-row">
            <input type="text" class="settings-dir-input" id="settings-download-dir"
                   value="${escapeHtml(settings.downloadDir || '')}" placeholder="留空=系统临时目录" />
            <button class="player-btn secondary" id="settings-browse-dir">📂 浏览</button>
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
      console.error('Directory pick failed:', err);
      showToast('⚠️ 目录选择失败', 'error');
    }
  };

  // 保存按钮
  document.getElementById('settings-save').onclick = () => {
    try {
      const input = document.getElementById('settings-download-dir');
      settings.saveSettings({ downloadDir: input.value.trim() });
      modal.remove();
      showToast('✅ 设置已保存', 'success');
    } catch (err) {
      console.error('Settings save failed:', err);
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
