/**
 * PR #44: API 路径从 /api/vocabulary 改为 /api/vocab
 *
 * 测试 api.js 中各函数生成的 fetch URL 是否正确。
 * 覆盖：
 * - 路径路由（新路径 /api/vocab 和 /api/video/...）
 * - 请求方法（GET / POST / DELETE）
 * - 查询参数序列化
 * - 错误处理（非 200 响应）
 * - 边界情况（空参数、特殊字符）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after fetch is mocked
const api = await import('../src/scripts/api.js');

describe('api.js — getVocabulary', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('GET /api/vocab with no params', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [], total: 0 }),
    });

    const result = await api.getVocabulary();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/vocab');
    expect(opts.method).toBe('GET');
    expect(result).toEqual({ items: [], total: 0 });
  });

  it('GET /api/vocab with query params', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [{ id: 1, word: 'test' }], total: 1 }),
    });

    await api.getVocabulary({ page: 2, page_size: 10, search: 'test' });
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('page=2');
    expect(url).toContain('page_size=10');
    expect(url).toContain('search=test');
  });

  it('GET /api/vocab with special characters in search', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [], total: 0 }),
    });

    await api.getVocabulary({ search: "don't & co" });
    const [url] = mockFetch.mock.calls[0];
    // URLSearchParams encodes '&' as '%26' and spaces as '+' or '%20'
    expect(url).not.toContain("don't & co");  // should be URL-encoded
    expect(url).toContain('search=');
    expect(url).toContain('don');             // word stem still visible
  });
});

describe('api.js — addWord', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('POST /api/vocab with word data', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 1, word: 'hello' }),
    });

    const wordData = { word: 'hello', translation: '你好', part_of_speech: 'noun' };
    const result = await api.addWord(wordData);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/vocab');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual(wordData);
    expect(result).toEqual({ id: 1, word: 'hello' });
  });
});

describe('api.js — removeWord', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('DELETE /api/vocab/{id}', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await api.removeWord('42');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/vocab/42');
    expect(opts.method).toBe('DELETE');
  });

  it('non-numeric id', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await api.removeWord('abc-def');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/vocab/abc-def');
  });
});

describe('api.js — toggleFavorite', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('searches then deletes by id', async () => {
    // First call: search
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ items: [{ id: 7, word: 'test' }], total: 1 }),
      })
      // Second call: delete
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

    await api.toggleFavorite('test');

    // First call should search
    const [searchUrl] = mockFetch.mock.calls[0];
    expect(searchUrl).toContain('/api/vocab?search=test');

    // Second call should delete by id
    const [deleteUrl, deleteOpts] = mockFetch.mock.calls[1];
    expect(deleteUrl).toBe('http://localhost:8000/api/vocab/7');
    expect(deleteOpts.method).toBe('DELETE');
  });

  it('returns null when word not found', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ items: [], total: 0 }),
    });

    const result = await api.toggleFavorite('nonexistent');
    expect(result).toBeNull();
  });
});

describe('api.js — extractVideoUrl', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('GET /api/video/extract with url param', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ url: 'https://cdn.example.com/video.mp4' }),
    });

    const result = await api.extractVideoUrl('https://www.bilibili.com/video/BV1xx');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/video/extract?url=');
    expect(url).toContain(encodeURIComponent('https://www.bilibili.com/video/BV1xx'));
    expect(result.url).toBe('https://cdn.example.com/video.mp4');
  });

  it('throws error on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ detail: 'URL不能为空' }),
    });

    await expect(api.extractVideoUrl('')).rejects.toThrow('URL不能为空');
  });

  it('handles network error gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('NetworkError'));
    await expect(api.extractVideoUrl('https://example.com')).rejects.toThrow('NetworkError');
  });
});

describe('api.js — uploadAudio', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('POST /api/transcription/upload with FormData', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({ task_id: 'abc', status: 'processing' }),
    });

    const blob = new Blob(['audio data'], { type: 'audio/wav' });
    const result = await api.uploadAudio(blob, 'test.wav');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/transcription/upload');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeInstanceOf(FormData);
    expect(result.task_id).toBe('abc');
  });

  it('throws on upload failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 413,
      headers: new Map([['content-type', 'application/json']]),
      json: () => Promise.resolve({ detail: '文件过大' }),
    });

    const blob = new Blob(['too big'], { type: 'audio/wav' });
    await expect(api.uploadAudio(blob, 'big.wav')).rejects.toThrow('文件过大');
  });
});

describe('api.js — healthCheck', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('GET /api/health', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'ok', version: '0.1.0' }),
    });

    const result = await api.healthCheck();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/health');
    expect(result.status).toBe('ok');
  });
});

describe('api.js — getTranscription', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('GET /api/transcription/task/{id}', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ task_id: 'abc', status: 'completed', segments: [] }),
    });

    const result = await api.getTranscription('abc');
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:8000/api/transcription/task/abc');
    expect(result.status).toBe('completed');
  });
});
