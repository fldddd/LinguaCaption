/**
 * API client for LinguaCaption Python backend.
 * All calls go to http://localhost:8000 (FastAPI default).
 */

const BASE_URL = 'http://localhost:8000';

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
 * @returns {Promise<{task_id: string, status: string}>}
 */
export async function uploadAudio(audioBlob, filename) {
  const formData = new FormData();
  formData.append('file', audioBlob, filename);

  const res = await fetch(`${BASE_URL}/api/audio/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Get transcription result by task ID.
 * @param {string} taskId
 * @returns {Promise<{task_id: string, status: string, segments: Array, text: string}>}
 */
export async function getTranscription(taskId) {
  return request('GET', `/api/transcription/${taskId}`);
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
  return request('GET', `/api/vocabulary${qs ? '?' + qs : ''}`);
}

/**
 * Add a word to vocabulary.
 * @param {object} word - {word, definition, context}
 * @returns {Promise<{id: string, word: string}>}
 */
export async function addWord(word) {
  return request('POST', '/api/vocabulary', word);
}

/**
 * Remove a word from vocabulary.
 * @param {string} wordId
 */
export async function removeWord(wordId) {
  return request('DELETE', `/api/vocabulary/${wordId}`);
}

/**
 * Toggle favorite for a word.
 * @param {string} wordId
 * @returns {Promise<{id: string, is_favorite: boolean}>}
 */
export async function toggleFavorite(wordId) {
  return request('POST', `/api/vocabulary/${wordId}/favorite`);
}

/**
 * Get audio segment for a specific word pronunciation.
 * Mock implementation — returns a placeholder silent WAV blob URL.
 * @param {string} word
 * @returns {Promise<string>} audio blob URL
 */
export async function getAudioSegment(word) {
  const sampleRate = 8000;
  const duration = 0.5;
  const numSamples = Math.floor(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    view.setInt16(44 + i * 2, 0, true);
  }

  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}
