import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { addReplaceHandler } from '../../packages/browser/src/replace';
import { HandleEvents } from '../../packages/browser/src/handleEvents';
import { breadcrumb, transportData, options } from 'encode-yt-monitor-core';
import { SpanStatus } from 'encode-yt-monitor-utils';
import {
  BreadCrumbCategory,
  BreadCrumbTypes,
  ErrorTypes,
  EventTypes,
  HttpTypes,
} from 'encode-yt-monitor-shared';
import type { MonitorHttp } from 'encode-yt-monitor-types';

/**
 * replace.ts 的 XHR / fetch 拦截层集成测试。
 *
 * 注意 replace 会永久改写全局对象（XMLHttpRequest.prototype / window.fetch），重复注册还会重复包装，
 * 因此这里：
 *  - 在 beforeAll 中先安装「可控桩」，再注册拦截器，保证每个被测对象只被改写一次；
 *  - 每个用例只创建新的请求实例 / 重设 fetch 桩实现，互不污染。
 */

type Listener = (this: any, ...args: any[]) => void;

class StubXHR {
  listeners: Record<string, Listener[]> = {};
  requestHeaders: Array<[string, string]> = [];
  status = 0;
  response: any = null;
  responseType = '';
  sentBody: any = undefined;

  open(_method: string, _url: string): void {}

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders.push([name, value]);
  }

  addEventListener(name: string, fn: Listener): void {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  }

  send(body?: any): void {
    this.sentBody = body;
  }

  emit(name: string): void {
    (this.listeners[name] || []).forEach((fn) => fn.call(this));
  }

  /** 模拟业务请求结束（loadend） */
  finish(options: { status: number; response?: any; responseType?: string }): void {
    this.status = options.status;
    this.response = options.response ?? null;
    this.responseType = options.responseType ?? '';
    this.emit('loadend');
  }
}

