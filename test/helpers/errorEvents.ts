/**
 * 构造与浏览器 window.onerror / addEventListener('error') 一致的 ErrorEvent
 */
export function createScriptErrorEvent(options: {
  message: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  error?: Error | null;
}): ErrorEvent {
  const event = new ErrorEvent('error', {
    message: options.message,
    filename: options.filename ?? 'http://localhost/app.js',
    lineno: options.lineno ?? 10,
    colno: options.colno ?? 5,
    error: options.error ?? undefined,
  });
  // 浏览器脚本错误时 target 为 Window；jsdom 默认 target 为 null
  Object.defineProperty(event, 'target', { value: window, enumerable: true });
  return event;
}

/** 资源加载失败：error 事件的 target 为 img/script 等 DOM 节点 */
export function createResourceErrorEvent(tagName: 'img' | 'script', src: string): ErrorEvent {
  const el = document.createElement(tagName);
  if (tagName === 'img') {
    (el as HTMLImageElement).src = src;
  } else {
    (el as HTMLScriptElement).src = src;
  }
  const event = new Event('error', { bubbles: false }) as ErrorEvent;
  Object.defineProperty(event, 'target', { value: el, enumerable: true });
  return event;
}

/** window 上触发 capture 阶段 error（与 listenError 一致） */
export function dispatchWindowError(event: ErrorEvent): void {
  window.dispatchEvent(event);
}

/**
 * 构造 unhandledrejection 事件，reason 可为任意值。
 * jsdom 未实现 PromiseRejectionEvent 构造器，这里用鸭子类型对象替代。
 */
export function createUnhandledRejectionEvent(reason: unknown): PromiseRejectionEvent {
  return {
    type: 'unhandledrejection',
    reason,
  } as unknown as PromiseRejectionEvent;
}
