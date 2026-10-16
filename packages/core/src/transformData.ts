import { BreadCrumbTypes, ErrorTypes, globalVar } from 'encode-yt-monitor-shared';
import {
  getLocationHref,
  getTimestamp,
  Severity,
  fromHttpStatus,
  interceptStr,
  nativeToString,
  variableTypeDetection,
} from 'encode-yt-monitor-utils';
import { ReportDataType, MonitorHttp, Replace, ResourceErrorTarget } from 'encode-yt-monitor-types';
import { getRealPath } from './errorId';
import { breadcrumb } from './breadcrumb';

/** 请求体 / 响应体上报的最大长度，避免大 body 撑爆面包屑与上报载荷 */
export const HTTP_BODY_MAX_LENGTH = 1000;

/**
 * 把任意类型的请求体/响应体转成可上报的字符串：
 * - undefined / null -> ''
 * - 字符串 -> 原样（超长截断）
 * - 其它 -> JSON.stringify；FormData / Blob 等 JSON 化后为空对象的类型退化为类型描述
 * 统一做截断，避免 XHR 把 FormData「序列化」成 {} 或把大 body 原样塞进上报载荷。
 */
export function formatHttpBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  if (variableTypeDetection.isString(body)) {
    return interceptStr(body as string, HTTP_BODY_MAX_LENGTH);
  }
  try {
    const json = JSON.stringify(body);
    if (json === '{}' && nativeToString.call(body) !== '[object Object]') {
      // 无法 JSON 化的对象（如 FormData）会得到 '{}'，退化为 '[object FormData]' 便于定位
      return interceptStr(nativeToString.call(body), HTTP_BODY_MAX_LENGTH);
    }
    return json === undefined ? '' : interceptStr(json, HTTP_BODY_MAX_LENGTH);
  } catch (error) {
    return interceptStr(nativeToString.call(body), HTTP_BODY_MAX_LENGTH);
  }
}

export function httpTransform(data: MonitorHttp): ReportDataType {
  let message = '';
  const { elapsedTime, time, method, traceId, type } = data;
  // 状态码在此统一做类型归一化：避免 handleHttp 用 isHttpFail(Number(status))、
  // 而这里用 status === 0 严格比较时对字符串型 status（如 '0'）判断不一致
  const status = Number(data.status);
  const name = `${type}--${method}`;
  if (status === 0) {
    // 网络层失败：耗时小于阈值（默认 1000ms）判定为快速失败（跨域限制/域名不存在），否则判定为超时
    message =
      Number(elapsedTime) < globalVar.crossOriginThreshold
        ? 'http请求失败，失败原因：跨域限制或域名不存在'
        : 'http请求失败，失败原因：超时';
  } else {
    message = fromHttpStatus(status);
  }
  const realPath = data.url ? getRealPath(data.url) : '';
  if (realPath) message = `${message} ${realPath}`;
  return {
    type: ErrorTypes.FETCH_ERROR,
    url: getLocationHref(),
    time,
    elapsedTime,
    level: Severity.Low,
    message,
    name,
    request: {
      httpType: type,
      traceId,
      method,
      url: data.url,
      data: formatHttpBody(data.reqData),
    },
    response: {
      status,
      data: formatHttpBody(data.responseText),
    },
  };
}

const resourceMap = {
  img: '图片',
  script: 'js脚本',
};

export function resourceTransform(target: ResourceErrorTarget): ReportDataType {
  return {
    type: ErrorTypes.RESOURCE_ERROR,
    url: getLocationHref(),
    message: '资源地址: ' + (interceptStr(target.src, 120) || interceptStr(target.href, 120)),
    level: Severity.Low,
    time: getTimestamp(),
    name: `${resourceMap[target.localName] || target.localName}加载失败`,
  };
}

export function handleConsole(data: Replace.TriggerConsole): void {
  if (globalVar.isLogAddBreadcrumb) {
    breadcrumb.push({
      type: BreadCrumbTypes.CONSOLE,
      category: breadcrumb.getCategory(BreadCrumbTypes.CONSOLE),
      data,
      level: Severity.fromString(data.level),
    });
  }
}
