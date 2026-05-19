/**
 * Word Frequency Panel — 词频统计面板
 *
 * Features:
 * - 实时字幕词频统计（累计 + 会话）
 * - 词频排行榜展示
 * - 单词来源追踪
 * - 与后端 word_frequency API 通信
 *
 * Usage:
 *   import { initWordFreqPanel, recordSubtitleWords } from './wordFreqPanel.js';
 *   initWordFreqPanel();  // 绑定面板开关
 *   recordSubtitleWords(text, sourceId, start, end);  // 记录字幕单词
 */

import { BASE_URL } from './api.js';

/* ── State ────────────────────────────────────────────── */

let panelVisible = false;
let panelEl = null;
let refreshTimer = null;

/* ── Init ─────────────────────────────────────────────── */

export function initWordFreqPanel() {
  // Bind toggle button
  const toggleBtn = document.getElementById('btn-word-freq');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', togglePanel);
  }

  // Listen for route changes to auto-close panel
  window.addEventListener('hashchange', () => {
    if (panelVisible) hidePanel();
  });
}

/* ── Panel Toggle ─────────────────────────────────────── */

function togglePanel() {
  if (panelVisible) {
    hidePanel();
  } else {
    showPanel();
  }
}

function showPanel() {
  if (panelEl) {
    panelEl.style.display = 'flex';
    panelVisible = true;
    refreshPanel();
    startAutoRefresh();
    return;
  }

  panelEl = document.createElement('div');
  panelEl.id = 'word-freq-panel';
  panelEl.className = 'word-freq-panel';
  panelEl.innerHTML = `
    <div class="word-freq-header">
      <h3>📊 词频统计</h3>
      <div class="word-freq-controls">
        <button class="word-freq-tab active" data-tab="top">排行榜</button>
        <button class="word-freq-tab" data-tab="search">查单词</button>
        <button class="word-freq-tab" data-tab="sources">来源追踪</button>
        <button class="word-freq-close" id="word-freq-close">✕</button>
      </div>
    </div>
    <div class="word-freq-body">
      <div class="word-freq-content" id="word-freq-content">
        <p class="word-freq-loading">加载中...</p>
      </div>
    </div>
    <div class="word-freq-footer">
      <button class="player-btn secondary" id="word-freq-sort-cumulative">📊 累计</button>
      <button class="player-btn secondary" id="word-freq-sort-session">🔄 会话</button>
      <button class="player-btn secondary" id="word-freq-flush">💾 刷新</button>
      <button class="player-btn secondary" id="word-freq-reset">↺ 重置会话</button>
    </div>
  `;

  document.body.appendChild(panelEl);
  panelVisible = true;

  // Bind events
  document.getElementById('word-freq-close').onclick = hidePanel;

  // Tab switching
  panelEl.querySelectorAll('.word-freq-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      panelEl.querySelectorAll('.word-freq-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      refreshPanel();
    });
  });

  // Footer buttons
  document.getElementById('word-freq-sort-cumulative').onclick = () => {
    refreshPanel('cumulative');
  };
  document.getElementById('word-freq-sort-session').onclick = () => {
    refreshPanel('session');
  };
  document.getElementById('word-freq-flush').onclick = async () => {
    await fetchFromApi('POST', '/words/flush');
    showToast('✅ 词频已刷新到数据库', 'success');
  };
  document.getElementById('word-freq-reset').onclick = async () => {
    await fetchFromApi('POST', '/words/session/reset');
    refreshPanel();
    showToast('🔄 会话计数已重置', 'success');
  };

  refreshPanel();
  startAutoRefresh();
}

function hidePanel() {
  if (panelEl) {
    panelEl.style.display = 'none';
  }
  panelVisible = false;
  stopAutoRefresh();
}

/* ── Auto Refresh ─────────────────────────────────────── */

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (panelVisible) {
      const activeTab = panelEl?.querySelector('.word-freq-tab.active');
      if (activeTab && activeTab.dataset.tab === 'top') {
        refreshPanel();
      }
    }
  }, 5000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/* ── Refresh Panel Content ────────────────────────────── */

async function refreshPanel(sortBy) {
  const contentEl = document.getElementById('word-freq-content');
  if (!contentEl) return;

  const activeTab = panelEl?.querySelector('.word-freq-tab.active');
  const tab = activeTab ? activeTab.dataset.tab : 'top';

  try {
    switch (tab) {
      case 'top':
        await renderTopFrequencies(contentEl, sortBy || 'cumulative');
        break;
      case 'search':
        renderWordSearch(contentEl);
        break;
      case 'sources':
        renderSourceSearch(contentEl);
        break;
    }
  } catch (err) {
    console.warn('[WordFreqPanel] Refresh failed:', err);
    contentEl.innerHTML = `<p class="word-freq-error">加载失败: ${escapeHtml(err.message)}</p>`;
  }
}

/* ── Top Frequencies ──────────────────────────────────── */

