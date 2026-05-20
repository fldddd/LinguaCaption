/**
 * LinguaCaption Local Storage Module (F6)
 *
 * Architecture (two-tier):
 *   Tier 1: localStorage  — 高速同步访问，用于偏好/词典缓存/同步镜像
 *   Tier 2: IndexedDB     — 可扩展异步存储，用于生词库/收藏列表 (F6.1)
 *
 * Sync Service (F6.2):
 *   缓存优先（Cache-First），优先读取本地 IndexedDB，
 *   缓存未命中时回退到后端 API，后台同步保持数据一致。
 *
 * F5 对接接口:
 *   getWords() / addWord() / removeWord() / searchWords()   ← 同步 (backward compat)
 *   asyncGetWords() / asyncAddWord() / asyncRemoveWord()     ← 异步 (IndexedDB)
 *   getFavorites() / saveFavorite() / deleteFavorite()       ← 缓存优先 + 后端同步
 *   syncFavorites() / clearCache()                            ← 同步控制
 *
 * Storage Key 设计 (localStorage):
 *   linguacaption:vocabulary    → 生词列表 (JSON array) — 同步镜像
 *   linguacaption:def:${word}  → 词典缓存 (含 timestamp + data)
 *   linguacaption:prefs        → 用户偏好设置 (JSON object)
 *
 * IndexedDB Design:
 *   DB: LinguaCaptionDB (v1)
 *   Stores:
 *     vocabulary  → { id, word, context, definition, phonetic, pos,
 *                     savedAt, reviewCount, isFavorite, syncedAt }
 *     sync_queue  → { id, action, payload, createdAt }
 */

/* ===================================================================
 *  Part 0: Constants & Config
 * =================================================================== */

const PREFIX = 'linguacaption:';
const DB_NAME = 'LinguaCaptionDB';
const DB_VERSION = 1;
const CACHE_TTL = 300_000; // 5 minutes for dictionary cache

/* ===================================================================
 *  Part 1: localStorage — 通用封装 (同步)
 * =================================================================== */

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

/* ===================================================================
 *  Part 2: IndexedDB — 异步存储层 (F6.1)
 * =================================================================== */

/**
 * Open (or create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  return new Promise((resolve, reject) => {
    let needsMigration = false;
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const oldVersion = event.oldVersion;

      // ── vocabulary store (生词/收藏) ──
      if (!db.objectStoreNames.contains('vocabulary')) {
        const store = db.createObjectStore('vocabulary', { keyPath: 'id', autoIncrement: true });
        store.createIndex('word', 'word', { unique: false });
        store.createIndex('savedAt', 'savedAt', { unique: false });
        store.createIndex('isFavorite', 'isFavorite', { unique: false });
        store.createIndex('syncedAt', 'syncedAt', { unique: false });
      }

      // ── sync_queue store (离线操作队列) ──
      if (!db.objectStoreNames.contains('sync_queue')) {
        db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
      }

      // Mark migration needed when upgrading from v0 (no DB)
      if (oldVersion === 0) {
        needsMigration = true;
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      if (needsMigration) {
        migrateFromLocalStorage(db);
      }
      resolve(db);
    };
    request.onerror = (event) => reject(event.target.error);
    request.onblocked = () => {
      console.warn('[IndexedDB] Database upgrade blocked — close other tabs');
    };
  });
}

/**
 * Seed IndexedDB from existing localStorage data on first migration.
 */
function migrateFromLocalStorage(db) {
  const tx = db.transaction('vocabulary', 'readwrite');
  const store = tx.objectStore('vocabulary');

  try {
    const existing = get('vocabulary', []);
    if (Array.isArray(existing) && existing.length > 0) {
      existing.forEach((entry, idx) => {
        store.add({
          ...entry,
          id: idx + 1,
          isFavorite: entry.isFavorite !== undefined ? entry.isFavorite : true,
          syncedAt: entry.syncedAt || null,
        });
      });
      console.log(`[IndexedDB] Migrated ${existing.length} words from localStorage`);
    }
  } catch (err) {
    console.warn('[IndexedDB] Migration error:', err);
  }

  tx.oncomplete = () => tx.db.close();
}

