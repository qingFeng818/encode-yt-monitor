import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HandleEvents } from '../../packages/browser/src/handleEvents';
import { breadcrumb, log, transportData } from 'encode-yt-monitor-core';
import { ErrorTypes } from 'encode-yt-monitor-shared';
import { extractErrorStack, unknownToString, Severity } from 'encode-yt-monitor-utils';
import { createScriptErrorEvent, createUnhandledRejectionEvent } from '../helpers/errorEvents';

/**
 * 错误采集的健壮性测试。
 *
 * 监控 SDK 自己绝不能成为新的错误源：当 Error.stack 不是字符串、
 * ErrorEvent.message 缺失、上报载荷出现循环引用 / Symbol / BigInt 时，
 * 格式化逻辑必须降级而不是抛错，否则原始错误会一起丢失。
 */

describe('unknownToString（上报字段序列化兜底）', () => {
  it('字符串原样返回', () => {
    expect(unknownToString('boom')).toBe('boom');
  });

  it('undefined 返回字面量 undefined', () => {
    expect(unknownToString(undefined)).toBe('undefined');
  });

  it('null / 对象 / 数组走 JSON 序列化', () => {
    expect(unknownToString(null)).toBe('null');
    expect(unknownToString({ code: 500, msg: 'fail' })).toBe('{"code":500,"msg":"fail"}');
    expect(unknownToString([1, 'a'])).toBe('[1,"a"]');
  });

  it('Symbol 不会被 JSON.stringify 吞成 undefined', () => {
    expect(unknownToString(Symbol('token'))).toBe('Symbol(token)');
  });

  it('函数转成可读的源码字符串', () => {
    expect(unknownToString(function namedFn() {})).toContain('namedFn');
  });

  it('BigInt 不会让 JSON.stringify 抛错', () => {
    expect(unknownToString(10n)).toBe('10');
  });

  it('循环引用对象不抛错，降级为 [object Object]', () => {
    const circular: any = { code: 1 };
    circular.self = circular;

    expect(() => unknownToString(circular)).not.toThrow();
    expect(unknownToString(circular)).toBe('[object Object]');
  });

  it('toJSON 抛错时继续降级，不把异常抛回事件回调', () => {
    const broken = {
      toJSON() {
        throw new Error('toJSON boom');
      },
    };
    expect(unknownToString(broken)).toBe('[object Object]');
  });

  it('既无法 JSON 序列化也无法 String 转换时用 toStringTag 兜底', () => {
    const hostile = {
      toJSON() {
        throw new Error('toJSON boom');
      },
      toString() {
        throw new Error('toString boom');
      },
      get [Symbol.toStringTag]() {
        return 'Hostile';
      },
    };
    expect(unknownToString(hostile)).toBe('[object Hostile]');
  });
});

describe('extractErrorStack（堆栈解析兜底）', () => {
  const makeError = (stack: unknown): any => {
    const err = new Error('boom');
    if (stack !== undefined) {
      Object.defineProperty(err, 'stack', { value: stack, configurable: true });
    }
    return err;
  };

  it('解析 Chrome / Blink 帧', () => {
    const err = makeError('Error: boom\n    at fn (http://localhost/app.js:10:5)');
    const result = extractErrorStack(err, Severity.Low) as any;

    expect(result).toMatchObject({ name: 'Error', message: 'boom', level: Severity.Low });
    expect(result.stack).toEqual([
      { url: 'http://localhost/app.js', func: 'fn', args: [], line: 10, column: 5 },
    ]);
  });

  it('native 帧的 url 为 null，原始内容保留在 args 里', () => {
    const err = makeError('Error: boom\n    at Array.forEach (native)');
    const result = extractErrorStack(err, Severity.Low) as any;

    expect(result.stack).toEqual([
      { url: null, func: 'Array.forEach', args: ['native'], line: null, column: null },
    ]);
  });

  it('解析 Gecko / Firefox 帧', () => {
    const err = makeError('fn@http://localhost/app.js:10:5');
    const result = extractErrorStack(err, Severity.Low) as any;

    expect(result.stack).toEqual([
      { url: 'http://localhost/app.js', func: 'fn', args: [], line: 10, column: 5 },
    ]);
  });

  it('Firefox 顶帧缺列号时用 columnNumber + 1（0-based → 1-based）', () => {
    const err = makeError('fn@http://localhost/app.js:10');
    err.columnNumber = 4;
    const result = extractErrorStack(err, Severity.Low) as any;

    expect(result.stack[0]).toMatchObject({ url: 'http://localhost/app.js', line: 10, column: 5 });
  });

  it('堆栈完全无法识别时返回 null（由调用方用 name / message 兜底）', () => {
    expect(extractErrorStack(makeError('no frames at all'), Severity.Low)).toBeNull();
  });

  it('stack 不是字符串时按无堆栈处理，仍返回基础字段', () => {
    const err = makeError({ frames: [] });
    const result = extractErrorStack(err, Severity.Low) as any;

    expect(result).toMatchObject({ name: 'Error', message: 'boom' });
    expect(result.stack).toBeUndefined();
  });

  it('空 stack / 缺失 stack 只返回基础字段', () => {
    const empty = makeError('');
    expect((extractErrorStack(empty, Severity.Low) as any).stack).toBeUndefined();

    const noStack = { name: 'CustomError', message: 'no stack' };
    const result = extractErrorStack(noStack, Severity.Low) as any;
    expect(result).toMatchObject({ name: 'CustomError', message: 'no stack' });
    expect(result.stack).toBeUndefined();
  });

  it('传入非对象（null / undefined）也不会抛错', () => {
    expect(() => extractErrorStack(null, Severity.Low)).not.toThrow();
    expect(() => extractErrorStack(undefined, Severity.Low)).not.toThrow();
    // `ex && ex.message` 对 null 得到 null，对 undefined 得到 undefined，均不会抛错
    expect((extractErrorStack(null, Severity.Low) as any).message).toBeNull();
    expect((extractErrorStack(undefined, Severity.Low) as any).message).toBeUndefined();
    expect((extractErrorStack(null, Severity.Low) as any).stack).toBeUndefined();
  });
});

