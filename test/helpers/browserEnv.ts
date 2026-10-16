/**
 * vitest 的 jsdom 环境下 `window === globalThis`，`Object.prototype.toString.call(window)`
 * 返回 '[object global]' 而不是 '[object Window]'，会让 SDK 的浏览器环境探测
 * (`isBrowserEnv` / `getGlobal`) 失效 —— `_global` 会退化成 `process`，
 * 导致 replace.ts 里 `'XMLHttpRequest' in _global`、`'fetch' in _global` 直接 return。
 *
 * 本文件必须在任何 SDK 模块被导入之前执行（放在 import 列表首位），
 * 把 window 的 toStringTag 修正为 Window，让浏览器环境探测生效。
 */
if (typeof window !== 'undefined' && Object.prototype.toString.call(window) !== '[object Window]') {
  Object.defineProperty(window, Symbol.toStringTag, { value: 'Window', configurable: true });
}
