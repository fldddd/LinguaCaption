/**
 * LinguaCaption - Browser Overlay
 * Polished floating subtitle window for browser environment
 */

const SNAP_THRESHOLD = 20;
const STORAGE_KEY_POS = 'bo_position';
const STORAGE_KEY_MINI = 'bo_mini';

let overlayEl = null;
let boxEl = null;
let subtitleEl = null;
let statusDotEl = null;
let isVisible = false;
let isMini = false;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let currentText = '';

export class BrowserOverlay {
  constructor() {
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;
    this._create();
    this._bindDrag();
    this._bindButtons();
    this._restoreState();
    this.initialized = true;
    console.log('[BrowserOverlay] Initialized');
  }

  _create() {
    const old = document.getElementById('browser-overlay');
    if (old) old.remove();

    overlayEl = document.createElement('div');
    overlayEl.id = 'browser-overlay';
    overlayEl.className = 'browser-overlay';
    overlayEl.style.display = 'none';

    overlayEl.innerHTML = `
      <div class="browser-overlay-box" id="bo-box">
        <div class="bo-drag-handle" id="bo-drag">
          <span class="bo-drag-dots">&#x2807;</span>
          
          <button class="bo-restore-btn" id="bo-btn-restore" title="Expand">&#9650;</button>
          <span class="bo-status-dot bo-status-idle" id="bo-status"></span>
        </div>
        <div class="bo-subtitle" id="bo-subtitle">
          <span class="bo-subtitle-text bo-placeholder" id="bo-text">Waiting for transcription...</span>
        </div>
        <div class="bo-toolbar" id="bo-toolbar">
          <button class="bo-btn" id="bo-btn-fav" title="Favorite">&#11088;</button>
          <button class="bo-btn" id="bo-btn-copy" title="Copy">&#128203;</button>
          <button class="bo-btn" id="bo-btn-pause" title="Pause">&#9208;</button>
          <button class="bo-btn" id="bo-btn-mini" title="Mini">&#128311;</button>
          <button class="bo-btn bo-btn-close" id="bo-btn-close" title="Close">&#10005;</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlayEl);

    boxEl = document.getElementById('bo-box');
    subtitleEl = document.getElementById('bo-text');
    statusDotEl = document.getElementById('bo-status');
  }

  _bindDrag() {
    const handle = document.getElementById('bo-drag');
    if (!handle) return;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      const rect = boxEl.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      handle.style.cursor = 'grabbing';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let x = e.clientX - dragOffsetX;
      let y = e.clientY - dragOffsetY;
      // Snap to edges
      if (x < SNAP_THRESHOLD) x = 0;
      if (y < SNAP_THRESHOLD) y = 0;
      if (x + boxEl.offsetWidth > window.innerWidth - SNAP_THRESHOLD) x = window.innerWidth - boxEl.offsetWidth;
      if (y + boxEl.offsetHeight > window.innerHeight - SNAP_THRESHOLD) y = window.innerHeight - boxEl.offsetHeight;
      boxEl.style.left = x + 'px';
      boxEl.style.top = y + 'px';
      boxEl.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        const handle = document.getElementById('bo-drag');
        if (handle) handle.style.cursor = 'grab';
        this._savePosition();
      }
    });
  }

  _bindButtons() {
    const close = document.getElementById('bo-btn-close');
    if (close) close.addEventListener('click', () => this.hide());

    const mini = document.getElementById('bo-btn-mini');
    if (mini) mini.addEventListener('click', () => this.toggleMini());

    const restore = document.getElementById('bo-btn-restore');
    if (restore) restore.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent drag
      if (isMini) this.toggleMini();
    });

    const pause = document.getElementById('bo-btn-pause');
    if (pause) pause.addEventListener('click', () => {
      const isPaused = pause.textContent === '\u23F8';
      pause.textContent = isPaused ? '\u25B6' : '\u23F8';
    });

    const copy = document.getElementById('bo-btn-copy');
    if (copy) copy.addEventListener('click', () => {
      if (currentText) {
        navigator.clipboard.writeText(currentText).catch(() => {});
      }
    });
  }

  _restoreState() {
    try {
      const pos = JSON.parse(localStorage.getItem(STORAGE_KEY_POS));
      if (pos && boxEl) {
        boxEl.style.left = pos.x + 'px';
        boxEl.style.top = pos.y + 'px';
        boxEl.style.transform = 'none';
      }
      const mini = localStorage.getItem(STORAGE_KEY_MINI) === 'true';
      if (mini) this.toggleMini();
    } catch (e) {}
  }

  _savePosition() {
    if (!boxEl) return;
    const rect = boxEl.getBoundingClientRect();
    localStorage.setItem(STORAGE_KEY_POS, JSON.stringify({ x: rect.left, y: rect.top }));
  }

  show() {
    if (!this.initialized) this.init();
    if (!overlayEl || !boxEl) return;
    overlayEl.style.display = 'block';
    requestAnimationFrame(() => {
      boxEl.classList.add('visible');
    });
    isVisible = true;
    console.log('[BrowserOverlay] Show');
  }

  hide() {
    if (!boxEl) return;
    boxEl.classList.remove('visible');
    setTimeout(() => {
      if (overlayEl) overlayEl.style.display = 'none';
    }, 300);
    isVisible = false;
    console.log('[BrowserOverlay] Hide');
  }

  toggle() {
    isVisible ? this.hide() : this.show();
  }

  toggleMini() {
    if (!boxEl) return;
    isMini = !isMini;
    boxEl.classList.toggle('mini', isMini);
    localStorage.setItem(STORAGE_KEY_MINI, isMini);
  }

  setText(text) {
    currentText = text;
    if (!subtitleEl) return;
    if (text) {
      subtitleEl.textContent = text;
      subtitleEl.classList.remove('bo-placeholder');
    } else {
      subtitleEl.textContent = 'Waiting for transcription...';
      subtitleEl.classList.add('bo-placeholder');
    }
  }

  setStatus(status) {
    if (!statusDotEl) return;
    statusDotEl.className = 'bo-status-dot';
    if (status === 'active') statusDotEl.classList.add('bo-status-active');
    else if (status === 'paused') statusDotEl.classList.add('bo-status-paused');
    else statusDotEl.classList.add('bo-status-idle');
  }

  get isVisible() { return isVisible; }
  get isMini() { return isMini; }
}

let instance = null;
export function getBrowserOverlay() {
  if (!instance) instance = new BrowserOverlay();
  return instance;
}
export default getBrowserOverlay();

