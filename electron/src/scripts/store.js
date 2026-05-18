/**
 * LinguaCaption Global Store — 跨页面状态管理
 *
 * 解决路由切换时 state 丢失的问题：
 * - 模块级 state（不依赖 DOM，切路由不销毁）
 * - localStorage 自动持久化
 * - 按 route key 隔离
 *
 * Architecture:
 *   store.get('watch.urlInput')        → 读取
 *   store.set('watch.urlInput', val)   → 写入 + 自动保存
 *   store.forget('watch')              → 页面离开前保存
 *   store.recall('watch')              → 页面进入后恢复
 *
 * 存储策略:
 *   localStorage 每 1s debounce 写入，避免高频更新阻塞 UI
 */

const STORAGE_KEY = 'linguacaption_ui_state';

// 全局 state（模块级引用，route 切换不丢失）
const _state = {};

// debounce timer
let _saveTimer = null;

/**
 * 从 localStorage 加载持久化 state
 */
function _loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      Object.assign(_state, parsed);
    }
  } catch (e) {
    console.warn('[Store] Failed to load persisted state:', e);
  }
}

/**
 * 异步 debounce 写入 localStorage
 */
function _persist() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
    } catch (e) {
      console.warn('[Store] Failed to persist state:', e);
    }
    _saveTimer = null;
  }, 1000);
}

// 初始化：加载持久化数据
_loadPersisted();

/**
 * ── Public API ──
 */

/**
 * 读取值
 * @param {string} key - 点分隔路径，如 'watch.urlInput'
 * @param {*} fallback - 默认值
 */
export function get(key, fallback = null) {
  const keys = key.split('.');
  let val = _state;
  for (const k of keys) {
    if (val === null || val === undefined || typeof val !== 'object') return fallback;
    val = val[k];
  }
  return val !== undefined ? val : fallback;
}

/**
 * 写入值（自动持久化到 localStorage）
 * @param {string} key - 点分隔路径
 * @param {*} value - 任意可 JSON 序列化的值
 */
export function set(key, value) {
  const keys = key.split('.');
  let target = _state;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!target[keys[i]] || typeof target[keys[i]] !== 'object') {
      target[keys[i]] = {};
    }
    target = target[keys[i]];
  }
  target[keys[keys.length - 1]] = value;
  _persist();
}

/**
 * 删除某个 key
 */
export function remove(key) {
  const keys = key.split('.');
  let target = _state;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!target[keys[i]]) return;
    target = target[keys[i]];
  }
  delete target[keys[keys.length - 1]];
  _persist();
}

/**
 * 保存某个 route 的全部 UI 状态（页面离开时调用）
 * 从 DOM 读取输入值并存入 store
 *
 * @param {string} route - 'watch' | 'point' | 'review'
 * @param {object} domSelectors - { key: selector } 映射
 */
export function forget(route, domSelectors = {}) {
  const snapshot = {};
  for (const [key, selector] of Object.entries(domSelectors)) {
    const el = document.querySelector(selector);
    if (el) {
      if (el.type === 'checkbox') {
        snapshot[key] = el.checked;
      } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        snapshot[key] = el.value;
      } else if (el.tagName === 'SELECT') {
        snapshot[key] = el.value;
      } else {
        snapshot[key] = el.textContent;
      }
    }
  }
  set(route, snapshot);
}

/**
 * 恢复某个 route 的 UI 状态（页面进入时调用）
 * 从 store 读值并写回 DOM
 *
 * @param {string} route - 'watch' | 'point' | 'review'
 * @param {object} domSelectors - { key: selector } 映射
 */
export function recall(route, domSelectors = {}) {
  const saved = get(route);
  if (!saved || typeof saved !== 'object') return;

  for (const [key, selector] of Object.entries(domSelectors)) {
    const val = saved[key];
    if (val === undefined || val === null) continue;
    const el = document.querySelector(selector);
    if (!el) continue;

    if (el.type === 'checkbox') {
      el.checked = !!val;
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.value = val;
    } else if (el.tagName === 'SELECT') {
      el.value = val;
    }
  }
}

/**
 * 清除某个 route 的全部 state
 */
export function clear(route) {
  remove(route);
}

/**
 * 读取整个 store 快照（用于调试）
 */
export function dump() {
  return JSON.parse(JSON.stringify(_state));
}

export default { get, set, remove, forget, recall, clear, dump };
