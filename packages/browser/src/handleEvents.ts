import { BreadCrumbTypes, ErrorTypes, ERROR_TYPE_RE, HttpTypes } from 'encode-yt-monitor-shared';
import {
  transportData,
  breadcrumb,
  resourceTransform,
  httpTransform,
  options,
} from 'encode-yt-monitor-core';
import {
  getLocationHref,
  getTimestamp,
  isError,
  parseUrlToObj,
  extractErrorStack,
  unknownToString,
  Severity,
  isHttpFail,
} from 'encode-yt-monitor-utils';
import { ReportDataType, Replace, MonitorHttp, ResourceErrorTarget } from 'encode-yt-monitor-types';

/** data.type（拦截层注入的 http 类型）-> 面包屑类型 */
const HTTP_TYPE_TO_BREADCRUMB: Record<string, BreadCrumbTypes> = {
  [HttpTypes.XHR]: BreadCrumbTypes.XHR,
  [HttpTypes.FETCH]: BreadCrumbTypes.FETCH,
};

const HandleEvents = {
  /**
   * 处理xhr、fetch回调
   * @param data 拦截层构造的请求数据
   * @param type 面包屑类型兜底值；正常情况下以 data.type 为准，避免两处来源写不一致
   */
  handleHttp(data: MonitorHttp, type?: BreadCrumbTypes): void {
    const isError = isHttpFail(Number(data.status));
    const result = httpTransform(data);
    // 面包屑类型以 data.type 为唯一来源，入参仅在 data.type 无法识别时兜底
    const breadcrumbType = HTTP_TYPE_TO_BREADCRUMB[data.type] || type;
    // 每个请求只记一条面包屑：成功 Info(http)，失败 Error(exception)，
    // 避免同一次失败占用两条 maxBreadcrumbs 名额且内容重复
    breadcrumb.push({
      type: breadcrumbType,
      category: breadcrumb.getCategory(isError ? BreadCrumbTypes.CODE_ERROR : breadcrumbType),
      data: { ...result },
      level: isError ? Severity.Error : Severity.Info,
      time: data.time,
    });
    if (isError) {
      transportData.send(result);
    }
  },
  /**
   * 处理window的error的监听回调
   */
  handleError(errorEvent: ErrorEvent) {
    const target = errorEvent.target as ResourceErrorTarget;
    // 通过localName判断是资源加载错误
    if (target.localName) {
      // 资源加载错误 提取有用数据
      const data = resourceTransform(errorEvent.target as ResourceErrorTarget);
      breadcrumb.push({
        type: BreadCrumbTypes.RESOURCE,
        category: breadcrumb.getCategory(BreadCrumbTypes.RESOURCE),
        data,
        level: Severity.Error,
      });
      return transportData.send(data);
    }
    // code error
    const { message, filename, lineno, colno, error } = errorEvent;
    let result: ReportDataType;
    if (error && isError(error)) {
      result = extractErrorStack(error, Severity.Normal);
    }
    // 处理SyntaxError，stack没有lineno、colno
    result || (result = HandleEvents.handleNotErrorInstance(message, filename, lineno, colno));
    result.type = ErrorTypes.JAVASCRIPT_ERROR;
    breadcrumb.push({
      type: BreadCrumbTypes.CODE_ERROR,
      category: breadcrumb.getCategory(BreadCrumbTypes.CODE_ERROR),
      data: { ...result },
      level: Severity.Error,
    });
    transportData.send(result);
  },

  handleNotErrorInstance(message: string, filename: string, lineno: number, colno: number) {
    let name: string | ErrorTypes = ErrorTypes.UNKNOWN;
    const url = filename || getLocationHref();
    // ErrorEvent.message 理论上一定是 string，但 polyfill / 自定义事件可能传 undefined，
    // 这里做一次归一化，避免 message.match 抛错导致错误没有被上报
    const rawMessage = typeof message === 'string' ? message : unknownToString(message);
    let msg = rawMessage;
    const matches = rawMessage.match(ERROR_TYPE_RE);
    if (matches && matches[1]) {
      name = matches[1];
      msg = matches[2];
    }
    const element = {
      url,
      func: ErrorTypes.UNKNOWN_FUNCTION,
      args: ErrorTypes.UNKNOWN,
      line: lineno,
      col: colno,
      column: colno,
    };
    return {
      url,
      name,
      message: msg,
      level: Severity.Normal,
      time: getTimestamp(),
      stack: [element],
    };
  },
  handleHistory(data: Replace.IRouter): void {
    const { from, to } = data;
    const { relative: parsedFrom } = parseUrlToObj(from);
    const { relative: parsedTo } = parseUrlToObj(to);
    breadcrumb.push({
      type: BreadCrumbTypes.ROUTE,
      category: breadcrumb.getCategory(BreadCrumbTypes.ROUTE),
      data: {
        from: parsedFrom ? parsedFrom : '/',
        to: parsedTo ? parsedTo : '/',
      },
      level: Severity.Info,
    });
    const { onRouteChange } = options;
    if (onRouteChange) {
      onRouteChange(from, to);
    }
  },
  handleHashchange(data: HashChangeEvent): void {
    const { oldURL, newURL } = data;
    const { relative: from } = parseUrlToObj(oldURL);
    const { relative: to } = parseUrlToObj(newURL);
    breadcrumb.push({
      type: BreadCrumbTypes.ROUTE,
      category: breadcrumb.getCategory(BreadCrumbTypes.ROUTE),
      data: {
        from,
        to,
      },
      level: Severity.Info,
    });
    const { onRouteChange } = options;
    if (onRouteChange) {
      onRouteChange(from, to);
    }
  },
  handleUnhandleRejection(ev: PromiseRejectionEvent): void {
    let data: ReportDataType = {
      type: ErrorTypes.PROMISE_ERROR,
      message: unknownToString(ev.reason),
      url: getLocationHref(),
      name: ev.type,
      time: getTimestamp(),
      level: Severity.Low,
    };
    if (isError(ev.reason)) {
      const parsedError = extractErrorStack(ev.reason, Severity.Low);
      data = {
        ...data,
        // 堆栈格式无法识别时 extractErrorStack 会返回 null，
        // 此时用 Error 自身的 name / message 兜底，避免上报成空对象字符串 {}
        ...(parsedError || {
          name: ev.reason.name || data.name,
          message: ev.reason.message || data.message,
        }),
      };
    }
    breadcrumb.push({
      type: BreadCrumbTypes.UNHANDLEDREJECTION,
      category: breadcrumb.getCategory(BreadCrumbTypes.UNHANDLEDREJECTION),
      data: { ...data },
      level: Severity.Error,
    });
    transportData.send(data);
  },
};

export { HandleEvents };
