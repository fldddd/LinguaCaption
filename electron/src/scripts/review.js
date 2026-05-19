/**
 * Review Module — 生词复习页
 *
 * Route: #/review
 * Displays bookmarked vocabulary with search, sort, and delete.
 * Uses the enhanced F6 storage module for cache-first + sync support.
 *
 * F5 ↔ F6 Interface:
 *   - getWords()         — 同步读取 (localStorage 镜像)
 *   - asyncGetWords()    — 异步读取 (IndexedDB, 优先缓存)
 *   - getFavorites()     — 缓存优先 + 后端回退 (F6.2)
 *   - saveFavorite()     — 本地 + 后端同步保存
 *   - deleteFavorite()   — 本地 + 后端同步删除
 */
import { getWords, removeWord, getItem, setItem } from './storage.js';
import { getFavorites, saveFavorite, deleteFavorite, asyncWordCount, isOnline, fullSync } from './storage.js';
import { searchWords } from './api.js';

/**
 * Initialize the review page.
 */
export function initReview() {
  renderWordList();
  bindReviewEvents();
  updateReviewStatus();
}

/**
 * Render the vocabulary word list.
 * Uses async getFavorites() for cache-first + backend sync,
 * falls back to synchronous getWords() if async fails.
 * @param {string} [searchQuery] - Optional search query for filtering
 */
async function renderWordList(searchQuery) {
  const list = document.getElementById('review-list');
  if (!list) return;

  let words = [];
  if (searchQuery && searchQuery.trim()) {
    // Backend fuzzy search
    try {
      const result = await searchWords(searchQuery.trim());
      words = result.items || [];
    } catch {
      // Fallback: client-side filter on cached data
      try {
        words = await getFavorites({ forceRefresh: false });
      } catch {
        words = getWords();
      }
      const q = searchQuery.toLowerCase().trim();
      words = words.filter((w) => w.word.toLowerCase().includes(q));
    }
  } else {
    // Try async cache-first loading
    try {
      words = await getFavorites({ forceRefresh: false });
    } catch {
      words = getWords();
    }
  }

  if (!words || words.length === 0) {
    list.innerHTML = '<p class="review-empty">还没有收藏单词，在看视频时点击单词即可添加</p>';
    return;
  }

  list.innerHTML = '';
  words.forEach((w) => {
    const item = document.createElement('div');
    item.className = 'vocab-item';
    item.dataset.word = w.word;
    item.innerHTML = `
      <span class="vocab-item-word">${escapeHtml(w.word)}</span>
      <span class="vocab-item-def">${escapeHtml(w.definition || w.context || '')}</span>
      <div class="vocab-item-actions">
        <button class="icon-btn" data-action="delete" title="删除">🗑</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function bindReviewEvents() {
  const list = document.getElementById('review-list');
  if (list) {
    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action="delete"]');
      if (btn) {
        const item = btn.closest('.vocab-item');
        const word = item?.dataset?.word;
        if (!word) return;

        // Async delete via F6.2 sync service
        try {
          const result = await deleteFavorite(word);
          if (result.success) {
            item.remove();
            updateReviewStatus();
          }
        } catch {
          // Fallback: synchronous delete
          removeWord(word);
          item.remove();
          updateReviewStatus();
        }
      }
    });
  }

  const searchEl = document.getElementById('review-search');
  if (searchEl) {
    let searchTimer = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const query = searchEl.value;
      searchTimer = setTimeout(() => {
        renderWordList(query);
      }, 300);
    });
  }

  const sortEl = document.getElementById('review-sort');
  if (sortEl) {
    sortEl.addEventListener('change', () => {
      sortWords(sortEl.value);
    });
  }

  // Sync button (visible when offline items pending)
  const syncBtn = document.createElement('button');
  syncBtn.className = 'player-btn secondary sync-btn';
  syncBtn.textContent = '🔄 同步';
  syncBtn.style.display = 'none';
  syncBtn.onclick = async () => {
    syncBtn.textContent = '⏳ 同步中...';
    syncBtn.disabled = true;
    try {
      const result = await fullSync();
      syncBtn.textContent = `✅ 已同步 (拉取 ${result.pulled}, 推送 ${result.synced})`;
      setTimeout(() => { syncBtn.style.display = 'none'; }, 3000);
      renderWordList();
      updateReviewStatus();
    } catch (err) {
      syncBtn.textContent = '❌ 同步失败';
      syncBtn.disabled = false;
    }
  };

  // Insert sync button into toolbar
  const toolbar = document.querySelector('.review-toolbar');
  if (toolbar && !document.querySelector('.sync-btn')) {
    toolbar.appendChild(syncBtn);
  }
}

function filterWords(query) {
  const items = document.querySelectorAll('.vocab-item');
  const q = query.toLowerCase().trim();
  items.forEach((item) => {
    const word = item.querySelector('.vocab-item-word')?.textContent?.toLowerCase() || '';
    item.style.display = !q || word.includes(q) ? '' : 'none';
  });
}

function sortWords(mode) {
  const list = document.getElementById('review-list');
  if (!list) return;
  const items = Array.from(list.querySelectorAll('.vocab-item'));
  items.sort((a, b) => {
    const wa = a.querySelector('.vocab-item-word')?.textContent || '';
    const wb = b.querySelector('.vocab-item-word')?.textContent || '';
    return mode === 'alpha' ? wa.localeCompare(wb) : 0;
  });
  items.forEach((el) => list.appendChild(el));
}

async function updateReviewStatus() {
  let count = 0;
  try {
    count = await asyncWordCount();
  } catch {
    count = getWords().length;
  }
  const statusEl = document.getElementById('status-text');
  if (statusEl) statusEl.textContent = `📖 ${count} 个生词`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;');
}
