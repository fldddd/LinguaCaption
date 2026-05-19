/**
 * Settings module — persistent configuration panel
 *
 * Manages user settings stored in localStorage:
 *   - downloadDir: custom video download directory
 *
 * Exposed as window.__SETTINGS for cross-page persistence.
 */

const SETTINGS_KEY = 'linguacaption_settings';

/** Default settings */
export const DEFAULTS = {
  downloadDir: '',
  downloadMode: 'stream', // 'download' | 'stream'
  realtimeSubtitle: {
    enabled: false,
    language: 'zh-CN',
    autoTranslate: false,
    targetLanguage: 'en',
    showBilingual: false,
  },
};

/** Read settings from localStorage */
export function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed };
    }
  } catch (e) {
    console.warn('Failed to read settings:', e);
  }
  return { ...DEFAULTS };
}

/** Write settings to localStorage */
export function saveSettings(settings) {
  const merged = { ...getSettings(), ...settings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  window.__SETTINGS = merged;
  return merged;
}

/** Initialize settings on window for cross-page access */
window.__SETTINGS = getSettings();

/**
 * Open directory picker via Electron IPC.
 * Falls back to File System Access API in browser environments.
 */
export async function pickDirectory() {
  // Electron environment
  if (window.electronAPI && window.electronAPI.selectDirectory) {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      saveSettings({ downloadDir: dir });
      return dir;
    }
  }

  // Browser environment: use File System Access API
  if ('showDirectoryPicker' in window) {
    try {
      const dirHandle = await window.showDirectoryPicker();
      const dirPath = dirHandle.name;
      saveSettings({ downloadDir: dirPath });
      return dirPath;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('Directory picker failed:', err);
        throw new Error('无法选择目录');
      }
    }
  } else {
    throw new Error('您的浏览器不支持目录选择功能，请手动输入路径');
  }

  return null;
}

/**
 * Get the effective download directory for a given proxy call.
 * Returns a query string like "&download_dir=..." or "" if not set.
 */
export function getDownloadDirQuery() {
  const s = getSettings();
  if (s.downloadDir) {
    return `&download_dir=${encodeURIComponent(s.downloadDir)}`;
  }
  return '';
}
