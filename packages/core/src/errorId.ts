import { getAppId, isWxMiniEnv, variableTypeDetection } from 'encode-yt-monitor-utils';
import { ErrorTypes, EventTypes } from 'encode-yt-monitor-shared';
import { ReportDataType } from 'encode-yt-monitor-types';
import { options } from './options';
import { getTimestamp } from 'encode-yt-monitor-utils';

/** 一个错误指纹的去重记录 */
interface ErrorRecord {
  /** 当前去重周期内已上报的次数，达到 maxDuplicateCount 后不再上报 */
  count: number;
  /** 最近一次命中的时间戳，仅用于 LRU / 过期淘汰 */
  lastSeen: number;
  /** 上一次额度重置的时间戳，用于 errorIntervalTime 间隔判定 */
  resetTime: number;
}

/**
 * 错误指纹 -> 去重记录。
 *
 * 这里必须是「有界」缓存：长生命周期页面（SPA / 后台系统 / 小程序）会不断产生新的错误指纹，
 * 若只增不删，条目数会随进程存活时间无限增长，且因为被模块级变量强引用而永远无法被 GC，
 * 最终表现为内存持续增长。因此：
 *  - 条目数达到 options.maxErrorNumberSize 时按 LRU（最久未命中）淘汰；
 *  - 命中时把该记录 delete + set 移到 Map 末尾，使迭代顺序等价于 LRU 顺序；
 *  - 新增指纹前先回收一次，保证 size 不会超过上限。
 */
const allErrorNumber = new Map<number, ErrorRecord>();

/** 全量过期回收的最小间隔，避免每次上报都遍历整个缓存 */
const ERROR_NUMBER_SWEEP_INTERVAL = 60 * 1000;

/** 上次全量回收的时间戳 */
let lastSweepTime = 0;

/** 同一个错误达到上报上限后，需要间隔多久（默认 24 小时）才允许重新上报 */
function getErrorIntervalTime(): number {
  return options.errorIntervalTime * 60 * 60 * 1000;
}

/** 把记录标记为「最近使用」：Map 迭代顺序即插入顺序，delete + set 可将其移到末尾 */
function touchErrorRecord(id: number, record: ErrorRecord, now: number): void {
  record.lastSeen = now;
  allErrorNumber.delete(id);
  allErrorNumber.set(id, record);
}

/**
 * 回收缓存，保证其有界：
 * 1. 先删除超过 errorIntervalTime 没有再命中的记录；
 * 2. 若仍达到 maxErrorNumberSize，按 LRU 顺序淘汰最久未命中的记录。
 * 未超容量上限时只在距上次回收超过 ERROR_NUMBER_SWEEP_INTERVAL 后做一次过期回收，
 * 避免每次上报都全量遍历。
 */
function evictErrorNumberCache(now: number): void {
  const maxSize = options.maxErrorNumberSize;

  if (maxSize > 0 && allErrorNumber.size < maxSize) {
    if (now - lastSweepTime < ERROR_NUMBER_SWEEP_INTERVAL) return;
  }
  lastSweepTime = now;

  const expireBefore = now - getErrorIntervalTime();
  allErrorNumber.forEach((record, key) => {
    if (record.lastSeen <= expireBefore) allErrorNumber.delete(key);
  });

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
  lastSweepTime = 0;
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
  const existing = allErrorNumber.get(errorId);

  if (existing) {
    const isOverflow = existing.count >= options.maxDuplicateCount;
    // 达到上限且未到重新上报间隔：本次不上报，但仍刷新活跃时间，保证热点指纹不被淘汰
    if (isOverflow && now - existing.resetTime < getErrorIntervalTime()) {
      touchErrorRecord(errorId, existing, now);
      return null;
    }
    if (isOverflow) {
      existing.count = 1;
      existing.resetTime = now;
    } else {
      existing.count++;
    }
    touchErrorRecord(errorId, existing, now);
    return errorId;
  }

  // 新指纹：先回收缓存保证有界，再写入
  evictErrorNumberCache(now);
  allErrorNumber.set(errorId, { count: 1, lastSeen: now, resetTime: now });
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
