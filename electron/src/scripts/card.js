/**
 * LinguaCaption — 单词释义卡片 (F3-NEW)
 *
 * 功能:
 *   1. 点击字幕单词弹出释义卡片
 *   2. 显示音标、词性、中文释义
 *   3. 发音播放（Web Speech API）
 *   4. 收藏单词到后端
 *   5. 关闭按钮 + 点击外部关闭
 *   6. 屏幕边界检测 + 位置自适应
 */

// =============================================================
// 常量
// =============================================================

import { BASE_URL as BACKEND_URL } from './api.js';
import log from './logger.js';
const CARD_WIDTH = 360;
const CARD_PADDING = 12; // px from edge
const LOOKUP_API = 'https://api.dictionaryapi.dev/api/v2/entries/en';

// =============================================================
// DOM Refs
// =============================================================

let cardEl = null;
let overlayEl = null;
let cardWordEl = null;
let cardPhoneticEl = null;
let cardPosEl = null;
let cardPronounceBtn = null;
let cardTranslationEl = null;
let cardContextTextEl = null;
let cardSourceEl = null;
let cardFavoriteBtn = null;
let cardCloseBtn = null;
let cardOverlay = null;

// =============================================================
// 状态
// =============================================================

/** @type {{ word: string, translation: string, phonetic: string, pos: string, context: string, source: string }|null} */
let currentWordData = null;
let isFavorited = false;
let isVisible = false;
let utterance = null;
let screenWidth = window.innerWidth;
let screenHeight = window.innerHeight;

// =============================================================
// 初始化
// =============================================================

function init() {
  // 获取 DOM 引用
  cardEl = document.getElementById('word-card');
  cardOverlay = document.getElementById('word-card-overlay');

  if (!cardEl || !cardOverlay) {
    log.error('[Card] DOM elements not found');
    return;
  }

  cardWordEl = cardEl.querySelector('.card-word');
  cardPhoneticEl = cardEl.querySelector('.card-phonetic');
  cardPosEl = cardEl.querySelector('.card-pos');
  cardPronounceBtn = cardEl.querySelector('.card-pronounce-btn');
  cardTranslationEl = cardEl.querySelector('.card-translation');
  cardContextTextEl = cardEl.querySelector('.card-context-text');
  cardSourceEl = cardEl.querySelector('.card-source');
  cardFavoriteBtn = cardEl.querySelector('.card-favorite-btn');
  cardCloseBtn = cardEl.querySelector('.card-close-btn');

  // 更新屏幕尺寸（窗口 resize 时）
  screenWidth = window.innerWidth;
  screenHeight = window.innerHeight;
  window.addEventListener('resize', () => {
    screenWidth = window.innerWidth;
    screenHeight = window.innerHeight;
  });

  // 绑定事件
  bindEvents();

  // 绑定 IPC 监听
  bindIpcListeners();
}

// =============================================================
// 事件绑定
// =============================================================

function bindEvents() {
  // 发音按钮
  if (cardPronounceBtn) {
    cardPronounceBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playPronunciation();
    });
  }

  // 收藏按钮
  if (cardFavoriteBtn) {
    cardFavoriteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavorite();
    });
  }

  // 关闭按钮
  if (cardCloseBtn) {
    cardCloseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideCard();
    });
  }

  // 点击遮罩关闭
  if (cardOverlay) {
    cardOverlay.addEventListener('click', () => {
      hideCard();
    });
  }

  // ESC 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isVisible) {
      hideCard();
    }
  });
}

// =============================================================
// IPC 监听
// =============================================================

function bindIpcListeners() {
  // 主进程通知显示卡片
  if (window.electronAPI && window.electronAPI.onWordCardShow) {
    window.electronAPI.onWordCardShow((data) => {
      showCard(data);
    });
  }

  // 主进程通知隐藏卡片
  if (window.electronAPI && window.electronAPI.onWordCardHide) {
    window.electronAPI.onWordCardHide(() => {
      hideCard();
    });
  }
}

// =============================================================
// 公共 API — 显示卡片
// =============================================================

/**
 * 在指定位置上方显示单词释义卡片
 * @param {{ word: string, context?: string, source?: string, x: number, y: number }} params
 */
