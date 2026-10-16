import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HandleEvents } from '../../packages/browser/src/handleEvents';
import { breadcrumb, transportData } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, ErrorTypes } from 'encode-yt-monitor-shared';
import { createUnhandledRejectionEvent } from '../helpers/errorEvents';

describe('未捕获 Promise 错误（PROMISE_ERROR）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  it('reason 为 Error 实例时应上报并携带结构化堆栈', () => {
    const err = new TypeError('cannot read of undefined');
    HandleEvents.handleUnhandleRejection(createUnhandledRejectionEvent(err));

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = sendSpy.mock.calls[0][0] as any;
    expect(payload.type).toBe(ErrorTypes.PROMISE_ERROR);
    expect(payload.name).toBe('TypeError');
    expect(payload.message).toBe('cannot read of undefined');
    expect(Array.isArray(payload.stack)).toBe(true);
    expect(payload.stack.length).toBeGreaterThan(0);
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: BreadCrumbTypes.UNHANDLEDREJECTION }),
    );
  });

  it('reason 为字符串时应走 unknownToString，name 固定为 unhandledrejection', () => {
    HandleEvents.handleUnhandleRejection(createUnhandledRejectionEvent('async boom'));

    const payload = sendSpy.mock.calls[0][0] as any;
    expect(payload.type).toBe(ErrorTypes.PROMISE_ERROR);
    expect(payload.name).toBe('unhandledrejection');
    expect(payload.message).toBe('async boom');
    // 非 Error 没有结构化栈
    expect(payload.stack).toBeUndefined();
  });

  it('reason 为普通对象时应序列化上报', () => {
    HandleEvents.handleUnhandleRejection(createUnhandledRejectionEvent({ code: 500, msg: 'fail' }));

    const payload = sendSpy.mock.calls[0][0] as any;
    expect(payload.type).toBe(ErrorTypes.PROMISE_ERROR);
    expect(payload.message).toContain('code');
  });
});
