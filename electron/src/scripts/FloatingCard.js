/**
 * FloatingCard Module — F4 悬浮卡片（释义展示）
 *
 * Features:
 *   - F4.2: 鼠标悬停 0.3s 延迟触发
 *   - F4.1: 悬浮卡片 UI: 单词、音标、释义、例句
 *   - F4.3: 调用 Free Dictionary API 获取词数据
 *   - F4.4: 卡片位置计算，防止超出视口
 *   - F4.5: 鼠标移出后延时关闭
 *   - F4.6: 美式/英式音标展示
 */

/* ── Config ────────────────────────────────────────────── */

const HOVER_DELAY = 300;       // ms — F4.2: 0.3s 延迟
const CLOSE_DELAY = 200;       // ms — 移出后关闭延迟
const CARD_GAP = 8;            // px — 卡片与触发词间距
const CLOSE_ON_CLICK = true;   // 点击卡片外部或点击词时关闭

/* ── State ────────────────────────────────────────────── */

let floatingCardEl = null;     // DOM 元素
let hoverTimer = null;         // setTimeout ID for hover delay
let closeTimer = null;         // setTimeout ID for close delay
let currentWord = null;        // 当前悬停的单词
let isCardHovered = false;     // 鼠标是否在卡片上
let isWordHovered = false;     // 鼠标是否在单词上
let abortController = null;    // 用于取消 fetch

/* ── API Call (F4.3) ──────────────────────────────────── */

/**
 * 从 Free Dictionary API 获取单词数据
 * @param {string} word
 * @returns {Promise<object|null>} { word, usPhonetic, ukPhonetic, definitions: [{pos, definition, example}], source }
 */