function showCardForWord(params) {
  const { word, context, source, x, y } = params;

  if (!cardEl || !cardOverlay) return;

  // 设置加载状态
  setLoadingState();

  // 存储上下文信息
  currentWordData = {
    word,
    context: context || '',
    source: source || '',
  };

  // 显示卡片遮罩
  cardOverlay.classList.remove('hidden');

  // 定位卡片（先放到屏幕外计算大小）
  cardEl.classList.remove('hidden', 'visible');
  cardEl.style.left = '-9999px';
  cardEl.style.top = '-9999px';

  // 填充基础数据
  if (cardWordEl) cardWordEl.textContent = word;
  if (cardPhoneticEl) cardPhoneticEl.textContent = '';
  if (cardPosEl) cardPosEl.textContent = '';
  if (cardTranslationEl) {
    cardTranslationEl.innerHTML = '<div class="card-loading">查询中</div>';
  }
  if (cardContextTextEl) cardContextTextEl.textContent = context || '';
  if (cardSourceEl) cardSourceEl.textContent = source || '';
  if (cardFavoriteBtn) {
    cardFavoriteBtn.textContent = '⭐ 收藏';
    cardFavoriteBtn.classList.remove('favorited');
  }

  isFavorited = false;
  isVisible = true;

  // 查询单词信息
  fetchWordInfo(word);

  // 检测收藏状态
  checkFavoriteStatus(word);

  // 下一帧执行定位（等渲染完成得到实际高度）
  requestAnimationFrame(() => {
    positionCard(x, y);
  });
}

// =============================================================
// 词典 API 查询
// =============================================================

/**
 * 从 Free Dictionary API 获取单词信息
 * @param {string} word
 */
async function fetchWordInfo(word) {
  try {
    // 先尝试后端 API（如果存在）
    let data = null;
    let fromBackend = false;

    try {
      const backendResp = await fetch(`${BACKEND_URL}/api/vocab?search=${encodeURIComponent(word)}&page=1&page_size=1`, {
        signal: AbortSignal.timeout(2000),
      });
      if (backendResp.ok) {
        const json = await backendResp.json();
        if (json.items && json.items.length > 0) {
          data = { phonetic: json.items[0].phonetic, translation: json.items[0].translation, pos: json.items[0].part_of_speech };
          fromBackend = true;
        }
      }
    } catch (_) {
      // 忽略后端查询失败
    }

    // 如果后端没有，查 Free Dictionary API
    if (!data || (!data.phonetic && !data.translation)) {
      const resp = await fetch(`${LOOKUP_API}/${encodeURIComponent(word)}`, {
        signal: AbortSignal.timeout(5000),
      });

      if (resp.ok) {
        const json = await resp.json();
        const entry = json[0];
        if (entry) {
          const phonetic = entry.phonetic || (entry.phonetics && entry.phonetics.find(p => p.text)?.text) || '';
          const meanings = entry.meanings || [];
          const translations = meanings.map(m => {
            const pos = m.partOfSpeech || '';
            const defs = m.definitions || [];
            const firstDef = defs[0]?.definition || '';
            return { pos, definition: firstDef };
          });

          // 更新卡片
          if (cardPhoneticEl) cardPhoneticEl.textContent = phonetic || '';

          if (translations.length > 0) {
            const primary = translations[0];
            if (cardPosEl) {
              cardPosEl.textContent = primary.pos;
              cardPosEl.style.display = 'inline-block';
            }

            if (cardTranslationEl) {
              let html = '';
              for (let i = 0; i < Math.min(translations.length, 3); i++) {
                const t = translations[i];
                html += `<div class="translation-item">`;
                if (i === 0) {
                  html += `${escapeHtml(t.definition)}`;
                } else {
                  html += `<span style="color:rgba(255,255,255,0.5);font-size:12px;">${escapeHtml(t.pos)}</span> ${escapeHtml(t.definition)}`;
                }
                html += `</div>`;
              }
              cardTranslationEl.innerHTML = html;
            }
          } else {
            if (cardTranslationEl) cardTranslationEl.innerHTML = '<div style="color:rgba(255,255,255,0.4);">暂无释义</div>';
          }
        }
      } else {
        if (cardTranslationEl) {
          cardTranslationEl.innerHTML = '<div style="color:rgba(255,255,255,0.4);">未找到释义</div>';
        }
      }
    } else {
      // 使用后端数据
      if (cardPhoneticEl) cardPhoneticEl.textContent = data.phonetic || '';
      if (cardPosEl) {
        cardPosEl.textContent = data.pos || '';
        cardPosEl.style.display = data.pos ? 'inline-block' : 'none';
      }
      if (cardTranslationEl) {
        cardTranslationEl.innerHTML = `<div class="translation-item">${escapeHtml(data.translation || '暂无释义')}</div>`;
      }
    }
  } catch (err) {
    log.error('[Card] Fetch word info error:', err);
    if (cardTranslationEl) {
      cardTranslationEl.innerHTML = `<div class="card-error">查询失败<div class="card-error-detail">${escapeHtml(err.message || '网络错误')}</div></div>`;
    }
  } finally {
    // 重新定位（因为内容高度可能变化）
    if (isVisible && cardEl) {
      const rect = cardEl.getBoundingClientRect();
      if (rect.left >= 0 && rect.top >= 0) {
        // 只在卡片已定位时重新调整
        const left = parseFloat(cardEl.style.left);
        const top = parseFloat(cardEl.style.top);
        if (!isNaN(left) && !isNaN(top)) {
          positionCardInternal(left, top, rect);
        }
      }
    }
  }
}

