/**
 * Learning Module (F1: 学习数据系统)
 *
 * Features:
 *   - Fetch low-familiarity words from backend on page load
 *   - Cache the list locally for fast subtitle rendering
 *   - Mark unfamiliar words in subtitles with special CSS style
 *   - Provide helper to check if a word is "unfamiliar" (familiarity < threshold)
 */

import { getLowFamiliarity, incrementFamiliarity } from './api.js';
import log from './logger.js';

/* ── State ────────────────────────────────────────────── */

const DEFAULT_THRESHOLD = 10;

let unfamiliarWords = new Set();   // Set of lowercased words with familiarity < threshold
let threshold = DEFAULT_THRESHOLD;
let loaded = false;

/* ── Public API ───────────────────────────────────────── */

/**
 * Initialize the learning module.
 * Fetches low-familiarity words from the backend and caches them locally.
 * Call this once on app init (or per-page init for live/player).
 *
 * @param {number} [familiarityThreshold] - Override default threshold (10)
 */
export async function initLearning(familiarityThreshold) {
  if (familiarityThreshold !== undefined) {
    threshold = familiarityThreshold;
  }
  try {
    const result = await getLowFamiliarity(threshold);
    const items = result.items || [];
    unfamiliarWords = new Set(items.map((v) => v.word.toLowerCase()));
    loaded = true;
    log.info(`[Learning] Loaded ${unfamiliarWords.size} unfamiliar words (threshold=${threshold})`);
  } catch (err) {
    log.warn('[Learning] Failed to fetch unfamiliar words:', err);
    // Keep empty set so subtitles render normally
    unfamiliarWords = new Set();
    loaded = true;
  }
}

/**
 * Force refresh the unfamiliar words cache from backend.
 */
export async function refreshUnfamiliarWords() {
  unfamiliarWords = new Set();
  loaded = false;
  await initLearning(threshold);
}

/**
 * Check if a word is unfamiliar (familiarity < threshold).
 * @param {string} word
 * @returns {boolean}
 */
export function isUnfamiliar(word) {
  if (!loaded || !word) return false;
  return unfamiliarWords.has(word.toLowerCase());
}

/**
 * Get the current set of unfamiliar words.
 * @returns {Set<string>}
 */
export function getUnfamiliarWords() {
  return unfamiliarWords;
}

/**
 * Call this when a word's familiarity is incremented.
 * If the word was in the unfamiliar set and now meets the threshold,
 * it will be removed from the set.
 *
 * @param {string} word
 * @param {number} [newFamiliarity] - If provided, check threshold; otherwise re-fetch
 */
export async function markWordFamiliarityIncremented(word, newFamiliarity) {
  const lower = word.toLowerCase();
  // If we know the new familiarity >= threshold, remove from set
  if (newFamiliarity !== undefined && newFamiliarity >= threshold) {
    unfamiliarWords.delete(lower);
    return;
  }
  // Otherwise, re-fetch to be safe
  unfamiliarWords.delete(lower);
  try {
    await incrementFamiliarity(word);
    // After increment, check if it's still unfamiliar
    const result = await getLowFamiliarity(threshold);
    unfamiliarWords = new Set((result.items || []).map((v) => v.word.toLowerCase()));
  } catch (err) {
    log.warn('[Learning] Failed to refresh after increment:', err);
  }
}

/**
 * Call the backend API to increment familiarity, then update local cache.
 * @param {string} word
 */
export async function incrementAndCache(word) {
  try {
    const updated = await incrementFamiliarity(word);
    if (updated && updated.familiarity >= threshold) {
      unfamiliarWords.delete(word.toLowerCase());
    }
    return updated;
  } catch (err) {
    // Word might not exist in vocab yet — ignore silently
    if (err.message && err.message.includes('404')) {
      return null;
    }
    log.warn('[Learning] incrementAndCache failed:', err);
    return null;
  }
}
