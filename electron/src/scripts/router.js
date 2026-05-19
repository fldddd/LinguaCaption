/**
 * Hash-based SPA Router — LinguaCaption
 *
 * Routes:
 *   #/player  → 统一媒体播放器（视频/音频自动识别）
 *   #/review  → 生词复习
 *   #/live    → 实时转录
 *   Aliases: #/watch, #/point → #/player (向后兼容)
 *
 * Usage:
 *   import { registerRoute, navigateTo, startRouter } from './router.js';
 *   registerRoute('/player', (container) => { ... });
 *   startRouter();
 */

/**
 * Route table — maps hash paths to human-readable names
 */
export const ROUTES = {
  PLAYER: '/player',
  REVIEW: '/review',
  LIVE: '/live',
};

/** 向后兼容别名映射 */
const ALIASES = {
  '/watch': '/player',
  '/point': '/player',
};

const routes = new Map();
let contentContainer = null;
let _beforeRouteChange = null;

/**
 * 注册路由切换前的钩子
 * 在路由处理函数执行之前调用，用于保存当前页面的状态
 * @param {(fromPath: string, toPath: string) => void} hook
 */
export function onBeforeRouteChange(hook) {
  _beforeRouteChange = hook;
}

/**
 * Register a route handler.
 * @param {string} path - Route path, e.g. '/player'
 * @param {(container: HTMLElement) => void} handler - Callback that renders into the container
 */
export function registerRoute(path, handler) {
  routes.set(path, handler);
}

/**
 * Navigate to a route.
 * @param {string} path - Route path
 */
export function navigateTo(path) {
  window.location.hash = '#' + path;
}

/**
 * Update active nav button styling.
 */
function updateActiveNav(path) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    const route = btn.getAttribute('data-route');
    btn.classList.toggle('active', route === path);
  });
}

/**
 * Handle route change: read hash, resolve aliases, find handler, render.
 */
function handleRoute() {
  let path = window.location.hash.slice(1) || ROUTES.PLAYER;

  // 解析别名：/watch 和 /point 统一映射到 /player
  if (ALIASES[path]) {
    path = ALIASES[path];
  }

  if (!contentContainer) {
    contentContainer = document.getElementById('app-content');
    if (!contentContainer) {
      console.error('❌ App content container not found');
      return;
    }
  }

  // 调用路由切换前置钩子（保存当前页面状态）
  if (_beforeRouteChange) {
    _beforeRouteChange(path);
  }

  const handler = routes.get(path);
  if (handler) {
    handler(contentContainer);
    updateActiveNav(path);
  } else {
    console.warn(`⚠️ Route not found: ${path}, falling back to ${ROUTES.PLAYER}`);
    contentContainer.innerHTML = `
      <div style="text-align:center;padding:40px;color:#666;">
        <h3>页面未找到</h3>
        <p>路由 <code>${path}</code> 不存在</p>
        <p>正在跳转到首页...</p>
      </div>
    `;
    setTimeout(() => navigateTo(ROUTES.PLAYER), 2000);
  }
}

/**
 * Start the router: bind hashchange and initial route.
 */
export function startRouter() {
  contentContainer = document.getElementById('app-content');

  // Handle nav button clicks
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-route]');
    if (btn) {
      e.preventDefault();
      navigateTo(btn.getAttribute('data-route'));
    }
  });

  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}
