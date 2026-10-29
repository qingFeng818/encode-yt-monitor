import { describe, it, expect, vi, afterEach } from 'vitest';
import { nativeTryCatch } from 'encode-yt-monitor-utils';

/**
 * nativeTryCatch 是 SDK 里所有「不能影响业务」逻辑的最后一道保险。
 * 它自己绝不能再抛错、也不能用 console 打日志：
 * console 会被 SDK 拦截，在 catch 里打日志等于把异常送回拦截逻辑，形成递归。
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('nativeTryCatch', () => {
  it('fn 抛错时不向调用方抛出，并把错误交给 errorFn', () => {
    const errorFn = vi.fn();
    expect(() =>
      nativeTryCatch(() => {
        throw new Error('boom');
      }, errorFn),
    ).not.toThrow();
    expect(errorFn).toHaveBeenCalledTimes(1);
    expect((errorFn.mock.calls[0][0] as Error).message).toBe('boom');
  });

  it('错误处理路径不调用 console.*（避免触发 console 拦截递归）', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    nativeTryCatch(() => {
      throw new Error('boom');
    });

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('fn 不抛错时不调用 errorFn', () => {
    const errorFn = vi.fn();
    nativeTryCatch(() => undefined, errorFn);
    expect(errorFn).not.toHaveBeenCalled();
  });
});