/**
 * Generic IndexedDB read/write helpers.
 */
function dbGetAll(storeName) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        resolve(req.result || []);
        db.close();
      };
      req.onerror = () => {
        reject(req.error);
        db.close();
      };
    });
  });
}

function dbGetByIndex(storeName, indexName, value) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const req = index.getAll(value);
      req.onsuccess = () => {
        resolve(req.result || []);
        db.close();
      };
      req.onerror = () => {
        reject(req.error);
        db.close();
      };
    });
  });
}

function dbAdd(storeName, entry) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.add(entry);
      req.onsuccess = () => {
        resolve(req.result);
        db.close();
      };
      req.onerror = () => {
        reject(req.error);
        db.close();
      };
    });
  });
}

function dbPut(storeName, entry) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(entry);
      req.onsuccess = () => {
        resolve(req.result);
        db.close();
      };
      req.onerror = () => {
        reject(req.error);
        db.close();
      };
    });
  });
}

function dbDelete(storeName, id) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(id);
      req.onsuccess = () => {
        resolve(true);
        db.close();
      };
      req.onerror = () => {
        reject(req.error);
        db.close();
      };
    });
  });
}

function dbClear(storeName) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => {
        resolve(true);
        db.close();
      };
      req.onerror = () => {
        reject(req.error);
        db.close();
      };
    });
  });
}

function dbCount(storeName) {
  return openDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.count();
      req.onsuccess = () => {
        resolve(req.result);
        db.close();
      };
      req.onerror = () => {
        reject(req.error);
        db.close();
      };
    });
  });
}

/* ===================================================================
 *  Part 3: Vocabulary CRUD — 同步 (localStorage 镜像, 向后兼容)
 * =================================================================== */

const VOCAB_KEY = 'vocabulary';

/**
 * Get all bookmarked vocabulary words (SYNC — from localStorage mirror).
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
 * Add a word to the vocabulary list (SYNC — localStorage).
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
 * Remove a word from vocabulary by word string (SYNC).
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
 * Update a word entry (SYNC).
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
 * Search words by query string (SYNC).
 * @param {string} query
 * @returns {Array}
 */
export function searchWords(query) {
  const q = query.toLowerCase().trim();
  if (!q) return getWords();
  return getWords().filter((w) => w.word.toLowerCase().includes(q));
}

/* ===================================================================
 *  Part 4: Vocabulary CRUD — 异步 (IndexedDB + localStorage 镜像同步)
 * =================================================================== */

/**
 * Get all vocabulary entries from IndexedDB (ASYNC).
 * @returns {Promise<Array>}
 */
export async function asyncGetWords() {
  try {
    const entries = await dbGetAll('vocabulary');
    return entries.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  } catch (err) {
    console.warn('[DB] asyncGetWords failed, falling back to localStorage:', err);
    return getWords();
  }
}

/**
 * Add a word to IndexedDB (ASYNC). Also updates localStorage mirror.
 * @param {object} entry
 * @returns {Promise<{success: boolean, id?: number, reason?: string}>}
 */
export async function asyncAddWord(entry) {
  // Check duplicate in IndexedDB first
  try {
    const existing = await dbGetByIndex('vocabulary', 'word', entry.word.toLowerCase());
    if (existing.length > 0) {
      return { success: false, reason: 'duplicate' };
    }
  } catch (err) {
    console.warn('[DB] asyncAddWord duplicate check failed:', err);
  }

  const newEntry = {
    word: entry.word.toLowerCase(),
    context: entry.context || '',
    definition: entry.definition || '',
    phonetic: entry.phonetic || '',
    pos: entry.pos || '',
    savedAt: entry.savedAt || new Date().toISOString(),
    reviewCount: entry.reviewCount || 0,
    isFavorite: entry.isFavorite !== undefined ? entry.isFavorite : true,
    syncedAt: null,
  };

  try {
    const id = await dbAdd('vocabulary', newEntry);

    // Update localStorage mirror for backward compatibility
    addWord(entry);

    return { success: true, id };
  } catch (err) {
    console.error('[DB] asyncAddWord failed:', err);
    // Fallback: just use localStorage
    const ok = addWord(entry);
    return { success: ok, reason: ok ? 'localstorage_fallback' : 'duplicate' };
  }
}