async function renderTopFrequencies(container, sortBy) {
  const data = await fetchFromApi('GET', `/words/top?limit=100&sort_by=${sortBy}`);

  if (!Array.isArray(data) || data.length === 0) {
    container.innerHTML = '<p class="word-freq-empty">暂无词频数据<br><small>播放视频或音频时将自动记录</small></p>';
    return;
  }

  const label = sortBy === 'cumulative' ? '累计' : '会话';
  let html = `<div class="word-freq-list-header">
    <span>#</span><span>单词</span><span>${label}次数</span>
  </div>`;
  html += '<div class="word-freq-list">';

  data.forEach((item, idx) => {
    const count = sortBy === 'cumulative' ? item.cumulative_count : item.session_count;
    const freqClass = count > 20 ? 'freq-high' : count > 10 ? 'freq-mid' : 'freq-low';
    html += `<div class="word-freq-item" data-word="${escapeHtml(item.word)}">
      <span class="word-freq-rank">${idx + 1}</span>
      <span class="word-freq-word">${escapeHtml(item.word)}</span>
      <span class="word-freq-count ${freqClass}">${count}</span>
    </div>`;
  });

  html += '</div>';
  container.innerHTML = html;

  // Click to search occurrences
  container.querySelectorAll('.word-freq-item').forEach((el) => {
    el.addEventListener('click', () => {
      const word = el.dataset.word;
      showWordDetail(word);
    });
  });
}

/* ── Word Search ──────────────────────────────────────── */

function renderWordSearch(container) {
  container.innerHTML = `
    <div class="word-freq-search">
      <input type="text" class="url-input" id="word-freq-search-input"
             placeholder="输入单词查询词频..." autofocus />
      <button class="player-btn" id="word-freq-search-btn">🔍 查询</button>
    </div>
    <div class="word-freq-result" id="word-freq-result"></div>
  `;

  const input = document.getElementById('word-freq-search-input');
  const btn = document.getElementById('word-freq-search-btn');
  const resultEl = document.getElementById('word-freq-result');

  async function doSearch() {
    const word = input.value.trim();
    if (!word) return;

    resultEl.innerHTML = '<p class="word-freq-loading">查询中...</p>';

    try {
      const freq = await fetchFromApi('GET', `/words/frequency/${encodeURIComponent(word)}`);
      const occurrences = await fetchFromApi('GET', `/words/occurrences/${encodeURIComponent(word)}?limit=10`);

      let html = '<div class="word-freq-detail">';
      html += `<h4>${escapeHtml(freq.word || word)}</h4>`;
      html += `<p>📊 累计出现: <strong>${freq.cumulative_count || 0}</strong> 次</p>`;
      html += `<p>🔄 会话出现: <strong>${freq.session_count || 0}</strong> 次</p>`;
      html += '</div>';

      if (Array.isArray(occurrences) && occurrences.length > 0) {
        html += '<h5>📄 来源记录</h5>';
        html += '<div class="word-freq-occurrences">';
        for (const occ of occurrences) {
          html += `<div class="word-freq-occ-item">
            <span class="word-freq-occ-source">${escapeHtml(occ.source_id || '未知来源')}</span>
            <span class="word-freq-occ-text">"${escapeHtml((occ.subtitle_text || '').substring(0, 80))}"</span>
          </div>`;
        }
        html += '</div>';
      }

      resultEl.innerHTML = html;
    } catch (err) {
      resultEl.innerHTML = `<p class="word-freq-error">查询失败: ${escapeHtml(err.message)}</p>`;
    }
  }

  btn.onclick = doSearch;
  input.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
}

/* ── Source Search ────────────────────────────────────── */

function renderSourceSearch(container) {
  container.innerHTML = `
    <div class="word-freq-search">
      <input type="text" class="url-input" id="word-freq-source-input"
             placeholder="输入单词查看来源..." autofocus />
      <button class="player-btn" id="word-freq-source-btn">🔍 追踪</button>
    </div>
    <div class="word-freq-result" id="word-freq-source-result"></div>
  `;

  const input = document.getElementById('word-freq-source-input');
  const btn = document.getElementById('word-freq-source-btn');
  const resultEl = document.getElementById('word-freq-source-result');

  async function doSearch() {
    const word = input.value.trim();
    if (!word) return;

    resultEl.innerHTML = '<p class="word-freq-loading">查询中...</p>';

    try {
      const occurrences = await fetchFromApi('GET', `/words/occurrences/${encodeURIComponent(word)}?limit=50`);

      if (!Array.isArray(occurrences) || occurrences.length === 0) {
        resultEl.innerHTML = `<p class="word-freq-empty">未找到 "${escapeHtml(word)}" 的来源记录</p>`;
        return;
      }

      let html = `<h5>📄 找到 ${occurrences.length} 条来源记录</h5>`;
      html += '<div class="word-freq-occurrences">';
      for (const occ of occurrences) {
        html += `<div class="word-freq-occ-item">
          <div class="word-freq-occ-header">
            <span class="word-freq-occ-source">${escapeHtml(occ.source_type || 'transcription')}</span>
            <span class="word-freq-occ-id">${escapeHtml(occ.source_id || '')}</span>
            ${occ.start_time ? `<span class="word-freq-occ-time">⏱ ${formatTime(occ.start_time)}</span>` : ''}
          </div>
          <div class="word-freq-occ-text">"${escapeHtml((occ.subtitle_text || '').substring(0, 120))}"</div>
        </div>`;
      }
      html += '</div>';

      resultEl.innerHTML = html;
    } catch (err) {
      resultEl.innerHTML = `<p class="word-freq-error">查询失败: ${escapeHtml(err.message)}</p>`;
    }
  }

  btn.onclick = doSearch;
  input.onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
}

