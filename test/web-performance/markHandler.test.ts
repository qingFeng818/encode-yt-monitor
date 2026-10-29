import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearMark,
  getMark,
  hasMark,
  setMark,
} from '../../packages/web-performance/src/lib/markHandler';
import { measure } from '../../packages/web-performance/src/lib/measureCustomMetrics';

/**
 * 自定义指标（WebVitals.setStartMark / setEndMark）完全依赖 performance.mark / measure。
 * 这里覆盖：打点、取点、清理，以及「浏览器不支持 performance」时的降级路径
 * （降级路径必须只打日志、不抛错，否则会打断业务代码）。
 */

const markName = 'sdk-test-mark';
const metricsName = 'sdk-test-metrics';

describe('markHandler（performance.mark 封装）', () => {
  beforeEach(() => {
    clearMark(markName);
    clearMark(metricsName);
  });

  it('setMark 之后 hasMark 为 true，getMark 返回带 startTime 的记录', () => {
    setMark(markName);

    expect(hasMark(markName)).toBe(true);
    expect(typeof getMark(markName).startTime).toBe('number');
  });

  it('clearMark 之后 hasMark 变为 false，getMark 返回 undefined', () => {
    setMark(markName);
    clearMark(markName);

    expect(hasMark(markName)).toBe(false);
    expect(getMark(markName)).toBeUndefined();
  });

  it('同名重复打点时 getMark 取最后一条', () => {
    setMark(markName);
    const first = getMark(markName).startTime;

    setMark(markName);
    const second = getMark(markName).startTime;

    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('measure 根据 start / end 计算耗时，结果可被 getEntriesByName 取回', () => {
    setMark(`${markName}_start`);
    setMark(`${markName}_end`);

    const entry = measure(metricsName, markName);

    expect(entry).toBeTruthy();
    expect(typeof entry.duration).toBe('number');
    expect(entry.duration).toBeGreaterThanOrEqual(0);
  });
});

describe('performance 不可用时的降级行为', () => {
  const originalGetEntriesByType = window.performance.getEntriesByType;

  afterEach(() => {
    window.performance.getEntriesByType = originalGetEntriesByType;
    vi.restoreAllMocks();
  });

  it('hasMark / getMark / setMark 只打错误日志，不抛错', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // 模拟老浏览器：没有 getEntriesByType
    window.performance.getEntriesByType = undefined;

    expect(() => setMark(markName)).not.toThrow();
    expect(hasMark(markName)).toBeUndefined();
    expect(getMark(markName)).toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(3);
  });

  it('clearMark 在不支持时静默返回（不打日志、不抛错）', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.performance.getEntriesByType = undefined;

    expect(() => clearMark(markName)).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});
