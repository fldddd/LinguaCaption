/**
 * LinguaCaption — Main Application Entry
 *
 * Registers SPA routes and initializes the app.
 * Routes: #/watch (点读), #/point (纯点读), #/review (复习)
 */
import { registerRoute, startRouter, ROUTES } from './router.js';
import * as api from './api.js';
import * as storage from './storage.js';

// ── Routes ──────────────────────────────────────────────

/** #/watch — 点读播放器（视频 + 字幕同步） */
registerRoute(ROUTES.WATCH, (container) => {
  container.innerHTML = `
    <div class="watch-layout">
      <div class="watch-controls">
        <button class="player-btn" id="btn-open-file">📂 打开视频</button>
        <button class="player-btn secondary" id="btn-open-subtitle">📄 选择字幕</button>
        <span id="file-name" class="watch-file-label">未选择文件</span>
      </div>
      <div class="watch-body">
        <div class="video-container" id="video-container">
          <p class="placeholder-text">点击「打开视频」选择媒体文件</p>
        </div>
        <div class="subtitle-panel" id="subtitle-panel">
          <div class="subtitle-area" id="subtitle-area">
            <p class="placeholder-text">加载字幕后将在此显示</p>
          </div>
        </div>
      </div>
    </div>
  `;

  import('./player.js').then((mod) => {
    mod.initPlayer();
  }).catch((err) => {
    console.warn('Player module deferred:', err);
  });
});

/** #/point — 纯点读模式（无视频，仅字幕+音频） */
registerRoute(ROUTES.POINT, (container) => {
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

  import('./player.js').then((mod) => {
    mod.initPointMode();
  }).catch((err) => {
    console.warn('Point mode deferred:', err);
  });
});

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

  import('./review.js').then((mod) => {
    mod.initReview();
  }).catch((err) => {
    console.warn('Review module deferred:', err);
  });
});

// ── Init ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  startRouter();
  updateStatus('就绪');
});

export function updateStatus(text) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = text;
}

export { api, storage };
