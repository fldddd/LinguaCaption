/**
 * Settings module — persistent configuration panel
 *
 * Manages user settings stored in localStorage:
 *   - downloadDir: custom video download directory
 *   - downloadEnabled: whether to download videos to local (default: true)
 *
 * Exposed as window.__SETTINGS for cross-page persistence.
 */

const SETTINGS_KEY = 'linguacaption_settings';

/** Default settings */
export const DEFAULTS = {
  downloadDir: '',
  downloadEnabled: true,
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
 * Open directory picker via Electron IPC, with browser fallback.
 */
export async function pickDirectory() {
  // Electron: use IPC dialog
  if (window.electronAPI && window.electronAPI.selectDirectory) {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      saveSettings({ downloadDir: dir });
      return dir;
    }
  }
  // Browser fallback: prompt user to enter path manually
  const manual = prompt('请输入下载目录路径（留空使用默认目录）：');
  if (manual && manual.trim()) {
    saveSettings({ downloadDir: manual.trim() });
    return manual.trim();
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
 * Check if download mode is enabled (for loadVideoFromUrl)
 */
export function isDownloadEnabled() {
  return getSettings().downloadEnabled !== false;
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
