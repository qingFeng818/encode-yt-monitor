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

function objectOrder(reason: any) {
  const sortFn = (obj: any) => {
    return Object.keys(obj)
      .sort()
      .reduce((total, key) => {
        if (variableTypeDetection.isObject(obj[key])) {
          total[key] = sortFn(obj[key]);
        } else {
          total[key] = obj[key];
        }
        return total;
      }, {});
  };
  try {
    if (/\{.*\}/.test(reason)) {
      let obj = JSON.parse(reason);
      obj = sortFn(obj);
      return JSON.stringify(obj);
    }
  } catch (error) {
    return reason;
  }
}

/**
 * http://.../project?id=1#a => http://.../project
 * http://.../id/123=> http://.../id/{param}
 *
 * @param url
 */
export function getRealPath(url: string): string {
  return url.replace(/[\?#].*$/, '').replace(/\/\d+([\/]*$)/, '{param}$1');
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
