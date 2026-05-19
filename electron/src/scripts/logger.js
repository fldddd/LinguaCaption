/**
 * logger.js — 统一前端日志模块
 *
 * 生产环境（process.env.NODE_ENV === 'production'）只输出 warn/error，
 * 开发环境输出 debug/info/warn/error 全部级别。
 *
 * 用法:
 *   import log from './logger.js';
 *   log.debug('some debug message');
 *   log.info('some info message');
 *   log.warn('some warning', err);
 *   log.error('some error', err);
 */

const LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/* 判断当前环境（兼容 Vite import.meta.env 和 process.env） */
const isDev = (typeof import.meta !== 'undefined' && import.meta.env?.MODE === 'development')
  || (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production');

/* 当前日志级别：开发环境输出全部，生产环境只输出 warn/error */
const currentLevel = isDev ? LEVELS.debug : LEVELS.warn;

/**
 * 格式化时间戳
 * @returns {string} HH:MM:SS.mmm
 */
function timestamp() {
  const d = new Date();
  return d.toLocaleTimeString('zh-CN', { hour12: false })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

/**
 * 生成一个简短的调用位置标记
 * @returns {string}
 */
function callerTag() {
  try {
    throw new Error();
  } catch (e) {
    const stack = e.stack?.split('\n') || [];
    // stack[0] = "Error", stack[1] = timestamp()/callerTag(), stack[2] = actual caller, stack[3]+ = deeper frames
    for (let i = 2; i < stack.length; i++) {
      const line = stack[i].trim();
      // 跳过当前模块自身
      if (line.includes('logger.js')) continue;
      // 匹配类似 "at functionName (file.js:123:45)" 或 "at file.js:123:45"
      const match = line.match(/at\s+(?:.*?\s+\()?(.+?):(\d+):(\d+)\)?$/);
      if (match) {
        const file = match[1].split('/').pop() || match[1];
        return `${file}:${match[2]}`;
      }
    }
    return '';
  }
}

const logger = {
  debug(...args) {
    if (currentLevel > LEVELS.debug) return;
    const tag = callerTag();
    if (tag) {
      console.debug(`[${timestamp()}] [DEBUG] [${tag}]`, ...args);
    } else {
      console.debug(`[${timestamp()}] [DEBUG]`, ...args);
    }
  },

  info(...args) {
    if (currentLevel > LEVELS.info) return;
    const tag = callerTag();
    if (tag) {
      console.info(`[${timestamp()}] [INFO] [${tag}]`, ...args);
    } else {
      console.info(`[${timestamp()}] [INFO]`, ...args);
    }
  },

  warn(...args) {
    if (currentLevel > LEVELS.warn) return;
    const tag = callerTag();
    if (tag) {
      console.warn(`[${timestamp()}] [WARN] [${tag}]`, ...args);
    } else {
      console.warn(`[${timestamp()}] [WARN]`, ...args);
    }
  },

  error(...args) {
    if (currentLevel > LEVELS.error) return;
    const tag = callerTag();
    if (tag) {
      console.error(`[${timestamp()}] [ERROR] [${tag}]`, ...args);
    } else {
      console.error(`[${timestamp()}] [ERROR]`, ...args);
    }
  },
};

export default logger;
