/**
 * Local Storage Module — LinguaCaption 离线存储层
 *
 * Features (F6):
 *   - 生词 CRUD (getWords, addWord, removeWord, updateWord)
 *   - 词典缓存 (5 分钟 TTL)
 *   - 用户偏好设置
 *   - 离线检测 (navigator.onLine)
 *
 * Storage Key 设计:
 *   linguacaption:vocabulary    → 生词列表 (JSON array)
 *   linguacaption:def:${word}  → 词典缓存 (含 timestamp + data)
 *   linguacaption:prefs        → 用户偏好设置 (JSON object)
 */

const PREFIX = 'linguacaption:';

// ── 1. Generic Storage ─────────────────────────────────

function get(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function set(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.warn('Storage write failed:', e);
  }
}

function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch (e) {
    console.warn('Storage remove failed:', e);
  }
}

// ── 2. Vocabulary CRUD ─────────────────────────────────

const VOCAB_KEY = 'vocabulary';

/**
 * Get all bookmarked vocabulary words.
 * @returns {Array<{word, context, definition, phonetic, pos, savedAt, reviewCount}>}
 */
export function getWords() {
  return get(VOCAB_KEY, []);
}

/**
 * Get all words (alias for getWords).
 */
export function getAllWords() {
  return getWords();
}

/**
 * Add a word to the vocabulary list.
 * @param {object} entry - {word, context, definition, phonetic, pos, savedAt, reviewCount}
 * @returns {boolean} - true if added, false if duplicate
 */
export function addWord(entry) {
  const words = getWords();
  // Deduplicate by lowercase word
  if (words.some((w) => w.word.toLowerCase() === entry.word.toLowerCase())) {
    return false;
  }
  words.push({
    word: entry.word,
    context: entry.context || '',
    definition: entry.definition || '',
    phonetic: entry.phonetic || '',
    pos: entry.pos || '',
    savedAt: entry.savedAt || new Date().toISOString(),
    reviewCount: entry.reviewCount || 0,
  });
  set(VOCAB_KEY, words);
  return true;
}

/**
 * Remove a word from vocabulary by word string.
 * @param {string} word
 * @returns {boolean}
 */
export function removeWord(word) {
  const words = getWords();
  const idx = words.findIndex((w) => w.word.toLowerCase() === word.toLowerCase());
  if (idx === -1) return false;
  words.splice(idx, 1);
  set(VOCAB_KEY, words);
  return true;
}

/**
 * Update a word entry.
 * @param {string} word - original word to find
 * @param {object} updates - partial fields to update
 * @returns {boolean}
 */
export function updateWord(word, updates) {
  const words = getWords();
  const entry = words.find((w) => w.word.toLowerCase() === word.toLowerCase());
  if (!entry) return false;
  Object.assign(entry, updates);
  set(VOCAB_KEY, words);
  return true;
}

/**
 * Search words by query string.
 * @param {string} query
 * @returns {Array}
 */
export function searchWords(query) {
  const q = query.toLowerCase().trim();
  if (!q) return getWords();
  return getWords().filter((w) => w.word.toLowerCase().includes(q));
}

// ── 3. Dictionary Cache (5-min TTL) ───────────────────

const CACHE_TTL = 300_000; // 5 minutes

function cacheKey(word) {
  return `def:${word.toLowerCase().replace(/[^a-z']/g, '')}`;
}

/**
 * Get cached dictionary result.
 * @param {string} word
 * @returns {object|null} - {data, timestamp} or null if expired/missing
 */
export function getCachedDefinition(word) {
  const cached = get(cacheKey(word));
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }
  return null;
}

/**
 * Cache a dictionary result.
 * @param {string} word
 * @param {object} data
 */
export function setCachedDefinition(word, data) {
  set(cacheKey(word), { data, timestamp: Date.now() });
}

/**
 * Clear all expired dictionary cache entries.
 */
export function clearExpiredCache() {
  const now = Date.now();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX + 'def:')) {
      try {
        const val = JSON.parse(localStorage.getItem(key));
        if (now - val.timestamp >= CACHE_TTL) {
          localStorage.removeItem(key);
        }
      } catch {
        // corrupted entry, remove it
        localStorage.removeItem(key);
      }
    }
  }
}

// ── 4. User Preferences ────────────────────────────────

const PREFS_KEY = 'prefs';

const DEFAULT_PREFS = {
  volume: 0.8,
  subtitleFontSize: 15,
  playbackSpeed: 1.0,
  defaultMode: 'file',
  theme: 'dark',
};

/**
 * Get all user preferences.
 * @returns {object}
 */
export function getPrefs() {
  return { ...DEFAULT_PREFS, ...get(PREFS_KEY, {}) };
}

/**
 * Update user preferences (partial merge).
 * @param {object} updates
 */
export function setPrefs(updates) {
  const current = getPrefs();
  set(PREFS_KEY, { ...current, ...updates });
}

/**
 * Reset preferences to defaults.
 */
export function resetPrefs() {
  set(PREFS_KEY, DEFAULT_PREFS);
}

// ── 5. Offline Detection ───────────────────────────────

/**
 * Check if the app is currently online.
 * @returns {boolean}
 */
export function isOnline() {
  return navigator.onLine;
}

/**
 * Subscribe to online/offline events.
 * @param {function} onOnline
 * @param {function} onOffline
 * @returns {function} unsubscribe
 */
export function onNetworkChange(onOnline, onOffline) {
  const goOnline = () => { if (onOnline) onOnline(); };
  const goOffline = () => { if (onOffline) onOffline(); };
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  return () => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
  };
}

// ── Legacy API: backward-compatible wrappers ───────────

export function setItem(key, value) {
  set(key, value);
}

export function getItem(key, defaultValue = null) {
  return get(key, defaultValue);
}

export function removeItem(key) {
  remove(key);
}

export function clearAll() {
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
}
