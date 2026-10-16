import { ErrorTypes } from 'encode-yt-monitor-shared';

/** window.onerror 常见脚本错误类型（与 ERROR_TYPE_RE 对齐） */
export const SCRIPT_ERROR_FIXTURES = [
  {
    name: 'TypeError',
    error: () => new TypeError('Cannot read properties of undefined'),
    message: 'Uncaught TypeError: Cannot read properties of undefined',
  },
  {
    name: 'ReferenceError',
    error: () => new ReferenceError('foo is not defined'),
    message: 'Uncaught ReferenceError: foo is not defined',
  },
  {
    name: 'SyntaxError',
    error: () => new SyntaxError('Unexpected token'),
    message: 'Uncaught SyntaxError: Unexpected token',
  },
  {
    name: 'RangeError',
    error: () => new RangeError('Invalid array length'),
    message: 'Uncaught RangeError: Invalid array length',
  },
  {
    name: 'URIError',
    error: () => new URIError('URI malformed'),
    message: 'Uncaught URIError: URI malformed',
  },
] as const;

export const EXPECTED_REPORT_TYPE = {
  script: ErrorTypes.JAVASCRIPT_ERROR,
  resource: ErrorTypes.RESOURCE_ERROR,
  vue: ErrorTypes.VUE_ERROR,
  react: ErrorTypes.REACT_ERROR,
} as const;
