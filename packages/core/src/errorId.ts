import { getAppId, isWxMiniEnv, variableTypeDetection } from 'encode-yt-monitor-utils';
import { ErrorTypes, EventTypes } from 'encode-yt-monitor-shared';
import { ReportDataType } from 'encode-yt-monitor-types';
import { options } from './options';
import { getTimestamp } from 'encode-yt-monitor-utils';

/**
 * 错误指纹 -> 最近一次「上报」的时间戳。
 *
 * 去重规则（不计数）：同一个指纹在 errorIntervalTime（默认 30s）内只上报一次，
 * 距上次上报超过该间隔后即可再次上报。
 *
 * 内存有界（LRU，不遍历）：Map 的迭代顺序 = 插入顺序，每次真正上报时
 * delete + set 把该条移到末尾，于是队首就是「最久没有上报过」的一条；
 * 新增指纹前若 size 已达 maxErrorNumberSize，直接删掉队首，O(1) 完成淘汰。
 *
 * 这里刻意不做「按时间遍历清扫」：是否过期在命中时比较时间戳即可判断，
 * 缓存里残留的陈旧条目不影响正确性，只会被 LRU 自然顶掉。
 */
const allErrorNumber = new Map<number, number>();

/** 同一个错误在多长时间内只上报一次（默认 30s） */
function getErrorIntervalTime(): number {
  return options.errorIntervalTime * 1000;
}

/** 记录本次上报时间，并把它移到 Map 末尾，使迭代顺序等价于 LRU */
function markAsReported(id: number, now: number): void {
  allErrorNumber.delete(id);
  allErrorNumber.set(id, now);
}

/** 缓存达到上限时删掉队首（最久没有上报过的一条），O(1) 且无需遍历 */
function evictOldestIfNeeded(): void {
  const maxSize = options.maxErrorNumberSize;
  if (maxSize <= 0) return;
  while (allErrorNumber.size >= maxSize) {
    const oldest = allErrorNumber.keys().next();
    if (oldest.done) break;
    allErrorNumber.delete(oldest.value);
  }
}

/** 清空错误指纹缓存（测试隔离 / 运行时手动释放） */
export function clearErrorIdCache(): void {
  allErrorNumber.clear();
}

/** 当前缓存的错误指纹数量（用于观测与验证缓存有界性） */
export function getErrorIdCacheSize(): number {
  return allErrorNumber.size;
}

/**
 * generate error unique Id
 * @param data
 */
export function createErrorId(data: ReportDataType, apikey: string): number | null {
  let id = '';
  switch (data.type) {
    case ErrorTypes.FETCH_ERROR:
      id =
        data.type +
        data.request.method +
        data.response.status +
        getRealPath(data.request.url) +
        apikey;
      break;
    case ErrorTypes.JAVASCRIPT_ERROR:
    case ErrorTypes.VUE_ERROR:
    case ErrorTypes.REACT_ERROR:
      id = data.type + data.name + data.message + apikey;
      break;
    case ErrorTypes.LOG_ERROR:
      id = data.customTag + data.type + data.name + apikey;
      break;
    case ErrorTypes.PROMISE_ERROR:
      id = generatePromiseErrorId(data, apikey);
      break;
    default:
      id = data.type + data.message + apikey;
      break;
  }
  const errorId = hashCode(id);
  const now = getTimestamp();
  const lastReportTime = allErrorNumber.get(errorId);
  // 同一个错误在 errorIntervalTime 内只上报一次
  if (lastReportTime !== undefined && now - lastReportTime < getErrorIntervalTime()) {
    return null;
  }

  // 新指纹：先淘汰队首保证缓存有界，再记录本次上报时间
  if (lastReportTime === undefined) {
    evictOldestIfNeeded();
  }
  markAsReported(errorId, now);
  return errorId;
}

function generatePromiseErrorId(data: ReportDataType, apikey: string) {
  const locationUrl = getRealPath(data.url);
  if (data.name === EventTypes.UNHANDLEDREJECTION) {
    return data.type + objectOrder(data.message) + apikey;
  }
  return data.type + data.name + objectOrder(data.message) + locationUrl;
}

/**
 * 递归按 key 排序：保证同一对象（含嵌套对象 / 数组元素）在不同 key 顺序下序列化结果一致。
 */
function sortObjectKeys(data: any): any {
  if (variableTypeDetection.isArray(data)) {
    return data.map((item) => sortObjectKeys(item));
  }
  if (!variableTypeDetection.isObject(data)) {
    return data;
  }
  return Object.keys(data)
    .sort()
    .reduce((total, key) => {
      total[key] = sortObjectKeys(data[key]);
      return total;
    }, {} as Record<string, any>);
}

/**
 * 把 promise reason 归一化成参与指纹计算的字符串。
 *
 * 必须保证「任何输入都返回字符串」：
 * - reason 是 JSON 对象字符串 → key 排序后重新序列化，忽略顺序差异；
 * - reason 是其它字符串（reject('boom A')）→ 原样返回；
 * - reason 是对象 / Error / 数字等 → 稳定序列化（失败退化为 String(reason)）。
 *
 * 早期实现只处理了 JSON 字符串分支，其余分支返回 undefined，
 * 于是所有「非 JSON 的 reason」都会拼出同一个 id，被 errorIntervalTime 去重掉。
 */
function objectOrder(reason: any): string {
  if (reason === undefined || reason === null) return '';
  if (!variableTypeDetection.isString(reason)) {
    try {
      const json = JSON.stringify(sortObjectKeys(reason));
      // Error / Symbol 等无法 JSON 化的对象会序列化成 '{}' 或 undefined，退化为字符串描述
      return json === undefined || json === '{}' ? String(reason) : json;
    } catch (error) {
      return String(reason);
    }
  }
  const text = reason as string;
  // 只对「看起来是 JSON 对象」的字符串做排序归一化，其余（含非法 JSON）按原文参与指纹
  if (!/\{.*\}/.test(text)) return text;
  try {
    return JSON.stringify(sortObjectKeys(JSON.parse(text)));
  } catch (error) {
    return text;
  }
}

/**
 * http://.../project?id=1#a => http://.../project
 * http://.../id/123=> http://.../id/{param}
 *
 * @param url
 */
export function getRealPath(url: string): string {
  // url 的声明类型虽然是 string，但拦截层拿到的是 xhr.open / fetch 的原始入参（可能是 URL 对象），
  // 直接调用 replace 会抛 TypeError，把「拼接指纹」这一步变成一次异常、丢掉整条上报
  const target = variableTypeDetection.isString(url) ? url : url ? String(url) : '';
  return target.replace(/[\?#].*$/, '').replace(/\/\d+([\/]*$)/, '{param}$1');
}

/**
 *
 * @param url
 */
export function getFlutterRealOrigin(url: string): string {
  // for apple
  return removeHashPath(getFlutterRealPath(url));
}

export function getFlutterRealPath(url: string): string {
  // for apple
  return url.replace(/(\S+)(\/Documents\/)(\S*)/, `$3`);
}

export function getRealPageOrigin(url: string): string {
  const fileStartReg = /^file:\/\//;
  if (fileStartReg.test(url)) {
    return getFlutterRealOrigin(url);
  }
  if (isWxMiniEnv) {
    return getAppId();
  }
  return getRealPath(removeHashPath(url).replace(/(\S*)(\/\/)(\S+)/, '$3'));
}

export function removeHashPath(url: string): string {
  return url.replace(/(\S+)(\/#\/)(\S*)/, `$1`);
}

export function hashCode(str: string): number {
  let hash = 0;
  if (str.length == 0) return hash;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash;
}