async function fetchWordData(word) {
  try {
    const res = await fetch(
      `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data[0]) return null;

    const entry = data[0];

    // ── Phonetics (F4.6) — separate US / UK ───────────
    let usPhonetic = '';
    let ukPhonetic = '';
    if (entry.phonetics && entry.phonetics.length) {
      for (const ph of entry.phonetics) {
        if (!ph.text) continue;
        const t = ph.text;
        // Try to identify US vs UK by common patterns
        if (/us|US|american|AmE|ˈ|ˌ/.test(ph.license?.name || '') ||
            ph.audio?.includes('us') || ph.audio?.includes('american') ||
            t.includes('ə') || t.includes('ɑ')) {
          if (!usPhonetic) usPhonetic = t;
        } else if (/uk|UK|british|BrE/.test(ph.license?.name || '') ||
                   ph.audio?.includes('uk') || ph.audio?.includes('british')) {
          if (!ukPhonetic) ukPhonetic = t;
        } else if (!ukPhonetic) {
          // First one with audio → UK fallback
          if (ph.audio) ukPhonetic = t;
        }
      }
      // Fallback: use entry.phonetic or first available
      if (!usPhonetic && !ukPhonetic && entry.phonetics[0]?.text) {
        usPhonetic = entry.phonetics[0].text;
      }
    }
    if (!usPhonetic && !ukPhonetic && entry.phonetic) {
      usPhonetic = entry.phonetic;
    }

    // ── Meanings & Definitions ─────────────────────────
    const definitions = [];
    if (entry.meanings && entry.meanings.length) {
      for (const m of entry.meanings.slice(0, 3)) { // Max 3 parts of speech
        const pos = m.partOfSpeech || '';
        for (const d of m.definitions.slice(0, 2)) { // Max 2 definitions per POS
          definitions.push({
            pos,
            definition: d.definition || '',
            example: d.example || '',
          });
        }
      }
    }

    if (!definitions.length) return null;

    return {
      word: entry.word,
      usPhonetic,
      ukPhonetic,
      definitions,
      source: 'Free Dictionary API',
    };
  } catch {
    return null;
  }
}

/* ── Render (F4.1) ────────────────────────────────────── */

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderLoading(word, x, y) {
  destroyCard();

  const card = document.createElement('div');
  card.className = 'floating-card loading';
  card.innerHTML = `
    <div class="floating-card-word">${escapeHtml(word)}</div>
    <div class="floating-card-phonetics">
      <span class="skeleton" style="display:inline-block;height:14px;width:80px;"></span>
    </div>
    <div class="floating-card-body">
      <div class="skeleton" style="height:14px;width:100%;margin-bottom:6px;"></div>
      <div class="skeleton" style="height:14px;width:70%;"></div>
    </div>
  `;

  document.body.appendChild(card);
  floatingCardEl = card;
  positionCard(card, x, y);
}

function renderCard(data, x, y) {
  if (!floatingCardEl) return;
  floatingCardEl.classList.remove('loading');

  // Build phonetics HTML (F4.6)
  let phoneticsHtml = '';
  if (data.usPhonetic) {
    phoneticsHtml += `<span class="floating-card-phonetic">🇺🇸 ${escapeHtml(data.usPhonetic)}</span>`;
  }
  if (data.ukPhonetic) {
    phoneticsHtml += `<span class="floating-card-phonetic">🇬🇧 ${escapeHtml(data.ukPhonetic)}</span>`;
  }

  // Build definitions HTML
  let defsHtml = '';
  for (const d of data.definitions) {
    let exampleHtml = '';
    if (d.example) {
      exampleHtml = `<div class="floating-card-example">${escapeHtml(d.example)}</div>`;
    }
    defsHtml += `
      <div class="floating-card-def">
        ${d.pos ? `<span class="floating-card-pos">[${escapeHtml(d.pos)}]</span>` : ''}
        <span class="floating-card-def-text">${escapeHtml(d.definition)}</span>
        ${exampleHtml}
      </div>
    `;
  }

  floatingCardEl.innerHTML = `
    <div class="floating-card-word">${escapeHtml(data.word)}</div>
    ${phoneticsHtml ? `<div class="floating-card-phonetics">${phoneticsHtml}</div>` : ''}
    <div class="floating-card-body">${defsHtml}</div>
  `;

  positionCard(floatingCardEl, x, y);
}

function renderError(word, x, y) {
  if (!floatingCardEl) return;
  floatingCardEl.classList.remove('loading');
  floatingCardEl.innerHTML = `
    <div class="floating-card-word">${escapeHtml(word)}</div>
    <div class="floating-card-body">
      <span class="floating-card-error">未找到释义</span>
    </div>
  `;
  positionCard(floatingCardEl, x, y);
}

/* ── Position (F4.4) ──────────────────────────────────── */

/**
 * 计算卡片位置，确保不超出视口
 * 优先显示在单词下方，空间不足则上方
 */
function positionCard(card, triggerX, triggerY) {
  // 先添加卡片到 DOM 以获得尺寸
  // (已经在 document.body 中)
  const rect = card.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = rect.width;
  const cardH = rect.height;

  let left, top;

  // 水平位置：默认居中于触发点
  left = triggerX - cardW / 2;
  // 超出右边界 → 右对齐
  if (left + cardW > vw - 12) left = vw - cardW - 12;
  // 超出左边界 → 左对齐
  if (left < 12) left = 12;

  // 垂直位置：优先下方
  top = triggerY + CARD_GAP;
  // 下方空间不足 → 上方
  if (top + cardH > vh - 12) {
    top = triggerY - cardH - CARD_GAP;
  }
  // 上方仍不足 → 顶部对齐
  if (top < 12) top = 12;

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

/* ── Show / Hide (F4.2, F4.5) ─────────────────────────── */

function destroyCard() {
  if (floatingCardEl) {
    floatingCardEl.remove();
    floatingCardEl = null;
  }
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

function scheduleClose() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (!isCardHovered && !isWordHovered) {
      destroyCard();
      currentWord = null;
    }
  }, CLOSE_DELAY);
}

function cancelClose() {
  clearTimeout(closeTimer);
}

/**
 * 显示悬浮卡片 (对外暴露)
 * @param {string} word
 * @param {number} x - 鼠标 X 坐标
 * @param {number} y - 鼠标 Y 坐标
 */
function showFloatingCard(word, x, y) {
  // 如果已经显示同一个单词，保持现状
  if (currentWord === word && floatingCardEl) return;

  // 清除之前的定时器和卡片
  clearTimeout(hoverTimer);
  clearTimeout(closeTimer);
  destroyCard();

  currentWord = word;

  // 展示骨架屏 (F4.2 延迟已由调用方处理, 这里立即渲染)
  renderLoading(word, x, y);

  // 发起 API 请求 (F4.3)
  abortController = new AbortController();
  fetchWordData(word).then((data) => {
    if (currentWord !== word) return; // 单词已变
    if (data) {
      renderCard(data, x, y);
    } else {
      renderError(word, x, y);
    }
  }).catch(() => {
    if (currentWord === word) {
      renderError(word, x, y);
    }
  });
}

function hideFloatingCard() {
  scheduleClose();
}

/* ── Hover Integration (F4.2, F4.5) ───────────────────── */

/**
 * 绑定悬浮事件到单词元素
 * @param {Element} wordEl - .clickable-word 元素
 * @param {Element} container - 容器（用于事件委托）
 */
export function bindHoverToWord(wordEl) {
  let triggerTimer = null;

  const onMouseEnter = (e) => {
    isWordHovered = true;
    cancelClose();

    const word = wordEl.dataset.word;
    if (!word) return;

    // F4.2: 0.3s 延迟
    clearTimeout(triggerTimer);
    triggerTimer = setTimeout(() => {
      if (isWordHovered) {
        const rect = wordEl.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.bottom;
        showFloatingCard(word, x, y);
      }
    }, HOVER_DELAY);
  };

  const onMouseLeave = () => {
    isWordHovered = false;
    clearTimeout(triggerTimer);
    hideFloatingCard();
  };

  wordEl.addEventListener('mouseenter', onMouseEnter);
  wordEl.addEventListener('mouseleave', onMouseLeave);

  // 保存引用以便清理
  wordEl._fcCleanup = () => {
    wordEl.removeEventListener('mouseenter', onMouseEnter);
    wordEl.removeEventListener('mouseleave', onMouseLeave);
  };
}

/**
 * 清理单词的悬浮事件绑定
 */
export function unbindHoverFromWord(wordEl) {
  if (typeof wordEl._fcCleanup === 'function') {
    wordEl._fcCleanup();
    delete wordEl._fcCleanup;
  }
}

/* ── Card Hover Detection (F4.5) ──────────────────────── */

function setupCardEvents() {
  document.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.floating-card');
    if (card) {
      isCardHovered = true;
      cancelClose();
    }
  });

  document.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.floating-card');
    if (!card) {
      if (isCardHovered) {
        isCardHovered = false;
        if (!isWordHovered) {
          scheduleClose();
        }
      }
    }
  });
}

// 全局事件设置
setupCardEvents();

/* ── Click to Close ───────────────────────────────────── */

document.addEventListener('click', (e) => {
  if (!floatingCardEl) return;
  // 如果点击的不是卡片内部，关闭卡片
  if (!e.target.closest('.floating-card')) {
    destroyCard();
    currentWord = null;
    isWordHovered = false;
    isCardHovered = false;
  }
});

/* ── Exports ──────────────────────────────────────────── */

export { showFloatingCard, hideFloatingCard, fetchWordData };
