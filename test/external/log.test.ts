import { describe, it, expect, beforeEach, vi } from 'vitest';
import { log, breadcrumb, transportData } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, ErrorTypes } from 'encode-yt-monitor-shared';
import { Severity } from 'encode-yt-monitor-utils';

describe('主动上报（Monitor.log → LOG_ERROR）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  it('默认参数应上报 LOG_ERROR 且 name 为 Monitor.log', () => {
    log({ message: '业务异常', tag: 'order' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0][0] as any;
    expect(payload.type).toBe(ErrorTypes.LOG_ERROR);
    expect(payload.name).toBe('Monitor.log');
    expect(payload.message).toBe('业务异常');
    expect(payload.customTag).toBe('order');
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: BreadCrumbTypes.CUSTOMER }),
    );
  });

  it('传入 Error 时应附加结构化堆栈', () => {
    const err = new RangeError('value out of range');
    log({ message: '参数越界', ex: err, level: Severity.Error });

    const payload = sendSpy.mock.calls[0][0] as any;
    expect(payload.type).toBe(ErrorTypes.LOG_ERROR);
    expect(payload.name).toBe('RangeError');
    expect(Array.isArray(payload.stack)).toBe(true);
    expect(payload.stack.length).toBeGreaterThan(0);
  });

  it('自定义 type 可覆盖默认 LOG_ERROR', () => {
    log({ message: '自定义事件', type: 'CUSTOM_EVENT' });
    const payload = sendSpy.mock.calls[0][0] as any;
    expect(payload.type).toBe('CUSTOM_EVENT');
  });
});