/* ── Word Detail Popup ────────────────────────────────── */

async function showWordDetail(word) {
  if (!word) return;

  try {
    const freq = await fetchFromApi('GET', `/words/frequency/${encodeURIComponent(word)}`);
    const occurrences = await fetchFromApi('GET', `/words/occurrences/${encodeURIComponent(word)}?limit=5`);

    const overlay = document.createElement('div');
    overlay.className = 'word-detail-overlay';
    overlay.innerHTML = `
      <div class="word-detail-card">
        <div class="word-detail-header">
          <h4>${escapeHtml(freq.word || word)}</h4>
          <button class="word-freq-close-btn" id="word-detail-close">✕</button>
        </div>
        <div class="word-detail-body">
          <p>📊 累计: <strong>${freq.cumulative_count || 0}</strong> 次</p>
          <p>🔄 会话: <strong>${freq.session_count || 0}</strong> 次</p>
          ${Array.isArray(occurrences) && occurrences.length > 0 ? `
            <h5>来源:</h5>
            <ul>
              ${occurrences.map(occ => `<li>"${escapeHtml((occ.subtitle_text || '').substring(0, 60))}"</li>`).join('')}
            </ul>
          ` : '<p>暂无来源记录</p>'}
        </div>
        <div class="word-detail-actions">
          <button class="player-btn secondary" id="word-detail-sources-btn">📄 查看全部来源</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    overlay.querySelector('#word-detail-close').onclick = () => overlay.remove();
    overlay.querySelector('#word-detail-sources-btn').onclick = () => {
      overlay.remove();
      // Switch to sources tab
      const tab = panelEl?.querySelector('.word-freq-tab[data-tab="sources"]');
      if (tab) {
        panelEl.querySelectorAll('.word-freq-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        refreshPanel();
        // Fill search input
        const input = document.getElementById('word-freq-source-input');
        if (input) {
          input.value = word;
          input.dispatchEvent(new Event('input'));
          // Trigger search
          setTimeout(() => {
            const btn = document.getElementById('word-freq-source-btn');
            if (btn) btn.click();
          }, 100);
        }
      }
    };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  } catch (err) {
    console.warn('[WordFreqPanel] Detail failed:', err);
  }
}

/* ── Record Subtitle Words ────────────────────────────── */

let _recordQueue = [];
let _recordTimer = null;

/**
 * 记录一段字幕文本中的单词（由 player.js 在实时字幕或转录完成时调用）
 * 使用防抖批量发送，减少 API 请求
 */
export function recordSubtitleWords(text, sourceId = '', subtitleText = '', startTime = 0, endTime = 0) {
  if (!text) return;

  _recordQueue.push({ text, sourceId, subtitleText, startTime, endTime });

  if (_recordTimer) clearTimeout(_recordTimer);
  _recordTimer = setTimeout(sendRecordBatch, 2000);
}

async function sendRecordBatch() {
  if (_recordQueue.length === 0) return;

  const batch = _recordQueue.splice(0);
  _recordQueue = [];

  for (const item of batch) {
    try {
      const sourceId = item.sourceId || 'realtime';
      const params = new URLSearchParams({
        text: item.text,
        source_type: 'transcription',
        source_id: sourceId,
        subtitle_text: item.subtitleText || item.text,
        start_time: String(item.startTime || 0),
        end_time: String(item.endTime || 0),
      });
      await fetchFromApi('POST', `/words/record?${params.toString()}`);
    } catch (err) {
      // Silently fail — word frequency is non-critical
      console.debug('[WordFreqPanel] Record failed:', err);
    }
  }
}

/* ── API Helper ───────────────────────────────────────── */

async function fetchFromApi(method, path) {
  const url = `${BASE_URL}/api${path}`;
  const res = await fetch(url, { method });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path}: ${res.status} ${text}`);
  }
  // 204 No Content
  if (res.status === 204) return null;
  return res.json();
}

/* ── Helpers ──────────────────────────────────────────── */

function escapeHtml(text) {
  if (typeof text !== 'string') return String(text || '');
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(s) {
  if (s === undefined || s === null) return '';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function showToast(msg, type) {
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

export default { initWordFreqPanel, recordSubtitleWords };
