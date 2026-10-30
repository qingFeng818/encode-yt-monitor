import {
  _global,
  on,
  getTimestamp,
  replaceOld,
  throttle,
  getLocationHref,
  isExistProperty,
  variableTypeDetection,
  supportsHistory,
  isHttpFail,
  logger,
} from 'encode-yt-monitor-utils';
import {
  transportData,
  options,
  setTraceId,
  triggerHandlers,
  ReplaceHandler,
  subscribeEvent,
} from 'encode-yt-monitor-core';
import { EMethods, MonitorHttp, MonitorXMLHttpRequest } from 'encode-yt-monitor-types';
import { voidFun, EventTypes, HttpTypes } from 'encode-yt-monitor-shared';

function isFilterHttpUrl(url: string) {
  return options.filterXhrUrlRegExp && options.filterXhrUrlRegExp.test(url);
}

function replace(type: EventTypes) {
  switch (type) {
    case EventTypes.XHR:
      xhrReplace();
      break;
    case EventTypes.FETCH:
      fetchReplace();
      break;
    case EventTypes.ERROR:
      listenError();
      break;
    case EventTypes.UNHANDLEDREJECTION:
      unhandledrejectionReplace();
      break;
    case EventTypes.CONSOLE:
      consoleReplace();
      break;
    case EventTypes.HISTORY:
      historyReplace();
      break;
    case EventTypes.HASHCHANGE:
      listenHashchange();
      break;
    case EventTypes.DOM:
      domReplace();
      break;

    default:
      break;
  }
}

export function addReplaceHandler(handler: ReplaceHandler) {
  if (!subscribeEvent(handler)) return;
  replace(handler.type as EventTypes);
}

function xhrReplace(): void {
  if (!('XMLHttpRequest' in _global)) {
    return;
  }
  const originalXhrProto = XMLHttpRequest.prototype;
  replaceOld(originalXhrProto, 'open', (originalOpen: voidFun): voidFun => {
    return function (this: MonitorXMLHttpRequest, ...args: any[]): void {
      // xhr.open 的第二个参数允许是 URL 对象：统一归一化成字符串，
      // 否则后续 getRealPath / isSdkTransportUrl 拿到对象会直接抛 TypeError（上报丢失）
      const rawUrl = args[1];
      this.monitor_xhr = {
        method: variableTypeDetection.isString(args[0]) ? args[0].toUpperCase() : args[0],
        url: variableTypeDetection.isString(rawUrl) ? rawUrl : String(rawUrl ?? ''),
        sTime: getTimestamp(),
        type: HttpTypes.XHR,
      };
      // this.ontimeout = function () {
      //   console.log('超时', this)
      // }
      // this.timeout = 10000
      // on(this, EventTypes.ERROR, function (this: MonitorXMLHttpRequest) {
      //   if (this.monitor_xhr.isSdkUrl) return
      //   this.monitor_xhr.isError = true
      //   const eTime = getTimestamp()
      //   this.monitor_xhr.time = eTime
      //   this.monitor_xhr.status = this.status
      //   this.monitor_xhr.elapsedTime = eTime - this.monitor_xhr.sTime
      //   triggerHandlers(EventTypes.XHR, this.monitor_xhr)
      //   logger.error(`接口错误,接口信息:${JSON.stringify(this.monitor_xhr)}`)
      // })
      originalOpen.apply(this, args);
    };
  });
  replaceOld(originalXhrProto, 'send', (originalSend: voidFun): voidFun => {
    return function (this: MonitorXMLHttpRequest, ...args: any[]): void {
      // SDK 初始化前就创建并发起过 open 的实例没有 monitor_xhr 元数据，
      // 这里直接透传，避免因为埋点信息缺失把业务请求打断
      if (!this.monitor_xhr) {
        originalSend.apply(this, args);
        return;
      }
      const { method, url } = this.monitor_xhr;
      // traceId 注入与业务钩子都是旁路逻辑：一旦抛错必须被兜住，
      // 否则异常会从 send 抛给业务代码，导致这次请求根本发不出去
      try {
        setTraceId(url, (headerFieldName: string, traceId: string) => {
          this.monitor_xhr.traceId = traceId;
          this.setRequestHeader(headerFieldName, traceId);
        });
        options.beforeAppAjaxSend && options.beforeAppAjaxSend({ method, url }, this);
      } catch (error) {
        logger.error('beforeAppAjaxSend / setTraceId 执行失败，已跳过本次请求头注入：', error);
      }
      on(
        this,
        'abort',
        function (this: MonitorXMLHttpRequest) {
          this.monitor_xhr && (this.monitor_xhr.isAbort = true);
        },
        { once: true },
      );
      on(
        this,
        'loadend',
        function (this: MonitorXMLHttpRequest) {
          if (!this.monitor_xhr || this.monitor_xhr.isAbort) return;
          if (
            (method === EMethods.Post && transportData.isSdkTransportUrl(url)) ||
            isFilterHttpUrl(url)
          )
            return;
          const { responseType, response, status } = this;
          this.monitor_xhr.reqData = args[0];
          const eTime = getTimestamp();
          this.monitor_xhr.time = this.monitor_xhr.sTime;
          this.monitor_xhr.status = status;
          // 仅失败请求记录响应体，与 fetch 拦截保持一致，
          // 避免成功请求把大 body 写进面包屑（面包屑会随每次上报一起发送）
          if (isHttpFail(status) && ['', 'json', 'text'].indexOf(responseType) !== -1) {
            this.monitor_xhr.responseText =
              typeof response === 'object' ? JSON.stringify(response) : response;
          }
          this.monitor_xhr.elapsedTime = eTime - this.monitor_xhr.sTime;
          triggerHandlers(EventTypes.XHR, this.monitor_xhr);
        },
        { once: true },
      );
      originalSend.apply(this, args);
    };
  });
}