/**
 * Remove a word from IndexedDB by word string (ASYNC).
 * @param {string} word
 * @returns {Promise<boolean>}
 */
export async function asyncRemoveWord(word) {
  try {
    const existing = await dbGetByIndex('vocabulary', 'word', word.toLowerCase());
    if (existing.length === 0) {
      // Try localStorage fallback
      return removeWord(word);
    }
    await dbDelete('vocabulary', existing[0].id);

    // Also remove from localStorage mirror
    removeWord(word);
    return true;
  } catch (err) {
    console.warn('[DB] asyncRemoveWord failed, falling back to localStorage:', err);
    return removeWord(word);
  }
}

/**
 * Update a word entry in IndexedDB (ASYNC).
 * @param {string} word
 * @param {object} updates
 * @returns {Promise<boolean>}
 */
export async function asyncUpdateWord(word, updates) {
  try {
    const existing = await dbGetByIndex('vocabulary', 'word', word.toLowerCase());
    if (existing.length === 0) return false;
    const entry = existing[0];
    Object.assign(entry, updates);
    await dbPut('vocabulary', entry);
    updateWord(word, updates);
    return true;
  } catch (err) {
    console.warn('[DB] asyncUpdateWord failed, falling back to localStorage:', err);
    return updateWord(word, updates);
  }
}

/**
 * Search vocabulary in IndexedDB (ASYNC).
 * @param {string} query
 * @returns {Promise<Array>}
 */
export async function asyncSearchWords(query) {
  const q = query.toLowerCase().trim();
  if (!q) return asyncGetWords();
  try {
    const all = await dbGetAll('vocabulary');
    return all.filter((w) => w.word.toLowerCase().includes(q))
              .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  } catch (err) {
    console.warn('[DB] asyncSearchWords failed, falling back to localStorage:', err);
    return searchWords(query);
  }
}

/**
 * Get word count from IndexedDB (ASYNC).
 * @returns {Promise<number>}
 */
export async function asyncWordCount() {
  try {
    return await dbCount('vocabulary');
  } catch {
    return getWords().length;
  }
}

/**
 * Check if a word is in the vocabulary (ASYNC).
 * @param {string} word
 * @returns {Promise<boolean>}
 */
export async function asyncHasWord(word) {
  try {
    const results = await dbGetByIndex('vocabulary', 'word', word.toLowerCase());
    return results.length > 0;
  } catch {
    return getWords().some((w) => w.word.toLowerCase() === word.toLowerCase());
  }
}

/* ===================================================================
 *  Part 5: Favorites Cache & Sync (F6.2) — 缓存优先 + 后端同步
 * =================================================================== */

/**
 * Get favorites list — cache-first, fallback to backend API.
 *
 * 策略：
 *   1. 优先读取 IndexedDB 缓存
 *   2. 如果缓存为空，从后端 API 拉取
 *   3. 拉取后写入 IndexedDB 缓存
 *   4. 如果 API 不可用（离线），返回本地数据
 *
 * @param {object} [options] - { forceRefresh: boolean }
 * @returns {Promise<Array>}
 */