describe('上报链路对异常输入的容错', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined as any);
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lastPayload = (): any => sendSpy.mock.calls[sendSpy.mock.calls.length - 1][0];

  it('Error.stack 为对象时仍按 name / message 上报，不会丢事件', () => {
    const err = new TypeError('x is not a function');
    Object.defineProperty(err, 'stack', { value: { frames: [] }, configurable: true });

    expect(() =>
      HandleEvents.handleError(
        createScriptErrorEvent({
          message: 'Uncaught TypeError: x is not a function',
          error: err,
        }),
      ),
    ).not.toThrow();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = lastPayload();
    expect(payload.type).toBe(ErrorTypes.JAVASCRIPT_ERROR);
    expect(payload.name).toBe('TypeError');
    expect(payload.message).toBe('x is not a function');
    expect(payload.stack).toBeUndefined();
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it('ErrorEvent.message 缺失时归一化为 undefined 字符串，不抛错', () => {
    const event = new Event('error') as ErrorEvent;
    Object.defineProperty(event, 'target', { value: window, enumerable: true });
    Object.defineProperty(event, 'message', { value: undefined, enumerable: true });

    expect(() => HandleEvents.handleError(event)).not.toThrow();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const payload = lastPayload();
    expect(payload.type).toBe(ErrorTypes.JAVASCRIPT_ERROR);
    expect(payload.name).toBe(ErrorTypes.UNKNOWN);
    expect(payload.message).toBe('undefined');
  });

  it('unhandledrejection 的堆栈无法解析时用 Error.name / message 兜底', () => {
    const err = new RangeError('invalid array length');
    err.stack = 'no frames at all';

    HandleEvents.handleUnhandleRejection(createUnhandledRejectionEvent(err));

    const payload = lastPayload();
    expect(payload.type).toBe(ErrorTypes.PROMISE_ERROR);
    expect(payload.name).toBe('RangeError');
    expect(payload.message).toBe('invalid array length');
    expect(payload.stack).toBeUndefined();
  });

  it('Symbol 作为 rejection reason 时仍能读出可读信息', () => {
    HandleEvents.handleUnhandleRejection(createUnhandledRejectionEvent(Symbol('token')));

    const payload = lastPayload();
    expect(payload.name).toBe('unhandledrejection');
    expect(payload.message).toBe('Symbol(token)');
  });

  it('循环引用对象作为 rejection reason 时不抛错', () => {
    const reason: any = { code: 1 };
    reason.self = reason;

    expect(() =>
      HandleEvents.handleUnhandleRejection(createUnhandledRejectionEvent(reason)),
    ).not.toThrow();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(lastPayload().message).toBe('[object Object]');
  });

  it('log 的 message 为循环引用对象时不抛错', () => {
    const message: any = { tag: 'circular' };
    message.self = message;

    expect(() => log({ message, tag: 'order' })).not.toThrow();

    const payload = lastPayload();
    expect(payload.type).toBe(ErrorTypes.LOG_ERROR);
    expect(payload.message).toBe('[object Object]');
    expect(payload.customTag).toBe('order');
  });

  it('log 传入 stack 非字符串的 Error 时仍能上报', () => {
    const err = new Error('broken stack');
    Object.defineProperty(err, 'stack', { value: [], configurable: true });

    expect(() => log({ message: '订单失败', ex: err })).not.toThrow();

    const payload = lastPayload();
    expect(payload.name).toBe('Error');
    expect(payload.message).toBe('broken stack');
    expect(payload.stack).toBeUndefined();
  });
});
