/**
 * Review Module — 生词复习页
 *
 * Route: #/review
 * Displays bookmarked vocabulary with search, sort, and delete.
 * Full implementation in F5 phase.
 */
import { getWords, removeWord } from './storage.js';

export function initReview() {
  renderWordList();
  bindReviewEvents();
  updateReviewStatus();
}

function renderWordList() {
  const list = document.getElementById('review-list');
  if (!list) return;

  const words = getWords();
  if (!words || words.length === 0) {
    list.innerHTML = '<p class="review-empty">还没有收藏单词，在看视频时点击单词即可添加</p>';
    return;
  }

  list.innerHTML = '';
  words.forEach((w, i) => {
    const item = document.createElement('div');
    item.className = 'vocab-item';
    item.innerHTML = `
      <span class="vocab-item-word">${escapeHtml(w.word)}</span>
      <span class="vocab-item-def">${escapeHtml(w.definition || w.context || '')}</span>
      <div class="vocab-item-actions">
        <button class="icon-btn" data-action="delete" data-index="${i}" title="删除">🗑</button>
      </div>
    `;
    list.appendChild(item);
  });
}

function bindReviewEvents() {
  const list = document.getElementById('review-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="delete"]');
      if (btn) {
        const idx = parseInt(btn.dataset.index, 10);
        const words = getWords();
        if (idx >= 0 && idx < words.length) {
          removeWord(words[idx].word);
          renderWordList();
          updateReviewStatus();
        }
      }
    });
  }

  const searchEl = document.getElementById('review-search');
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      filterWords(searchEl.value);
    });
  }

  const sortEl = document.getElementById('review-sort');
  if (sortEl) {
    sortEl.addEventListener('change', () => {
      sortWords(sortEl.value);
    });
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

function updateReviewStatus() {
  const words = getWords();
  const count = words ? words.length : 0;
  const statusEl = document.getElementById('status-text');
  if (statusEl) statusEl.textContent = `📖 ${count} 个生词`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
