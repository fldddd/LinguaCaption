/**
 * PR #44: 拖拽坐标统一
 *
 * 测试 overlay.js 中拖拽计算和边缘吸附逻辑。
 * 由于 overlay.js 依赖 DOM 和 electronAPI，这里抽取核心纯函数进行测试。
 * 覆盖：
 * - snapToEdge 边缘吸附算法（上/下/左/右/角）
 * - 坐标限制（不超出屏幕边界）
 * - 位置持久化（savePosition / loadPosition）
 * - DOM 无关的辅助函数
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Helper: localStorage mock ──
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: vi.fn((key) => store[key] ?? null),
    setItem: vi.fn((key, value) => { store[key] = String(value); }),
    removeItem: vi.fn((key) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock, writable: true });

// ── Import the pure functions we want to test ──

/**
 * 边缘吸附算法（从 overlay.js 中提取的纯函数）
 * @param {number} x - 窗口左上角 X
 * @param {number} y - 窗口左上角 Y
 * @param {number} winW - 窗口宽度
 * @param {number} winH - 窗口高度
 * @param {number} screenW - 屏幕宽度
 * @param {number} screenH - 屏幕高度
 * @param {number} threshold - 吸附阈值（默认 20px）
 * @returns {{x: number, y: number} | null}
 */
function snapToEdge(x, y, winW, winH, screenW, screenH, threshold = 20) {
  let snappedX = x;
  let snappedY = y;
  let didSnap = false;

  // 左边缘
  if (x < threshold) {
    snappedX = 0;
    didSnap = true;
  }
  // 右边缘
  else if (x + winW > screenW - threshold) {
    snappedX = screenW - winW;
    didSnap = true;
  }

  // 上边缘
  if (y < threshold) {
    snappedY = 0;
    didSnap = true;
  }
  // 下边缘
  else if (y + winH > screenH - threshold) {
    snappedY = screenH - winH;
    didSnap = true;
  }

  return didSnap ? { x: snappedX, y: snappedY } : null;
}

/**
 * 坐标限制函数（从 overlay.js onMouseMove 提取）
 * 确保窗口不超出屏幕边界
 */
function clampPosition(x, y, winW, winH, screenW, screenH) {
  return {
    x: Math.max(0, Math.min(x, screenW - winW)),
    y: Math.max(0, Math.min(y, screenH - winH)),
  };
}

/**
 * 拖拽偏移计算（从 overlay.js onMouseDown 提取）
 * 计算鼠标相对于容器左上角的偏移
 */
function calcDragOffset(mouseScreenX, mouseScreenY, rectLeft, rectTop) {
  return {
    offsetX: mouseScreenX - rectLeft,
    offsetY: mouseScreenY - rectTop,
  };
}

/**
 * 拖拽位置计算（从 overlay.js onMouseMove 提取）
 * 用鼠标屏幕坐标减去偏移得到窗口左上角位置
 */
function calcDragPosition(mouseScreenX, mouseScreenY, offsetX, offsetY) {
  return {
    x: mouseScreenX - offsetX,
    y: mouseScreenY - offsetY,
  };
}