export async function getFavorites(options = {}) {
  const { forceRefresh = false } = options;

  // 1. Try IndexedDB cache first (unless force refresh)
  if (!forceRefresh) {
    try {
      const cached = await dbGetAll('vocabulary');
      if (cached.length > 0) {
        return cached.filter((w) => w.isFavorite !== false)
                     .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      }
    } catch (err) {
      console.warn('[Favorites] Cache read failed:', err);
    }

    // Fallback: localStorage mirror
    const localWords = getWords();
    if (localWords.length > 0) {
      return localWords;
    }
  }

  // 2. Cache empty or force refresh — try backend API
  try {
    const { getVocabulary } = await import('./api.js');
    const result = await getVocabulary({ page_size: 500 });
    const items = result.items || result || [];

    if (items.length > 0) {
      // Write to IndexedDB cache
      await dbClear('vocabulary');
      for (const item of items) {
        await dbAdd('vocabulary', {
          word: (item.word || '').toLowerCase(),
          context: item.context || '',
          definition: item.definition || '',
          phonetic: item.phonetic || '',
          pos: item.pos || '',
          savedAt: item.saved_at || item.savedAt || new Date().toISOString(),
          reviewCount: item.review_count || item.reviewCount || 0,
          isFavorite: item.is_favorite !== undefined ? item.is_favorite : true,
          syncedAt: new Date().toISOString(),
        });
      }

      // Also update localStorage mirror
      const localItems = items.map((item) => ({
        word: (item.word || '').toLowerCase(),
        context: item.context || '',
        definition: item.definition || '',
        phonetic: item.phonetic || '',
        pos: item.pos || '',
        savedAt: item.saved_at || item.savedAt || new Date().toISOString(),
        reviewCount: item.review_count || item.reviewCount || 0,
      }));
      set(VOCAB_KEY, localItems);

      return items;
    }
  } catch (err) {
    console.warn('[Favorites] Backend fetch failed (offline or server down):', err);
    // 3. Offline — return cached data
    const localWords = getWords();
    if (localWords.length > 0) {
      return localWords;
    }
  }

  return [];
}

/**
 * Save a word as favorite — local first, then sync to backend.
 *
 * 策略：
 *   1. 先写入 IndexedDB (即时可用)
 *   2. 再同步写入 localStorage 镜像
 *   3. 然后尝试推送到后端 API
 *   4. 如果离线，加入同步队列等待重试
 *
 * @param {object} entry - {word, context, definition, phonetic, pos}
 * @returns {Promise<{success: boolean, synced: boolean, offline: boolean}>}
 */
export async function saveFavorite(entry) {
  const now = new Date().toISOString();
  const word = (entry.word || '').toLowerCase().trim();
  if (!word) return { success: false, synced: false, offline: false };

  const result = { success: false, synced: false, offline: false };

  // 1. Write to IndexedDB (local first)
  try {
    const existing = await dbGetByIndex('vocabulary', 'word', word);
    if (existing.length > 0) {
      // Update existing entry
      const existingEntry = existing[0];
      Object.assign(existingEntry, {
        context: entry.context || existingEntry.context,
        definition: entry.definition || existingEntry.definition,
        phonetic: entry.phonetic || existingEntry.phonetic,
        pos: entry.pos || existingEntry.pos,
        isFavorite: true,
      });
      await dbPut('vocabulary', existingEntry);
    } else {
      await dbAdd('vocabulary', {
        word,
        context: entry.context || '',
        definition: entry.definition || '',
        phonetic: entry.phonetic || '',
        pos: entry.pos || '',
        savedAt: now,
        reviewCount: 0,
        isFavorite: true,
        syncedAt: null,
      });
    }
    result.success = true;
  } catch (err) {
    console.error('[Favorites] IndexedDB write failed:', err);
  }

  // 2. Update localStorage mirror
  const localOk = addWord({ word, ...entry, savedAt: now });
  if (!result.success && localOk) {
    result.success = true;
  }

  // 3. Try backend sync
  try {
    const { addWord: apiAddWord } = await import('./api.js');
    await apiAddWord({
      word,
      context: entry.context || '',
      definition: entry.definition || '',
      phonetic: entry.phonetic || '',
      pos: entry.pos || '',
    });
    result.synced = true;

    // Mark as synced in IndexedDB
    try {
      const synced = await dbGetByIndex('vocabulary', 'word', word);
      if (synced.length > 0) {
        synced[0].syncedAt = new Date().toISOString();
        await dbPut('vocabulary', synced[0]);
      }
    } catch { /* ignore */ }
  } catch (err) {
    console.warn('[Favorites] Backend sync failed (offline?), queuing for retry:', err);
    result.offline = true;

    // 4. Queue for later sync
    try {
      await dbAdd('sync_queue', {
        action: 'SAVE_FAVORITE',
        payload: { word, context: entry.context, definition: entry.definition, phonetic: entry.phonetic, pos: entry.pos },
        createdAt: now,
      });
    } catch { /* ignore */ }
  }

  return result;
}

