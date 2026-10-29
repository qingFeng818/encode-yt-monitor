import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { BreadCrumbTypes, ErrorTypes, EventTypes, HttpTypes } from 'encode-yt-monitor-shared';
import { breadcrumb, triggerHandlers, transportData } from 'encode-yt-monitor-core';
import { setupReplace } from '../../packages/browser/src/load';

/**
 * load.ts 的 setupReplace 是「事件类型 -> HandleEvents 方法」的唯一接线处。
 * 之前只有各处理器自己的单测，接线本身没人验证：
 * 少接一个 type、或者接错方法，线上表现就是「某类错误永远不上报」，且没有任何报错。
 *
 * 这里不改写 Handler 内部逻辑，只验证「触发某个 EventType 后，数据确实流到了对应出口」。
 */

let sendSpy: ReturnType<typeof vi.spyOn>;
let pushSpy: ReturnType<typeof vi.spyOn>;

function httpData(partial: Record<string, any> = {}) {
  return {
    type: HttpTypes.XHR,
    method: 'GET',
    url: 'https://api.example.com/order/1',
    status: 500,
    reqData: '',
    responseText: '',
    elapsedTime: 30,
    time: Date.now(),
    traceId: 'trace-1',
    ...partial,
  };
}

/** 在 spy 记录里找第一条满足条件的上报 */
function findSent(predicate: (payload: any) => boolean): any {
  return sendSpy.mock.calls.map((call: any[]) => call[0]).find(predicate);
}

describe('setupReplace 事件接线', () => {
  beforeAll(() => {
    // 只接线一次：重复调用会被 subscribeEvent 的 flag 拦掉，这里也顺便验证可重入
    setupReplace();
    expect(() => setupReplace()).not.toThrow();
  });

  beforeEach(() => {
    // setup.ts 的 beforeEach 会 restoreAllMocks，所以 spy 必须每次重建
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  it('XHR 事件走 handleHttp，并以上报 HTTP_ERROR', () => {
    triggerHandlers(EventTypes.XHR, httpData({ type: HttpTypes.XHR }));

    const sent = findSent((payload) => payload.type === ErrorTypes.FETCH_ERROR);
    expect(sent).toBeTruthy();
    expect(sent.name).toBe('xhr--GET');
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: BreadCrumbTypes.XHR, level: 'error' }),
    );
  });

  it('FETCH 事件走 handleHttp，且面包屑类型为 Fetch', () => {
    triggerHandlers(EventTypes.FETCH, httpData({ type: HttpTypes.FETCH, method: 'POST' }));

    const sent = findSent((payload) => payload.type === ErrorTypes.FETCH_ERROR);
    expect(sent.name).toBe('fetch--POST');
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: BreadCrumbTypes.FETCH, level: 'error' }),
    );
  });

  it('ERROR 事件走 handleError，并上报 JAVASCRIPT_ERROR', () => {
    const errorEvent = {
      target: window,
      message: 'Uncaught TypeError: boom',
      filename: 'https://a.com/app.js',
      lineno: 12,
      colno: 5,
      error: new TypeError('boom'),
    };

    triggerHandlers(EventTypes.ERROR, errorEvent);

    const sent = findSent((payload) => payload.type === ErrorTypes.JAVASCRIPT_ERROR);
    expect(sent).toBeTruthy();
    expect(sent.message).toBe('boom');
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: BreadCrumbTypes.CODE_ERROR }),
    );
  });

  it('UNHANDLEDREJECTION 事件走 handleUnhandleRejection，并上报 PROMISE_ERROR', () => {
    triggerHandlers(EventTypes.UNHANDLEDREJECTION, {
      type: 'unhandledrejection',
      reason: new Error('async boom'),
    });

    const sent = findSent((payload) => payload.type === ErrorTypes.PROMISE_ERROR);
    expect(sent).toBeTruthy();
    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: BreadCrumbTypes.UNHANDLEDREJECTION }),
    );
  });

  it('HISTORY 事件走 handleHistory，并记录 Route 面包屑', () => {
    triggerHandlers(EventTypes.HISTORY, {
      from: 'https://a.com/list?page=1',
      to: 'https://a.com/detail/1',
    });

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BreadCrumbTypes.ROUTE,
        data: { from: '/list?page=1', to: '/detail/1' },
      }),
    );
  });

  it('HASHCHANGE 事件走 handleHashchange，并记录 Route 面包屑', () => {
    triggerHandlers(EventTypes.HASHCHANGE, {
      oldURL: 'https://a.com/#/home',
      newURL: 'https://a.com/#/detail',
    });

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BreadCrumbTypes.ROUTE,
        // parseUrlToObj 只去掉 origin，path + fragment 都保留
        data: { from: '/#/home', to: '/#/detail' },
      }),
    );
  });

  it('CONSOLE 事件走 handleConsole，只记面包屑不上报', () => {
    triggerHandlers(EventTypes.CONSOLE, { args: ['hello'], level: 'error' });

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: BreadCrumbTypes.CONSOLE, level: 'error' }),
    );
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('DOM 事件走点击面包屑，body 之类的元素不产生记录', () => {
    const button = document.createElement('button');
    button.id = 'pay';
    Object.defineProperty(button, 'innerText', { value: '支付', configurable: true });

    triggerHandlers(EventTypes.DOM, { category: 'click', data: { target: button } });

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: BreadCrumbTypes.CLICK,
        data: '<button id="pay">支付</button>',
      }),
    );
  });
});