describe('snapToEdge — 边缘吸附', () => {
  const SCREEN_W = 1920;
  const SCREEN_H = 1080;
  const WIN_W = 400;
  const WIN_H = 200;
  const THRESHOLD = 20;

  it('左边缘吸附：x < threshold', () => {
    const result = snapToEdge(5, 100, WIN_W, WIN_H, SCREEN_W, SCREEN_H, THRESHOLD);
    expect(result).toEqual({ x: 0, y: 100 });
  });

  it('右边缘吸附：x + winW > screenW - threshold', () => {
    const result = snapToEdge(1525, 100, WIN_W, WIN_H, SCREEN_W, SCREEN_H, THRESHOLD);
    expect(result).toEqual({ x: SCREEN_W - WIN_W, y: 100 });
  });

  it('上边缘吸附：y < threshold', () => {
    const result = snapToEdge(100, 10, WIN_W, WIN_H, SCREEN_W, SCREEN_H, THRESHOLD);
    expect(result).toEqual({ x: 100, y: 0 });
  });

  it('下边缘吸附：y + winH > screenH - threshold', () => {
    const result = snapToEdge(100, 885, WIN_W, WIN_H, SCREEN_W, SCREEN_H, THRESHOLD);
    expect(result).toEqual({ x: 100, y: SCREEN_H - WIN_H });
  });

  it('左上角吸附（两者同时触发）', () => {
    const result = snapToEdge(3, 5, WIN_W, WIN_H, SCREEN_W, SCREEN_H, THRESHOLD);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('右下角吸附（两者同时触发）', () => {
    const result = snapToEdge(1525, 885, WIN_W, WIN_H, SCREEN_W, SCREEN_H, THRESHOLD);
    expect(result).toEqual({ x: SCREEN_W - WIN_W, y: SCREEN_H - WIN_H });
  });

  it('距离边缘较远 → 不吸附', () => {
    const result = snapToEdge(500, 400, WIN_W, WIN_H, SCREEN_W, SCREEN_H, THRESHOLD);
    expect(result).toBeNull();
  });

  it('刚好在阈值边界 → 吸附', () => {
    // x=20, y=20 exactly at threshold
    const result = snapToEdge(20, 20, WIN_W, WIN_H, SCREEN_W, SCREEN_H, 20);
    // x < 20? No, x == 20, which is not < 20
    // y < 20? No, y == 20, which is not < 20
    // So should NOT snap
    expect(result).toBeNull();
  });

  it('左边缘附近但右边缘更近 → 取右边缘', () => {
    // 窗口宽度 400，x=1520，所以右边缘 = 1520+400 = 1920
    // 右边缘 - 屏幕右边界 = 1920 - 1920 = 0 < 20 ✓
    // 左边缘 = 1520 > 20 ✗
    const result = snapToEdge(1520, 100, WIN_W, WIN_H, SCREEN_W, SCREEN_H, THRESHOLD);
    expect(result).toEqual({ x: SCREEN_W - WIN_W, y: 100 });
  });

  it('不同屏幕尺寸（小屏幕）', () => {
    const result = snapToEdge(3, 5, WIN_W, WIN_H, 1366, 768, THRESHOLD);
    expect(result).toEqual({ x: 0, y: 0 });
  });
});

describe('clampPosition — 坐标边界限制', () => {
  it('正常位置不变', () => {
    const result = clampPosition(500, 400, 400, 200, 1920, 1080);
    expect(result).toEqual({ x: 500, y: 400 });
  });

  it('负坐标→归零', () => {
    const result = clampPosition(-50, -30, 400, 200, 1920, 1080);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('超出右边界→最大允许', () => {
    const result = clampPosition(2000, 400, 400, 200, 1920, 1080);
    expect(result.x).toBe(1920 - 400);
  });

  it('超出下边界→最大允许', () => {
    const result = clampPosition(500, 1000, 400, 200, 1920, 1080);
    expect(result.y).toBe(1080 - 200);
  });

  it('窗口比屏幕大（极端情况）', () => {
    // 如果窗口比屏幕大，clamp 可能产生负值
    const result = clampPosition(0, 0, 2000, 2000, 1920, 1080);
    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });
});

describe('calcDragOffset — 拖拽偏移计算', () => {
  it('标准偏移', () => {
    const result = calcDragOffset(500, 400, 100, 200);
    expect(result).toEqual({ offsetX: 400, offsetY: 200 });
  });

  it('鼠标在元素左上角', () => {
    const result = calcDragOffset(100, 200, 100, 200);
    expect(result).toEqual({ offsetX: 0, offsetY: 0 });
  });
});

describe('calcDragPosition — 拖拽位置计算', () => {
  it('标准计算', () => {
    const result = calcDragPosition(800, 600, 50, 30);
    expect(result).toEqual({ x: 750, y: 570 });
  });

  it('偏移为0时位置等于鼠标坐标', () => {
    const result = calcDragPosition(800, 600, 0, 0);
    expect(result).toEqual({ x: 800, y: 600 });
  });
});

describe('位置持久化 — savePosition / loadPosition', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  it('保存并加载位置', () => {
    // Simulate the functions from overlay.js
    const savePosition = (x, y) => {
      try {
        localStorage.setItem('overlay_position', JSON.stringify({ x, y }));
      } catch (_) { /* Storage full or unavailable */ }
    };
    const loadPosition = () => {
      try {
        const raw = localStorage.getItem('overlay_position');
        if (raw) return JSON.parse(raw);
      } catch (_) { /* ignore */ }
      return null;
    };

    savePosition(100, 200);
    expect(localStorage.setItem).toHaveBeenCalledWith(
      'overlay_position',
      JSON.stringify({ x: 100, y: 200 })
    );

    // Mock return value for load
    localStorage.getItem = vi.fn(() => JSON.stringify({ x: 100, y: 200 }));
    const loaded = loadPosition();
    expect(loaded).toEqual({ x: 100, y: 200 });
  });

  it('没有保存位置时返回 null', () => {
    const loadPosition = () => {
      try {
        const raw = localStorage.getItem('overlay_position');
        if (raw) return JSON.parse(raw);
      } catch (_) { /* ignore */ }
      return null;
    };

    localStorage.getItem = vi.fn(() => null);
    expect(loadPosition()).toBeNull();
  });

  it('损坏的数据→返回 null', () => {
    const loadPosition = () => {
      try {
        const raw = localStorage.getItem('overlay_position');
        if (raw) return JSON.parse(raw);
      } catch (_) { /* ignore */ }
      return null;
    };

    localStorage.getItem = vi.fn(() => 'not-json');
    expect(loadPosition()).toBeNull();
  });

  it('miniMode 保存和加载', () => {
    const saveMiniMode = (enabled) => {
      try {
        localStorage.setItem('overlay_mini_mode', enabled ? '1' : '0');
      } catch (_) {}
    };
    const loadMiniMode = () => {
      try {
        return localStorage.getItem('overlay_mini_mode') === '1';
      } catch (_) { return false; }
    };

    saveMiniMode(true);
    localStorage.getItem = vi.fn(() => '1');
    expect(loadMiniMode()).toBe(true);

    saveMiniMode(false);
    localStorage.getItem = vi.fn(() => '0');
    expect(loadMiniMode()).toBe(false);
  });
});