/**
 * Delete a favorite — local first, then backend.
 * @param {string} word
 * @returns {Promise<{success: boolean, synced: boolean}>}
 */
export async function deleteFavorite(word) {
  const result = { success: false, synced: false };

  // 1. Remove from IndexedDB
  try {
    const existing = await dbGetByIndex('vocabulary', 'word', word.toLowerCase());
    if (existing.length > 0) {
      // Mark as not favorite instead of deleting (soft delete keeps history)
      existing[0].isFavorite = false;
      await dbPut('vocabulary', existing[0]);
    }
    result.success = true;
  } catch (err) {
    console.warn('[Favorites] IndexedDB delete failed:', err);
  }

  // 2. Remove from localStorage mirror
  removeWord(word);

  // 3. Try backend
  try {
    const { toggleFavorite } = await import('./api.js');
    await toggleFavorite(word);
    result.synced = true;
  } catch (err) {
    console.warn('[Favorites] Backend delete sync failed, queuing:', err);
    try {
      await dbAdd('sync_queue', {
        action: 'DELETE_FAVORITE',
        payload: { word },
        createdAt: new Date().toISOString(),
      });
    } catch { /* ignore */ }
  }

  return result;
}

/**
 * Sync all pending operations from the offline queue to backend.
 * Called on app startup when online.
 * @returns {Promise<{synced: number, failed: number}>}
 */
export async function syncFavorites() {
  // Check online status first
  if (!navigator.onLine) {
    console.log('[Sync] Offline, skipping sync');
    return { synced: 0, failed: 0, reason: 'offline' };
  }

  let synced = 0;
  let failed = 0;

  try {
    const queue = await dbGetAll('sync_queue');

    for (const item of queue) {
      try {
        const { addWord: apiAddWord, toggleFavorite } = await import('./api.js');

        if (item.action === 'SAVE_FAVORITE') {
          await apiAddWord(item.payload);
          synced++;
        } else if (item.action === 'DELETE_FAVORITE') {
          await toggleFavorite(item.payload.word);
          synced++;
        }

        // Remove from queue after successful sync
        await dbDelete('sync_queue', item.id);
      } catch (err) {
        console.warn('[Sync] Failed to sync item:', item.id, err);
        failed++;
      }
    }
  } catch (err) {
    console.warn('[Sync] Queue read failed:', err);
  }

  if (synced > 0) {
    console.log(`[Sync] Synced ${synced} items, ${failed} failed`);
  }

  return { synced, failed };
}

/**
 * Full two-way sync: pull from backend, merge with local.
 * @returns {Promise<{pulled: number, synced: number}>}
 */