function fetchReplace(): void {
  if (!('fetch' in _global)) {
    return;
  }
  replaceOld(_global, EventTypes.FETCH, (originalFetch: voidFun) => {
    return function (url: string, config: Partial<Request> = {}): void {
      const sTime = getTimestamp();
      // fetch 的第一个参数同样允许是 Request 对象，先取出真实的 url / method，
      // 避免把对象当成字符串 url 上报（getRealPath 会直接抛错，导致该错误丢失）
      const request = url !== null && typeof url === 'object' ? (url as any) : null;
      const finalUrl: string =
        request && typeof request.url === 'string' ? request.url : (url as unknown as string);
      // 统一大写，保证 xhr/fetch 生成的 name（`${type}--${method}`）与去重指纹一致（XHR 侧已 toUpperCase）
      const method = String(
        (config && config.method) || (request && request.method) || 'GET',
      ).toUpperCase();
      let handlerData: MonitorHttp = {
        type: HttpTypes.FETCH,
        method,
        reqData: (config && config.body) || (request && request.body),
        url: finalUrl,
      };
      const headers = new Headers(config.headers || {});
      Object.assign(headers, {
        setRequestHeader: headers.set,
      });
      // 与 XHR 侧一致：注入失败（业务钩子抛错 / header 非法）不能影响业务请求本身
      try {
        setTraceId(finalUrl, (headerFieldName: string, traceId: string) => {
          handlerData.traceId = traceId;
          headers.set(headerFieldName, traceId);
        });
        options.beforeAppAjaxSend && options.beforeAppAjaxSend({ method, url: finalUrl }, headers);
      } catch (error) {
        logger.error('beforeAppAjaxSend / setTraceId 执行失败，已跳过本次请求头注入：', error);
      }
      config = {
        ...config,
        headers,
      };

      return originalFetch.apply(_global, [url, config]).then(
        (res: Response) => {
          const tempRes = res.clone();
          const eTime = getTimestamp();
          handlerData = {
            ...handlerData,
            elapsedTime: eTime - sTime,
            status: tempRes.status,
            // statusText: tempRes.statusText,
            time: sTime,
          };
          tempRes
            .text()
            .then((data) => {
              if (method === EMethods.Post && transportData.isSdkTransportUrl(finalUrl)) return;
              if (isFilterHttpUrl(finalUrl)) return;
              // 仅失败请求记录响应体；范围与 handleHttp 的 isError 判定保持一致
              handlerData.responseText = isHttpFail(tempRes.status) ? data : '';
              triggerHandlers(EventTypes.FETCH, handlerData);
            })
            .catch(() => {
              // body 读取失败（如响应流被 abort、body 已被消费）时，
              // 不带 responseText 继续上报，避免丢事件；同时兜住 promise 防止
              // 这里产生的 unhandledrejection 被 SDK 自身采集
              if (method === EMethods.Post && transportData.isSdkTransportUrl(finalUrl)) return;
              if (isFilterHttpUrl(finalUrl)) return;
              triggerHandlers(EventTypes.FETCH, handlerData);
            });
          return res;
        },
        (err: Error) => {
          // AbortController 主动取消：DOMException 的 name 固定为 'AbortError'，
          // 属于正常业务行为（搜索防抖、页面跳转等），不上报、不记面包屑，
          // 但必须继续抛出，保证业务自身的 catch 能收到取消信号
          if (err && err.name === 'AbortError') {
            throw err;
          }
          const eTime = getTimestamp();
          if (method === EMethods.Post && transportData.isSdkTransportUrl(finalUrl)) return;
          if (isFilterHttpUrl(finalUrl)) return;
          handlerData = {
            ...handlerData,
            elapsedTime: eTime - sTime,
            status: 0,
            // statusText: err.name + err.message,
            time: sTime,
          };
          triggerHandlers(EventTypes.FETCH, handlerData);
          throw err;
        },
      );
    };
  });
}

