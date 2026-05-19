/**
 * API client for LinguaCaption Python backend.
 * All calls go to http://localhost:8001 (FastAPI default).
 */

const BASE_URL = 'http://localhost:8000';

export { BASE_URL };

import log from './logger.js';

/**
 * Generic fetch wrapper with error handling.
 */
async function request(method, path, body = null) {
  const url = `${BASE_URL}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) {
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Upload audio file for transcription.
 * @param {Blob|File} audioBlob
 * @param {string} filename
 * @param {string} [model] - Whisper 模型大小: tiny/base/small/medium/large（留空使用默认）
 * @returns {Promise<{task_id: string, status: string, progress: number}>}
 */
export async function uploadAudio(audioBlob, filename, model) {
  const formData = new FormData();
  formData.append('file', audioBlob, filename);

  let url = `${BASE_URL}/api/transcription/upload`;
  if (model) {
    url += `?model=${encodeURIComponent(model)}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    headers: {
      'Accept': 'application/json',
    },
  });

  const contentType = res.headers.get('content-type');
  let err;

  if (!res.ok) {
    if (contentType && contentType.includes('application/json')) {
      err = await res.json();
    } else {
      err = { detail: await res.text() };
    }
    throw new Error(err.detail || `Upload failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Get transcription result by task ID.
 * @param {string} taskId
 * @returns {Promise<{task_id: string, status: string, segments: Array, text: string}>}
 */
export async function getTranscription(taskId) {
  return request('GET', `/api/transcription/task/${taskId}`);
}

/**
 * Get health check.
 * @returns {Promise<{status: string, version: string}>}
 */
export async function healthCheck() {
  return request('GET', '/api/health');
}

/**
 * Get vocabulary list (bookmarked words).
 * @param {object} params - {page, limit, sort}
 * @returns {Promise<{items: Array, total: number}>}
 */
export async function getVocabulary(params = {}) {
  const qs = new URLSearchParams(params).toString();
  return request('GET', `/api/vocab${qs ? '?' + qs : ''}`);
}

/**
 * Add a word to vocabulary.
 * @param {object} word - {word, definition, context}
 * @returns {Promise<{id: string, word: string}>}
 */
export async function addWord(word) {
  return request('POST', '/api/vocab', word);
}

/**
 * Remove a word from vocabulary.
 * @param {string} wordId
 */
export async function removeWord(wordId) {
  return request('DELETE', `/api/vocab/${wordId}`);
}

/**
 * Remove a word from vocabulary by looking up its ID first.
 * The backend has no /favorite endpoint, so we search by word
 * and delete via DELETE /api/vocab/{id}.
 * @param {string} word - The word text to unfavorite
 * @returns {Promise<object|null>}
 */
export async function toggleFavorite(word) {
  // Search for the word first to get its ID
  const listResp = await request('GET', `/api/vocab?search=${encodeURIComponent(word)}&page=1&page_size=1`);
  if (listResp.items && listResp.items.length > 0) {
    const vocabId = listResp.items[0].id;
    return request('DELETE', `/api/vocab/${vocabId}`);
  }
  return null;
}

/**
 * Get audio segment for a specific word pronunciation.
 *
 * Calls the backend API to extract a real audio segment from the recording.
 * Falls back to browser SpeechSynthesis when the API is unavailable
 * or when no source recording information is provided.
 *
 * @param {string} word        - The word to pronounce
 * @param {object} [opts]      - Optional parameters
 * @param {string} [opts.sourceAudio] - Filename in the backend audio uploads directory
 * @param {number} [opts.start]       - Segment start time in seconds
 * @param {number} [opts.end]         - Segment end time in seconds
 * @returns {Promise<string|null>} Audio blob URL, or null for TTS fallback
 */
export async function getAudioSegment(word, opts = {}) {
  const { sourceAudio, start, end } = opts;

  // If we have source recording data, try the real API
  if (sourceAudio) {
    try {
      const params = new URLSearchParams();
      params.set('word', word);
      params.set('source_audio', sourceAudio);
      if (start != null) params.set('start', String(start));
      if (end != null) params.set('end', String(end));

      const res = await fetch(`${BASE_URL}/api/audio/segment?${params}`);
      if (!res.ok) {
        log.warn(`Audio segment API returned ${res.status}, falling back to TTS`);
        return null;
      }
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch (err) {
      log.warn('Audio segment API unavailable, falling back to TTS:', err.message);
      return null;
    }
  }

  // No source recording — signal caller to use TTS fallback
  return null;
}

/**
 * Increment familiarity for a word (F1).
 * @param {string} word - The word to increment familiarity for
 * @returns {Promise<object>} Updated vocab entry
 */
export async function incrementFamiliarity(word) {
  return request('POST', `/api/vocabulary/${encodeURIComponent(word.toLowerCase())}/familiarity/increment`);
}

/**
 * Get all words with familiarity below threshold (F1).
 * @param {number} threshold - Familiarity threshold (default: 10)
 * @returns {Promise<{items: Array, total: number}>}
 */
export async function getLowFamiliarity(threshold = 10) {
  return request('GET', `/api/vocabulary/familiarity?threshold=${threshold}`);
}

/**
 * Extract video URL from video web page.
 * @param {string} url - The video page URL (e.g., Bilibili video page)
 * @returns {Promise<{url: string}>} The extracted direct video URL
 */
export async function extractVideoUrl(url) {
  const params = new URLSearchParams();
  params.set('url', url);
  
  const res = await fetch(`${BASE_URL}/api/video/extract?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Search words by keyword via backend API.
 * @param {string} keyword - Search keyword for fuzzy matching
 * @returns {Promise<{items: Array, total: number}>}
 */
export async function searchWords(keyword) {
  return getVocabulary({ search: keyword, page_size: 500 });
}

/**
 * Search provenance (word occurrence with context) via backend API.
 * @param {string} word - The word to search for
 * @param {string} [sessionId] - Optional session ID filter
 * @param {number} [limit=20] - Max results
 * @returns {Promise<{word: string, pos: string, matches: Array}>}
 */
export async function searchProvenance(word, sessionId, limit = 20) {
  const params = new URLSearchParams({ q: word, limit });
  if (sessionId) params.set('session_id', sessionId);
  return request('GET', `/api/search/provenance?${params}`);
}

/**
 * Get autocomplete suggestions for a word prefix.
 * @param {string} prefix - Word prefix
 * @param {number} [limit=10] - Max suggestions
 * @returns {Promise<Array<string>>}
 */
export async function searchSuggestions(prefix, limit = 10) {
  return request('GET', `/api/search/suggestions?q=${encodeURIComponent(prefix)}&limit=${limit}`);
}

/**
 * Search subtitle fragments by keyword.
 * @param {string} q - Search query
 * @param {string} [language] - Language filter
 * @param {number} [limit=50] - Max results
 * @returns {Promise<Array>}
 */
export async function searchFragments(q, language, limit = 50) {
  const params = new URLSearchParams({ q, limit });
  if (language) params.set('language', language);
  return request('GET', `/api/search/fragments?${params}`);
}

/**
 * List available sessions.
 * @param {number} [limit=20] - Max results
 * @returns {Promise<Array>}
 */
export async function listSessions(limit = 20) {
  return request('GET', `/api/sessions/list?limit=${limit}`);
}