function makeResponse(status: number, body: string): Response {
  return {
    status,
    clone: () => makeResponse(status, body),
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function makeResponseWithBrokenBody(status: number): Response {
  return {
    status,
    clone: () => makeResponseWithBrokenBody(status),
    text: () => Promise.reject(new Error('body stream already consumed')),
  } as unknown as Response;
}

/** fetch 桩的实现，用例内可替换 */
let fetchHandler: (url: string, config: any) => Promise<Response>;

const doFetch = (url: string, config?: any): Promise<any> => (window as any).fetch(url, config);
/** 等待 fetch 拦截器内部未 await 的 .text().then(...) 链执行完毕 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function payloadOf(spy: ReturnType<typeof vi.spyOn>, n = 0): any {
  return spy.mock.calls[n][0];
}

function pushedOf(spy: ReturnType<typeof vi.spyOn>, n = 0): any {
  return spy.mock.calls[n][0];
}

const originalXHR = (globalThis as any).XMLHttpRequest;
const originalFetch = (window as any).fetch;

beforeAll(() => {
  // jsdom 不实现 fetch 相关 API，缺失时补一个最小 Headers
  if (typeof (globalThis as any).Headers === 'undefined') {
    (globalThis as any).Headers = class Headers {
      private map: Record<string, string> = {};
      constructor(init: Record<string, string> = {}) {
        Object.keys(init || {}).forEach((key) => this.set(key, (init as any)[key]));
      }
      set(name: string, value: string): void {
        this.map[name] = value;
      }
      get(name: string): string | undefined {
        return this.map[name];
      }
    };
  }

  (globalThis as any).XMLHttpRequest = StubXHR;
  (window as any).XMLHttpRequest = StubXHR;
  fetchHandler = async () => makeResponse(200, '');
  const stubFetch = (url: string, config: any) => fetchHandler(url, config);
  (globalThis as any).fetch = stubFetch;
  (window as any).fetch = stubFetch;

  // 与 load.ts 的注册方式保持一致，但只注册 http 相关，缩小影响面
  addReplaceHandler({
    type: EventTypes.XHR,
    callback: (data: MonitorHttp) => HandleEvents.handleHttp(data, BreadCrumbTypes.XHR),
  });
  addReplaceHandler({
    type: EventTypes.FETCH,
    callback: (data: MonitorHttp) => HandleEvents.handleHttp(data, BreadCrumbTypes.FETCH),
  });
});

afterAll(() => {
  (globalThis as any).XMLHttpRequest = originalXHR;
  (window as any).XMLHttpRequest = originalXHR;
  (globalThis as any).fetch = originalFetch;
  (window as any).fetch = originalFetch;
});

describe('HTTP 拦截层（replace.ts / XHR + fetch）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  describe('XHR', () => {
    it('失败请求：上报 FETCH_ERROR，携带请求体与响应体，method 统一大写', () => {
      const xhr: any = new StubXHR();
      xhr.open('post', 'https://api.example.com/order/123');
      xhr.send('{"id":1}');
      xhr.finish({ status: 500, response: '{"error":"db down"}', responseType: 'json' });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = payloadOf(sendSpy);
      expect(payload.type).toBe(ErrorTypes.FETCH_ERROR);
      expect(payload.name).toBe('xhr--POST');
      expect(payload.request.method).toBe('POST');
      expect(payload.request.httpType).toBe(HttpTypes.XHR);
      expect(payload.request.url).toBe('https://api.example.com/order/123');
      expect(payload.request.data).toBe('{"id":1}');
      expect(payload.response.status).toBe(500);
      expect(payload.response.data).toBe('{"error":"db down"}');
      // message 使用 SpanStatus 枚举 + 归一化后的接口地址（message 文案由 fromHttpStatus 决定）
      expect(payload.message).toBe('internal_error https://api.example.com/order{param}');
      // 请求体确实透传给了原始 send
      expect(xhr.sentBody).toBe('{"id":1}');

      // 失败只记一条 Error(exception) 面包屑
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushedOf(pushSpy)).toMatchObject({
        type: BreadCrumbTypes.XHR,
        category: BreadCrumbCategory.EXCEPTION,
        level: 'error',
      });
    });

    it('成功请求：不上报，且不再把响应体写进面包屑（大 body 保护）', () => {
      const xhr: any = new StubXHR();
      xhr.open('GET', 'https://api.example.com/user/list');
      xhr.send();
      xhr.finish({ status: 200, response: 'x'.repeat(5000), responseType: 'text' });

      expect(sendSpy).not.toHaveBeenCalled();
      expect(pushSpy).toHaveBeenCalledTimes(1);
      const pushed = pushedOf(pushSpy);
      expect(pushed).toMatchObject({
        type: BreadCrumbTypes.XHR,
        category: BreadCrumbCategory.HTTP,
        level: 'info',
      });
      // 与 fetch 侧行为对齐：成功请求不记录响应体
      expect(pushed.data.response.data).toBe('');
      expect(pushed.data.request.data).toBe('');
    });

    it('网络层失败（status 为 0）：上报并给出跨域/超时原因', () => {
      const xhr: any = new StubXHR();
      xhr.open('GET', 'https://api.example.com/user/list');
      xhr.send();
      xhr.finish({ status: 0, responseType: 'text' });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = payloadOf(sendSpy);
      expect(payload.response.status).toBe(0);
      expect(payload.message).toContain('跨域');
      expect(payload.elapsedTime).toEqual(expect.any(Number));
    });

    it('abort：静默丢弃，不上报也不记面包屑', () => {
      const xhr: any = new StubXHR();
      xhr.open('GET', 'https://api.example.com/user/list');
      xhr.send();
      xhr.emit('abort');
      xhr.finish({ status: 0, responseType: 'text' });

      expect(sendSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('responseType 为 blob 等非文本类型：即使失败也不记录响应体', () => {
      const xhr: any = new StubXHR();
      xhr.open('GET', 'https://api.example.com/file');
      xhr.send();
      xhr.finish({ status: 500, response: { size: 10 }, responseType: 'blob' });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(payloadOf(sendSpy).response.data).toBe('');
    });

    it('命中 filterXhrUrlRegExp 的请求被忽略', () => {
      (options as any).filterXhrUrlRegExp = /filter-me/;
      try {
        const xhr: any = new StubXHR();
        xhr.open('GET', 'https://api.example.com/filter-me/list');
        xhr.send();
        xhr.finish({ status: 500, response: 'boom', responseType: 'text' });

        expect(sendSpy).not.toHaveBeenCalled();
        expect(pushSpy).not.toHaveBeenCalled();
      } finally {
        (options as any).filterXhrUrlRegExp = undefined;
      }
    });

    it('POST 到 SDK 自身上报地址的请求被忽略（避免自监控死循环）', () => {
      const originalDsn = transportData.errorDsn;
      transportData.errorDsn = 'https://dsn.example.com';
      try {
        const xhr: any = new StubXHR();
        xhr.open('POST', 'https://dsn.example.com/api/report');
        xhr.send('{}');
        xhr.finish({ status: 500, response: 'boom', responseType: 'text' });

        expect(sendSpy).not.toHaveBeenCalled();
        expect(pushSpy).not.toHaveBeenCalled();
      } finally {
        transportData.errorDsn = originalDsn;
      }
    });

    it('enableTraceId 命中时注入 Trace-Id 请求头并透传到上报数据', () => {
      (options as any).enableTraceId = true;
      (options as any).includeHttpUrlTraceIdRegExp = /api\.example\.com/;
      try {
        const xhr: any = new StubXHR();
        xhr.open('GET', 'https://api.example.com/user/list');
        xhr.send();
        xhr.finish({ status: 500, response: 'boom', responseType: 'text' });

        expect(xhr.requestHeaders.some(([name]) => name === options.traceIdFieldName)).toBe(true);
        expect(payloadOf(sendSpy).request.traceId).toEqual(expect.any(String));
      } finally {
        (options as any).enableTraceId = false;
        (options as any).includeHttpUrlTraceIdRegExp = undefined;
      }
    });
  });

  describe('fetch', () => {
    it('失败请求：上报 FETCH_ERROR，响应体取失败响应的文本', async () => {
      fetchHandler = async () => makeResponse(500, '{"error":"boom"}');
      await doFetch('https://api.example.com/order/123', { method: 'post', body: '{"id":1}' });
      await flush();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = payloadOf(sendSpy);
      expect(payload.type).toBe(ErrorTypes.FETCH_ERROR);
      expect(payload.name).toBe('fetch--POST');
      expect(payload.request.method).toBe('POST');
      expect(payload.request.httpType).toBe(HttpTypes.FETCH);
      expect(payload.request.data).toBe('{"id":1}');
      expect(payload.response.status).toBe(500);
      expect(payload.response.data).toBe('{"error":"boom"}');
      expect(payload.message).toContain(SpanStatus.InternalError);
    });

    it('method 缺省时按 GET 处理，大小写与 XHR 统一', async () => {
      fetchHandler = async () => makeResponse(500, 'boom');
      await doFetch('https://api.example.com/user/list');
      await flush();
      expect(payloadOf(sendSpy).name).toBe('fetch--GET');
    });

    it('成功请求：不上报，响应体记为「」', async () => {
      fetchHandler = async () => makeResponse(200, '{"ok":true}');
      await doFetch('https://api.example.com/user/list');
      await flush();

      expect(sendSpy).not.toHaveBeenCalled();
      expect(pushSpy).toHaveBeenCalledTimes(1);
      const pushed = pushedOf(pushSpy);
      expect(pushed).toMatchObject({
        type: BreadCrumbTypes.FETCH,
        category: BreadCrumbCategory.HTTP,
        level: 'info',
      });
      expect(pushed.data.response.data).toBe('');
    });

    it('网络异常：status 置 0 后上报，并把异常继续抛给业务侧', async () => {
      fetchHandler = async () => {
        throw new TypeError('Failed to fetch');
      };
      await expect(doFetch('https://api.example.com/user/list')).rejects.toThrow('Failed to fetch');
      await flush();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = payloadOf(sendSpy);
      expect(payload.response.status).toBe(0);
      expect(payload.message).toContain('跨域');
    });

    it('AbortError（主动取消）：静默不上报，异常仍继续抛出', async () => {
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      fetchHandler = async () => {
        throw abortError;
      };
      await expect(doFetch('https://api.example.com/user/list')).rejects.toThrow(
        'The operation was aborted.',
      );
      await flush();

      expect(sendSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
    });

    it('body 读取失败时仍上报事件，只是不带响应体', async () => {
      fetchHandler = async () => makeResponseWithBrokenBody(500);
      await doFetch('https://api.example.com/user/list');
      await flush();

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(payloadOf(sendSpy).response.status).toBe(500);
      expect(payloadOf(sendSpy).response.data).toBe('');
    });

    it('命中 filterXhrUrlRegExp 的请求被忽略', async () => {
      (options as any).filterXhrUrlRegExp = /filter-me/;
      try {
        fetchHandler = async () => makeResponse(500, 'boom');
        await doFetch('https://api.example.com/filter-me/list');
        await flush();
        expect(sendSpy).not.toHaveBeenCalled();
        expect(pushSpy).not.toHaveBeenCalled();
      } finally {
        (options as any).filterXhrUrlRegExp = undefined;
      }
    });
  });
});
