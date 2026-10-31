import { describe, expect, it } from 'vitest';
import {
  formatFrameLocation,
  formatStackForCopy,
  isLinkableFrame,
  parseStack,
} from '../../admin/src/utils/stack';

/**
 * 错误列表展开行的堆栈解析。
 *
 * 覆盖两条真实路径：
 * 1. 当前 SDK：stack 是 JSON 帧数组（extractErrorStack 的产物）；
 * 2. 旧数据 / 手工上报：stack 是 Chrome / Firefox 的原始堆栈文本。
 */
describe('admin stack parser', () => {
  it('解析 SDK 的结构化帧数组', () => {
    const raw = JSON.stringify([
      { url: 'http://localhost/assets/index-abc.js', func: 'handleClick', line: 10, column: 5 },
      { url: null, func: 'native', line: null, column: null },
    ]);

    expect(parseStack(raw)).toEqual([
      { func: 'handleClick', url: 'http://localhost/assets/index-abc.js', line: 10, column: 5 },
    ]);
  });

  it('解析 Chrome / Firefox 原始堆栈文本', () => {
    const raw = [
      'Error: boom',
      '    at handleClick (http://localhost:2021/assets/app.js:10:5)',
      '    at async http://localhost/assets/app.js:2:3',
      'render@http://localhost/assets/app.js:4:7',
    ].join('\n');

    expect(parseStack(raw)).toEqual([
      { func: 'handleClick', url: 'http://localhost:2021/assets/app.js', line: 10, column: 5 },
      { func: 'anonymous', url: 'http://localhost/assets/app.js', line: 2, column: 3 },
      { func: 'render', url: 'http://localhost/assets/app.js', line: 4, column: 7 },
    ]);
  });

  it('空值 / 无法识别的文本返回空数组', () => {
    expect(parseStack(null)).toEqual([]);
    expect(parseStack('')).toEqual([]);
    expect(parseStack('native')).toEqual([]);
    expect(parseStack('{broken json')).toEqual([]);
  });

  it('格式化位置并判断是否可跳转', () => {
    const frame = { func: 'fn', url: 'https://cdn.example.com/app.js', line: 12, column: 8 };
    expect(formatFrameLocation(frame)).toBe('https://cdn.example.com/app.js:12:8');
    expect(formatFrameLocation({ func: 'fn', url: null, line: null, column: null })).toBe('native');
    expect(isLinkableFrame(frame)).toBe(true);
    expect(isLinkableFrame({ func: 'fn', url: 'webpack:///./src/a.ts', line: 1, column: 2 })).toBe(false);
    expect(formatStackForCopy([frame])).toBe(
      '#0 fn (https://cdn.example.com/app.js:12:8)',
    );
  });
});