export async function fullSync() {
  // 1. Push pending local changes
  const pushResult = await syncFavorites();

  // 2. Pull latest from backend
  let pulled = 0;
  try {
    const { getVocabulary } = await import('./api.js');
    const result = await getVocabulary({ page_size: 500 });
    const items = result.items || result || [];

    if (items.length > 0) {
      // Merge: for each backend item, update local if newer
      for (const item of items) {
        const word = (item.word || '').toLowerCase();
        try {
          const local = await dbGetByIndex('vocabulary', 'word', word);
          if (local.length === 0) {
            await dbAdd('vocabulary', {
              word,
              context: item.context || '',
              definition: item.definition || '',
              phonetic: item.phonetic || '',
              pos: item.pos || '',
              savedAt: item.saved_at || item.savedAt || new Date().toISOString(),
              reviewCount: item.review_count || item.reviewCount || 0,
              isFavorite: item.is_favorite !== undefined ? item.is_favorite : true,
              syncedAt: new Date().toISOString(),
            });
            pulled++;
          } else if (!local[0].syncedAt || local[0].syncedAt < (item.updated_at || '')) {
            // Backend has newer data — update local
            Object.assign(local[0], {
              context: item.context || local[0].context,
              definition: item.definition || local[0].definition,
              phonetic: item.phonetic || local[0].phonetic,
              pos: item.pos || local[0].pos,
              isFavorite: item.is_favorite !== undefined ? item.is_favorite : local[0].isFavorite,
              syncedAt: new Date().toISOString(),
            });
            await dbPut('vocabulary', local[0]);
          }
        } catch { /* skip individual item */ }
      }

      // Rebuild localStorage mirror
      const allLocal = await dbGetAll('vocabulary');
      const mirrorItems = allLocal
        .filter((w) => w.isFavorite !== false)
        .map(({ id, isFavorite, syncedAt, ...rest }) => rest);
      set(VOCAB_KEY, mirrorItems);
    }
  } catch (err) {
    console.warn('[Sync] Pull from backend failed:', err);
  }

  console.log(`[Sync] Full sync complete: pulled ${pulled} new items, pushed ${pushResult.synced}`);
  return { pulled, synced: pushResult.synced };
}

/* ===================================================================
 *  Part 6: Dictionary Cache (5-min TTL) — localStorage
 * =================================================================== */

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

/* ===================================================================
 *  Part 7: User Preferences — localStorage
 * =================================================================== */

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

/* ===================================================================
 *  Part 8: Offline Detection
 * =================================================================== */

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
  const goOnline = () => {
    if (onOnline) onOnline();
    // Auto-sync when coming back online
    syncFavorites().catch((err) => console.warn('[Network] Auto-sync on online:', err));
  };
  const goOffline = () => { if (onOffline) onOffline(); };
  window.addEventListener('online', goOnline);
  window.addEventListener('offline', goOffline);
  return () => {
    window.removeEventListener('online', goOnline);
    window.removeEventListener('offline', goOffline);
  };
}

/* ===================================================================
 *  Part 9: Cache Management
 * =================================================================== */

/**
 * Clear all vocabulary/favorites caches (IndexedDB + localStorage mirror).
 */
export async function clearVocabularyCache() {
  try {
    await dbClear('vocabulary');
    await dbClear('sync_queue');
  } catch (err) {
    console.warn('[Cache] IndexedDB clear failed:', err);
  }
  remove(VOCAB_KEY);
}

/**
 * Clear ALL storage (including preferences and dictionary cache).
 */
export async function clearAllCache() {
  // Clear IndexedDB
  try {
    await dbClear('vocabulary');
    await dbClear('sync_queue');
  } catch { /* ignore */ }

  // Clear localStorage
  const keysToRemove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((k) => localStorage.removeItem(k));
}

/**
 * Get storage stats for debugging.
 * @returns {Promise<{vocabCount: number, queueCount: number, localStorageSize: number}>}
 */
export async function getStorageStats() {
  let vocabCount = 0;
  let queueCount = 0;

  try {
    vocabCount = await dbCount('vocabulary');
  } catch { vocabCount = getWords().length; }

  try {
    queueCount = await dbCount('sync_queue');
  } catch { queueCount = 0; }

  let localStorageSize = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(PREFIX)) {
      const val = localStorage.getItem(key);
      if (val) localStorageSize += val.length * 2; // UTF-16
    }
  }

  return { vocabCount, queueCount, localStorageSize };
}

/* ===================================================================
 *  Part 10: Legacy API — 向后兼容封装
 * =================================================================== */

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
