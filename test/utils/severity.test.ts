import { describe, it, expect } from 'vitest';
import { Severity } from 'encode-yt-monitor-utils';

/**
 * Severity.fromString 决定 console / 面包屑的等级映射。
 * console 面包屑会按等级参与「错误上下文」展示，映射错位会让排查时看到的严重级别失真。
 */

describe('Severity.fromString', () => {
  it.each([
    { input: 'debug', expected: Severity.Debug },
    { input: 'info', expected: Severity.Info },
    { input: 'log', expected: Severity.Info },
    { input: 'assert', expected: Severity.Info },
    { input: 'warn', expected: Severity.Warning },
    { input: 'warning', expected: Severity.Warning },
    { input: 'error', expected: Severity.Error },
    { input: 'low', expected: Severity.Error },
    { input: 'normal', expected: Severity.Error },
    { input: 'high', expected: Severity.Error },
    { input: 'critical', expected: Severity.Error },
  ])('$input -> $expected', ({ input, expected }) => {
    expect(Severity.fromString(input)).toBe(expected);
  });

  it.each(['', 'trace', 'verbose', 'unknown'])('未识别的等级 "%s" 落到 Else', (input) => {
    expect(Severity.fromString(input)).toBe(Severity.Else);
  });

  it('枚举值本身作为上报字段使用，不能被随意改动', () => {
    expect(Severity.Error).toBe('error');
    expect(Severity.Warning).toBe('warning');
    expect(Severity.Info).toBe('info');
    expect(Severity.Low).toBe('low');
    expect(Severity.Normal).toBe('normal');
  });
});
