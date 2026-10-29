import { describe, it, expect, vi } from 'vitest';
import { EventTypes } from 'encode-yt-monitor-shared';
import { subscribeEvent, triggerHandlers } from 'encode-yt-monitor-core';
import { logger } from 'encode-yt-monitor-utils';

/**
 * subscribe / trigger 是所有拦截器的分发中枢（xhr、fetch、error、console、route 都走这里）。
 * 三件事必须有保证：
 * 1. 同一个事件类型只能注册一次 —— 否则同一请求会被上报两遍；
 * 2. 未注册的类型被触发时不能抛错 —— 拦截器是「先替换再订阅」，顺序不保证；
 * 3. 某个回调抛错不能影响后续回调 —— 监控不能反过来打断业务。
 *
 * 注意：每个用例使用互不相同的 EventTypes，避免 handlers 模块级缓存互相影响。
 */

describe('subscribeEvent', () => {
  it('首次注册返回 true，触发时回调拿到原始数据', () => {
    const callback = vi.fn();
    expect(subscribeEvent({ type: EventTypes.MINI_PERFORMANCE, callback })).toBe(true);

    const data = { name: 'fcp', value: 100 };
    triggerHandlers(EventTypes.MINI_PERFORMANCE, data);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(data);
  });

  it('同一类型重复注册返回 false，且不会重复触发', () => {
    const first = vi.fn();
    const second = vi.fn();

    expect(subscribeEvent({ type: EventTypes.MINI_MEMORY_WARNING, callback: first })).toBe(true);
    expect(subscribeEvent({ type: EventTypes.MINI_MEMORY_WARNING, callback: second })).toBe(false);

    triggerHandlers(EventTypes.MINI_MEMORY_WARNING, { level: 10 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('handler 为空时返回 false，不抛错', () => {
    expect(subscribeEvent(undefined as any)).toBe(false);
  });
});

describe('triggerHandlers', () => {
  it('未注册的类型被触发时不抛错（拦截器先于订阅执行也不会炸）', () => {
    expect(() => triggerHandlers(EventTypes.MINI_BATTERY_INFO, { level: 1 })).not.toThrow();
  });

  it('回调抛错时不向调用方抛出，并通过 logger 记录（监控不能反过来打断业务）', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    let executed = false;

    subscribeEvent({
      type: EventTypes.MINI_NETWORK_STATUS_CHANGE,
      callback: () => {
        executed = true;
        throw new Error('callback boom');
      },
    });

    expect(() => triggerHandlers(EventTypes.MINI_NETWORK_STATUS_CHANGE, {})).not.toThrow();
    expect(executed).toBe(true);

    // nativeTryCatch 自己会先记一条，triggerHandlers 的兜底回调再记一条，所以这里只校验内容
    const messages = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.some((msg) => msg.includes('triggerHandlers'))).toBe(true);
    expect(messages.some((msg) => msg.includes('callback boom'))).toBe(true);
  });

  it('某个类型的回调抛错，不影响其它类型的回调', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const other = vi.fn();

    subscribeEvent({
      type: EventTypes.MINI_BATTERY_INFO,
      callback: () => {
        throw new Error('battery boom');
      },
    });
    subscribeEvent({ type: EventTypes.MONITOR, callback: other });

    expect(() => triggerHandlers(EventTypes.MINI_BATTERY_INFO, {})).not.toThrow();
    triggerHandlers(EventTypes.MONITOR, { msg: 'ok' });

    expect(other).toHaveBeenCalledWith({ msg: 'ok' });
  });
});