function listenHashchange(): void {
  if (!isExistProperty(_global, 'onpopstate')) {
    on(_global, EventTypes.HASHCHANGE, function (e: HashChangeEvent) {
      triggerHandlers(EventTypes.HASHCHANGE, e);
    });
  }
}

function listenError(): void {
  on(
    _global,
    'error',
    function (e: ErrorEvent) {
      triggerHandlers(EventTypes.ERROR, e);
    },
    true,
  );
}

function consoleReplace(): void {
  if (!('console' in _global)) {
    return;
  }
  const logType = ['log', 'debug', 'info', 'warn', 'error', 'assert'];
  logType.forEach(function (level: string): void {
    if (!(level in _global.console)) return;
    replaceOld(_global.console, level, function (originalConsole: () => any): Function {
      return function (...args: any[]): void {
        if (originalConsole) {
          triggerHandlers(EventTypes.CONSOLE, { args, level });
          originalConsole.apply(_global.console, args);
        }
      };
    });
  });
}
// last time route
let lastHref: string;
lastHref = getLocationHref();
function historyReplace(): void {
  if (!supportsHistory()) return;
  const oldOnpopstate = _global.onpopstate;

  _global.onpopstate = function (this: WindowEventHandlers, ...args: any[]): any {
    console.log('poppopstate', args);
    const to = getLocationHref();
    const from = lastHref;
    lastHref = to;
    triggerHandlers(EventTypes.HISTORY, {
      from,
      to,
    });
    oldOnpopstate && oldOnpopstate.apply(this, args);
  };
  function historyReplaceFn(originalHistoryFn: voidFun): voidFun {
    return function (this: History, ...args: any[]): void {
      const url = args.length > 2 ? args[2] : undefined;
      if (url) {
        const from = lastHref;
        const to = String(url);
        lastHref = to;
        triggerHandlers(EventTypes.HISTORY, {
          from,
          to,
        });
      }
      return originalHistoryFn.apply(this, args);
    };
  }
  replaceOld(_global.history, 'pushState', historyReplaceFn);
  replaceOld(_global.history, 'replaceState', historyReplaceFn);
}

function unhandledrejectionReplace(): void {
  on(_global, EventTypes.UNHANDLEDREJECTION, function (ev: PromiseRejectionEvent) {
    // ev.preventDefault() 阻止默认行为后，控制台就不会再报红色错误
    triggerHandlers(EventTypes.UNHANDLEDREJECTION, ev);
  });
}

function domReplace(): void {
  if (!('document' in _global)) return;
  const clickThrottle = throttle(triggerHandlers, options.throttleDelayTime);
  on(
    _global.document,
    'click',
    function (e: MouseEvent) {
      clickThrottle(EventTypes.DOM, {
        category: 'click',
        data: e,
      });
    },
    true,
  );
  // 暂时不需要keypress的重写
  // on(
  //   _global.document,
  //   'keypress',
  //   function (e: MonitorElement) {
  //     keypressThrottle('dom', {
  //       category: 'keypress',
  //       data: this
  //     })
  //   },
  //   true
  // )
}
