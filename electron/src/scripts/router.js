/**                                                                            
 * Hash-based SPA Router — LinguaCaption                                       
 *                                                                            
 * Routes:                                                                    
 *   #/watch   → 点读播放器（视频+字幕同步）                                    
 *   #/point   → 纯点读模式（字幕+音频，无视频）                                
 *   #/review  → 生词复习                                                      
 *                                                                            
 * Usage:                                                                     
 *   import { registerRoute, navigateTo, startRouter } from './router.js';    
 *   registerRoute('/watch', (container) => { ... });                          
 *   startRouter();                                                           
 */

/**
 * Route table — maps hash paths to human-readable names
 */
export const ROUTES = {
  WATCH: '/watch',
  POINT: '/point',
  REVIEW: '/review',
};

const routes = new Map();
let contentContainer = null;

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
 * Handle route change: read hash, find handler, render.
 */
function handleRoute() {
  const path = window.location.hash.slice(1) || ROUTES.WATCH;

  if (!contentContainer) {
    contentContainer = document.getElementById('app-content');
    if (!contentContainer) return;
  }

  const handler = routes.get(path);
  if (handler) {
    handler(contentContainer);
    updateActiveNav(path);
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