// =============================================================
// 收藏状态检测
// =============================================================

async function checkFavoriteStatus(word) {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/vocab?search=${encodeURIComponent(word)}&page=1&page_size=1`, {
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      const json = await resp.json();
      if (json.items && json.items.length > 0) {
        isFavorited = true;
        if (cardFavoriteBtn) {
          cardFavoriteBtn.textContent = '★ 已收藏';
          cardFavoriteBtn.classList.add('favorited');
        }
      }
    }
  } catch (_) {
    // 静默处理
  }
}

// =============================================================
// 发音播放
// =============================================================

function playPronunciation() {
  const word = currentWordData?.word;
  if (!word) return;

  // 先尝试使用 Web Speech API
  if ('speechSynthesis' in window) {
    // 取消正在播放的
    if (utterance) {
      window.speechSynthesis.cancel();
    }

    utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = 0.85;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // 首选英文语音
    const voices = window.speechSynthesis.getVoices();
    const enVoice = voices.find(v => v.lang.startsWith('en') && v.name.includes('Google')) ||
                    voices.find(v => v.lang.startsWith('en-US')) ||
                    voices.find(v => v.lang.startsWith('en'));
    if (enVoice) {
      utterance.voice = enVoice;
    }

    // 播放状态反馈
    if (cardPronounceBtn) {
      cardPronounceBtn.classList.add('playing');
    }

    utterance.onend = () => {
      if (cardPronounceBtn) {
        cardPronounceBtn.classList.remove('playing');
      }
      utterance = null;
    };

    utterance.onerror = () => {
      if (cardPronounceBtn) {
        cardPronounceBtn.classList.remove('playing');
      }
      utterance = null;
    };

    window.speechSynthesis.speak(utterance);
  }
}

// =============================================================
// 收藏切换
// =============================================================

async function toggleFavorite() {
  const wordData = currentWordData;
  if (!wordData || !wordData.word) return;

  try {
    if (isFavorited) {
      // 取消收藏 — 先查询 ID 再删除
      const listResp = await fetch(`${BACKEND_URL}/api/vocab?search=${encodeURIComponent(wordData.word)}&page=1&page_size=1`);
      if (listResp.ok) {
        const listJson = await listResp.json();
        if (listJson.items && listJson.items.length > 0) {
          const vocabId = listJson.items[0].id;
          await fetch(`${BACKEND_URL}/api/vocab/${vocabId}`, { method: 'DELETE' });
        }
      }
      isFavorited = false;
      if (cardFavoriteBtn) {
        cardFavoriteBtn.textContent = '⭐ 收藏';
        cardFavoriteBtn.classList.remove('favorited');
      }
      showToast('已取消收藏');
    } else {
      // 收藏
      const body = {
        word: wordData.word,
        translation: cardTranslationEl ? cardTranslationEl.textContent?.trim() || undefined : undefined,
        phonetic: cardPhoneticEl ? cardPhoneticEl.textContent?.trim() || undefined : undefined,
        part_of_speech: cardPosEl ? cardPosEl.textContent?.trim() || undefined : undefined,
        context: wordData.context || undefined,
      };

      // 清理空字段
      Object.keys(body).forEach(k => {
        if (body[k] === undefined || body[k] === '') delete body[k];
      });

      const resp = await fetch(`${BACKEND_URL}/api/vocab`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (resp.ok || resp.status === 409) {
        // 409 = already exists, that's fine
        isFavorited = true;
        if (cardFavoriteBtn) {
          cardFavoriteBtn.textContent = '★ 已收藏';
          cardFavoriteBtn.classList.add('favorited');
        }
        showToast('⭐ 已收藏');
      } else {
        showToast('收藏失败，请重试');
      }
    }
  } catch (err) {
    log.error('[Card] Favorite error:', err);
    showToast('收藏失败');
  }
}

// =============================================================
// 卡片定位
// =============================================================

/**
 * 将卡片定位在目标位置上方
 * @param {number} targetX 目标 X (clientX)
 * @param {number} targetY 目标 Y (clientY)
 */
function positionCard(targetX, targetY) {
  if (!cardEl) return;

  const rect = cardEl.getBoundingClientRect();
  positionCardInternal(targetX, targetY, rect);
}

function positionCardInternal(targetX, targetY, cardRect) {
  if (!cardEl) return;

  const cardW = cardRect.width || CARD_WIDTH;
  const cardH = cardRect.height || 200;

  // 计算 X: 居中于目标位置，但不要超出屏幕
  let left = targetX - cardW / 2;
  left = Math.max(CARD_PADDING, Math.min(left, screenWidth - cardW - CARD_PADDING));

  // 计算 Y: 在目标位置上方弹出，如果不够空间则放到下方
  let top;
  const spaceAbove = targetY - CARD_PADDING;
  const spaceBelow = screenHeight - targetY - CARD_PADDING;

  if (spaceAbove >= cardH) {
    top = targetY - cardH - 4; // 上方，留 4px 间隙
  } else if (spaceBelow >= cardH) {
    top = targetY + 4; // 下方
  } else {
    // 都不够，垂直居中
    top = Math.max(CARD_PADDING, (screenHeight - cardH) / 2);
  }

  cardEl.style.left = Math.round(left) + 'px';
  cardEl.style.top = Math.round(top) + 'px';

  // 显示并触发动画
  cardEl.classList.remove('hidden');
  // 强制回流
  void cardEl.offsetWidth;
  cardEl.classList.add('visible');
}

// =============================================================
// 隐藏卡片
// =============================================================

function hideCard() {
  if (!cardEl || !cardOverlay) return;

  isVisible = false;
  cardEl.classList.remove('visible');
  cardEl.classList.add('hidden');
  cardOverlay.classList.add('hidden');

  // 取消正在播放的发音
  if (utterance) {
    window.speechSynthesis.cancel();
    utterance = null;
  }
  if (cardPronounceBtn) {
    cardPronounceBtn.classList.remove('playing');
  }

  currentWordData = null;
}

// =============================================================
// 辅助
// =============================================================

function setLoadingState() {
  if (cardTranslationEl) {
    cardTranslationEl.innerHTML = '<div class="card-loading">查询中</div>';
  }
  if (cardPhoneticEl) cardPhoneticEl.textContent = '';
  if (cardPosEl) {
    cardPosEl.textContent = '';
    cardPosEl.style.display = 'none';
  }
}

function showToast(message) {
  // 复用已有的 toast 或创建临时 toast
  let toast = document.getElementById('card-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'card-toast';
    toast.className = 'card-toast';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add('visible');

  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove('visible');
  }, 2000);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// =============================================================
// 窗口导出
// =============================================================

window.cardAPI = {
  init,
  showCardForWord,
  hideCard,
};
