import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createErrorId,
  getRealPath,
  options,
  transportData,
  clearErrorIdCache,
  getErrorIdCacheSize,
} from 'encode-yt-monitor-core';
import { ErrorTypes, EventTypes, HttpTypes } from 'encode-yt-monitor-shared';
import type { FinalReportType, ReportDataType } from 'encode-yt-monitor-types';

/**
 * 去重：createErrorId 按 type+name+message 生成指纹，
 * 同一指纹在 maxDuplicateCount（默认 2）次以内返回 id，超过返回 null（不再上报），
 * 直到超过 errorIntervalTime 后额度重置；指纹缓存本身按 maxErrorNumberSize 做 LRU 淘汰。
 *
 * allErrorNumber 是模块级状态，这里每个用例前都 clearErrorIdCache()，
 * 保证用例之间互不影响（唯一 apikey / message 只是额外保险）。
 */
let counter = 0;
const newKey = () => `key-${++counter}`;

function makeJsError(message: string): ReportDataType {
  return {
    type: ErrorTypes.JAVASCRIPT_ERROR,
    name: 'TypeError',
    message,
    url: 'http://localhost/',
    time: Date.now(),
    level: 'normal',
    stack: [],
  };
}

function makeHttpError({
  url,
  method = 'GET',
  status = 500,
}: {
  url: string;
  method?: string;
  status?: number;
}): ReportDataType {
  return {
    type: ErrorTypes.FETCH_ERROR,
    name: `${HttpTypes.XHR}--${method}`,
    message: 'http error',
    url: 'http://localhost/',
    time: 1,
    level: 'low',
    request: { method, url, httpType: HttpTypes.XHR },
    response: { status, data: '' },
  } as unknown as ReportDataType;
}

/** LOG_ERROR 指纹 = customTag + type + name + apikey（注意：message 不参与） */
function makeLogError(customTag: string, message = 'log message'): ReportDataType {
  return {
    type: ErrorTypes.LOG_ERROR,
    name: 'Monitor.log',
    message,
    customTag,
    url: 'http://localhost/',
    time: 1,
    level: 'normal',
  };
}

/** PROMISE_ERROR 默认 name 为 unhandledrejection */
function makePromiseError(partial: Partial<ReportDataType>): ReportDataType {
  return {
    type: ErrorTypes.PROMISE_ERROR,
    name: EventTypes.UNHANDLEDREJECTION,
    message: '',
    url: 'http://localhost/',
    time: 1,
    level: 'low',
    ...partial,
  };
}

/** RESOURCE_ERROR / ROUTE_ERROR 等走 default 分支：type + message + apikey */
function makeDefaultError(
  message: string,
  type: ErrorTypes = ErrorTypes.RESOURCE_ERROR,
): ReportDataType {
  return {
    type,
    name: '图片加载失败',
    message,
    url: 'http://localhost/',
    time: 1,
    level: 'low',
  };
}

/** 用例开始时的全局配置，用例改动后必须还原，否则污染其它用例 */
const INITIAL_OPTIONS = {
  maxDuplicateCount: options.maxDuplicateCount,
  errorIntervalTime: options.errorIntervalTime,
  maxErrorNumberSize: options.maxErrorNumberSize,
};

// 指纹缓存是模块级状态，清空后用例之间互不影响（不再依赖「唯一 message」）
beforeEach(() => {
  clearErrorIdCache();
});

afterEach(() => {
  options.maxDuplicateCount = INITIAL_OPTIONS.maxDuplicateCount;
  options.errorIntervalTime = INITIAL_OPTIONS.errorIntervalTime;
  options.maxErrorNumberSize = INITIAL_OPTIONS.maxErrorNumberSize;
  clearErrorIdCache();
  vi.useRealTimers();
});

describe('错误去重（createErrorId）', () => {
  describe('通用去重行为', () => {
    it('相同错误前两次应生成有效 errorId', () => {
      const key = newKey();
      const msg1 = `dedup-twice-${++counter}`;
      const id1 = createErrorId(makeJsError(msg1), key);
      const id2 = createErrorId(makeJsError(msg1), key);
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).toBe(id2);
      expect(typeof id1).toBe('number');
    });

    it('超过 maxDuplicateCount 后应返回 null（不再上报），且后续持续为 null', () => {
      const key = newKey();
      const msg = `dedup-overflow-${++counter}`;
      // 前两次占用额度
      createErrorId(makeJsError(msg), key);
      createErrorId(makeJsError(msg), key);
      // 第三次、第四次被去重
      expect(createErrorId(makeJsError(msg), key)).toBeNull();
      expect(createErrorId(makeJsError(msg), key)).toBeNull();
    });

    it('不同 message 应生成不同 id，互不影响', () => {
      const key = newKey();
      const a = createErrorId(makeJsError(`unique-a-${++counter}`), key);
      const b = createErrorId(makeJsError(`unique-b-${++counter}`), key);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('相同 message 但 name 不同（TypeError vs RangeError）应生成不同 id', () => {
      const key = newKey();
      const msg = `name-diff-${++counter}`;
      const typeError = createErrorId({ ...makeJsError(msg), name: 'TypeError' }, key);
      const rangeError = createErrorId({ ...makeJsError(msg), name: 'RangeError' }, key);
      expect(typeError).not.toBe(rangeError);
    });

    it('相同错误但 apikey 不同应生成不同 id（去重按 apikey 隔离）', () => {
      const msg = `apikey-isolation-${++counter}`;
      const a = createErrorId(makeJsError(msg), `key-a-${++counter}`);
      const b = createErrorId(makeJsError(msg), `key-b-${++counter}`);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('同一 message 在 JAVASCRIPT_ERROR / VUE_ERROR / REACT_ERROR 之间互不冲突', () => {
      const key = newKey();
      const msg = `cross-type-${++counter}`;
      const js = createErrorId(makeJsError(msg), key);
      const vue = createErrorId({ ...makeJsError(msg), type: ErrorTypes.VUE_ERROR }, key);
      const react = createErrorId({ ...makeJsError(msg), type: ErrorTypes.REACT_ERROR }, key);
      expect(js).not.toBeNull();
      expect(new Set([js, vue, react]).size).toBe(3);
    });
  });

  describe('HTTP 错误（FETCH_ERROR）指纹 = method + status + 归一化 url + apikey', () => {
    it('同一路由不同动态 id 命中同一指纹', () => {
      const key = newKey();
      // url 中动态 id 会被 getRealPath 归一化为 {param}，因此同一路由不同 id 应命中同一指纹
      const id1 = createErrorId(makeHttpError({ url: 'https://api.example.com/order/123' }), key);
      const id2 = createErrorId(makeHttpError({ url: 'https://api.example.com/order/999' }), key);
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).toBe(id2);
    });

    it('query 与 hash 不参与指纹', () => {
      const key = newKey();
      const id1 = createErrorId(
        makeHttpError({ url: 'https://api.example.com/order/1?page=1' }),
        key,
      );
      const id2 = createErrorId(
        makeHttpError({ url: 'https://api.example.com/order/2#section' }),
        key,
      );
      expect(id1).not.toBeNull();
      expect(id1).toBe(id2);
    });

    it('method 或 status 不同应生成不同 id', () => {
      const key = newKey();
      const url = 'https://api.example.com/order/1';
      const get500 = createErrorId(makeHttpError({ url, method: 'GET', status: 500 }), key);
      const post500 = createErrorId(makeHttpError({ url, method: 'POST', status: 500 }), key);
      const get502 = createErrorId(makeHttpError({ url, method: 'GET', status: 502 }), key);
      expect(new Set([get500, post500, get502]).size).toBe(3);
    });

    it('路径中间的数字段不归一化（只有末尾数字段归一化）', () => {
      const key = newKey();
      const id1 = createErrorId(
        makeHttpError({ url: 'https://api.example.com/user/1/order' }),
        key,
      );
      const id2 = createErrorId(
        makeHttpError({ url: 'https://api.example.com/user/2/order' }),
        key,
      );
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });

    it('非数字动态段（如 uuid/短 hash）不归一化', () => {
      const key = newKey();
      const id1 = createErrorId(
        makeHttpError({ url: 'https://api.example.com/order/abc-123' }),
        key,
      );
      const id2 = createErrorId(
        makeHttpError({ url: 'https://api.example.com/order/def-456' }),
        key,
      );
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });

    it('末尾带斜杠与不带斜杠会被视为不同指纹（记录当前实现行为）', () => {
      const key = newKey();
      const id1 = createErrorId(makeHttpError({ url: 'https://api.example.com/order/123' }), key);
      const id2 = createErrorId(makeHttpError({ url: 'https://api.example.com/order/123/' }), key);
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });
  });
});

describe('主动上报（LOG_ERROR）指纹 = customTag + type + name + apikey', () => {
  it('相同 customTag 不同 message 命中同一指纹（message 不参与）', () => {
    const key = newKey();
    const tag = `log-tag-${++counter}`;
    const a = createErrorId(makeLogError(tag, '第一条日志'), key);
    const b = createErrorId(makeLogError(tag, '第二条日志'), key);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    // 第三次达到 maxDuplicateCount 被去重
    expect(createErrorId(makeLogError(tag, '第三条日志'), key)).toBeNull();
  });

  it('不同 customTag 相互独立', () => {
    const key = newKey();
    const a = createErrorId(makeLogError(`tag-a-${++counter}`), key);
    const b = createErrorId(makeLogError(`tag-b-${++counter}`), key);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe('Promise 错误（PROMISE_ERROR）指纹', () => {
  describe('name 为 unhandledrejection：type + 排序后的 message + apikey', () => {
    it('message 对象键顺序不同但内容相同应命中同一指纹', () => {
      const key = newKey();
      const n = ++counter;
      const a = createErrorId(makePromiseError({ message: `{"code":${n},"msg":"oops"}` }), key);
      const b = createErrorId(makePromiseError({ message: `{"msg":"oops","code":${n}}` }), key);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });

    it('不同 message 内容应生成不同 id', () => {
      const key = newKey();
      const a = createErrorId(makePromiseError({ message: `{"code":${++counter}}` }), key);
      const b = createErrorId(makePromiseError({ message: `{"code":${++counter}}` }), key);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('页面 url 不参与指纹（同一错误在不同页面视为同一指纹）', () => {
      const key = newKey();
      const msg = `{"code":${++counter}}`;
      const a = createErrorId(
        makePromiseError({ message: msg, url: 'https://a.example.com/page/1' }),
        key,
      );
      const b = createErrorId(
        makePromiseError({ message: msg, url: 'https://b.example.com/other/2' }),
        key,
      );
      expect(a).toBe(b);
    });

    it.fails('已知缺陷：非 JSON 字符串 reason 应生成不同 id（当前实现会碰撞）', () => {
      const key = newKey();
      const a = createErrorId(makePromiseError({ message: 'async boom A' }), key);
      const b = createErrorId(makePromiseError({ message: 'async boom B' }), key);
      expect(a).not.toBe(b);
    });
  });

  describe('name 非 unhandledrejection：type + name + 排序后的 message + 页面路径（不含 apikey）', () => {
    it('name 不同应生成不同 id', () => {
      const msg = `{"code":${++counter}}`;
      const a = createErrorId(makePromiseError({ name: 'ResourceError', message: msg }), newKey());
      const b = createErrorId(makePromiseError({ name: 'NetworkError', message: msg }), newKey());
      expect(a).not.toBe(b);
    });

    it('页面路径末尾数字段会被归一化，命中同一指纹', () => {
      const msg = `{"code":${++counter}}`;
      const a = createErrorId(
        makePromiseError({
          name: 'ResourceError',
          message: msg,
          url: 'https://api.example.com/detail/1',
        }),
        newKey(),
      );
      const b = createErrorId(
        makePromiseError({
          name: 'ResourceError',
          message: msg,
          url: 'https://api.example.com/detail/2',
        }),
        newKey(),
      );
      expect(a).toBe(b);
    });

    it('不同页面路径应生成不同 id', () => {
      const msg = `{"code":${++counter}}`;
      const a = createErrorId(
        makePromiseError({
          name: 'ResourceError',
          message: msg,
          url: 'https://api.example.com/list',
        }),
        newKey(),
      );
      const b = createErrorId(
        makePromiseError({
          name: 'ResourceError',
          message: msg,
          url: 'https://api.example.com/detail',
        }),
        newKey(),
      );
      expect(a).not.toBe(b);
    });

    it('指纹不含 apikey：不同 apikey 仍命中同一指纹（记录当前实现行为）', () => {
      const msg = `{"code":${++counter}}`;
      const url = 'https://api.example.com/page/1';
      const a = createErrorId(
        makePromiseError({ name: 'ResourceError', message: msg, url }),
        `key-x-${++counter}`,
      );
      const b = createErrorId(
        makePromiseError({ name: 'ResourceError', message: msg, url }),
        `key-y-${++counter}`,
      );
      expect(a).toBe(b);
    });
  });
});

describe('默认分支（RESOURCE_ERROR / ROUTE_ERROR 等）指纹 = type + message + apikey', () => {
  it('相同 message 前两次有效、第三次被去重', () => {
    const key = newKey();
    const msg = `资源地址: https://cdn.example.com/app-${++counter}.js`;
    const a = createErrorId(makeDefaultError(msg), key);
    const b = createErrorId(makeDefaultError(msg), key);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(createErrorId(makeDefaultError(msg), key)).toBeNull();
  });

  it('相同 message 但 type 不同（RESOURCE_ERROR vs ROUTE_ERROR）互不冲突', () => {
    const key = newKey();
    const msg = `shared-message-${++counter}`;
    const resource = createErrorId(makeDefaultError(msg, ErrorTypes.RESOURCE_ERROR), key);
    const route = createErrorId(makeDefaultError(msg, ErrorTypes.ROUTE_ERROR), key);
    expect(resource).not.toBeNull();
    expect(route).not.toBeNull();
    expect(resource).not.toBe(route);
  });
});

describe('maxDuplicateCount 可配置', () => {
  it('maxDuplicateCount = 1 时第二次即被去重', () => {
    options.maxDuplicateCount = 1;
    const key = newKey();
    const msg = `max-count-1-${++counter}`;
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    expect(createErrorId(makeJsError(msg), key)).toBeNull();
  });

  it('maxDuplicateCount = 3 时前三次有效、第四次被去重', () => {
    options.maxDuplicateCount = 3;
    const key = newKey();
    const msg = `max-count-3-${++counter}`;
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    expect(createErrorId(makeJsError(msg), key)).toBeNull();
  });
});

describe('getRealPath 归一化规则（HTTP 指纹依赖）', () => {
  it('去掉 query 与 hash', () => {
    expect(getRealPath('https://a.example.com/p?x=1')).toBe('https://a.example.com/p');
    expect(getRealPath('https://a.example.com/p#frag')).toBe('https://a.example.com/p');
  });

  it('末尾数字段归一化为 {param}', () => {
    expect(getRealPath('https://a.example.com/order/123')).toBe(
      'https://a.example.com/order{param}',
    );
    expect(getRealPath('https://a.example.com/user/1/order/2')).toBe(
      'https://a.example.com/user/1/order{param}',
    );
  });

  it('路径中间数字段、非数字动态段保持原样', () => {
    expect(getRealPath('https://a.example.com/user/1/order')).toBe(
      'https://a.example.com/user/1/order',
    );
    expect(getRealPath('https://a.example.com/order/abc-123')).toBe(
      'https://a.example.com/order/abc-123',
    );
  });
});

describe('与 transportData.beforePost 集成（去重后不再进入上报流程）', () => {
  it('同一错误第 1、2 次可上报（写入 errorId），第 3 次被拦截', async () => {
    transportData.bindOptions({ apikey: newKey(), dsn: 'https://dsn.example.com/api/report' });
    const msg = `beforepost-${++counter}`;

    const first = makeJsError(msg);
    expect(await transportData.beforePost(first)).toBeTruthy();
    expect(first.errorId).toBeTypeOf('number');

    expect(await transportData.beforePost(makeJsError(msg))).toBeTruthy();

    expect(await transportData.beforePost(makeJsError(msg))).toBe(false);
  });

  it('埋点数据（TrackReportData）不参与错误去重，也不会写入 errorId', async () => {
    transportData.bindOptions({ apikey: newKey(), dsn: 'https://dsn.example.com/api/report' });
    const track = {
      actionType: 'click',
      url: 'https://a.example.com/',
      level: 'info',
    } as unknown as FinalReportType;

    expect(await transportData.beforePost(track)).toBeTruthy();
    expect(await transportData.beforePost(track)).toBeTruthy();
    expect((track as unknown as ReportDataType).errorId).toBeUndefined();
  });
});

describe('错误指纹缓存的有界性与淘汰（allErrorNumber）', () => {
  it('缓存条目数不会超过 maxErrorNumberSize（不再是只增不减）', () => {
    options.maxErrorNumberSize = 20;
    for (let i = 0; i < 200; i++) {
      createErrorId(makeJsError(`bounded-${i}`), `key-${i}`);
    }
    expect(getErrorIdCacheSize()).toBeLessThanOrEqual(20);
  });

  it('默认配置下大量不同指纹也不会撑爆缓存', () => {
    for (let i = 0; i < 3000; i++) {
      createErrorId(makeJsError(`default-bounded-${i}`), `key-${i}`);
    }
    expect(getErrorIdCacheSize()).toBeLessThanOrEqual(INITIAL_OPTIONS.maxErrorNumberSize);
  });

  it('被 LRU 淘汰的指纹会重新获得上报额度', () => {
    options.maxErrorNumberSize = 5;
    const key = newKey();
    const msg = `lru-victim-${++counter}`;

    createErrorId(makeJsError(msg), key);
    createErrorId(makeJsError(msg), key);
    expect(createErrorId(makeJsError(msg), key)).toBeNull();

    // 塞入足够多的新指纹，把最久未命中的那个挤出去
    for (let i = 0; i < 10; i++) {
      createErrorId(makeJsError(`lru-filler-${++counter}`), key);
    }

    // 被淘汰后计数从 1 重新开始，因此可以再次上报
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
  });

  it('达到上限后在 errorIntervalTime 内持续去重，超过后额度重置', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    options.errorIntervalTime = 24;
    const key = newKey();
    const msg = `interval-${++counter}`;

    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    expect(createErrorId(makeJsError(msg), key)).toBeNull();

    // 23 小时后仍在间隔内
    vi.setSystemTime(new Date('2026-01-01T23:00:00Z'));
    expect(createErrorId(makeJsError(msg), key)).toBeNull();

    // 25 小时后额度重置，可再次上报；重新计数后依然只能上报 maxDuplicateCount 次
    vi.setSystemTime(new Date('2026-01-02T01:00:00Z'));
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    expect(createErrorId(makeJsError(msg), key)).toBeNull();
  });

  it('errorIntervalTime 的单位是小时（1 → 1 小时，而不是 60 小时）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    options.errorIntervalTime = 1;
    const key = newKey();
    const msg = `unit-${++counter}`;

    createErrorId(makeJsError(msg), key);
    createErrorId(makeJsError(msg), key);
    expect(createErrorId(makeJsError(msg), key)).toBeNull();

    vi.setSystemTime(new Date('2026-01-01T00:59:00Z'));
    expect(createErrorId(makeJsError(msg), key)).toBeNull();

    vi.setSystemTime(new Date('2026-01-01T01:00:01Z'));
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
  });

  it('长期未命中的指纹会被过期回收', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    options.errorIntervalTime = 24;

    createErrorId(makeJsError(`expire-${++counter}`), newKey());
    expect(getErrorIdCacheSize()).toBe(1);

    // 48 小时后再产生一个新指纹会触发一次回收，把过期的老指纹删掉
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    createErrorId(makeJsError(`expire-new-${++counter}`), newKey());
    expect(getErrorIdCacheSize()).toBe(1);
  });

  it('clearErrorIdCache 可清空缓存并重置去重额度', () => {
    const key = newKey();
    const msg = `clear-${++counter}`;

    createErrorId(makeJsError(msg), key);
    createErrorId(makeJsError(msg), key);
    expect(createErrorId(makeJsError(msg), key)).toBeNull();
    expect(getErrorIdCacheSize()).toBe(1);

    clearErrorIdCache();
    expect(getErrorIdCacheSize()).toBe(0);
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
  });

  it('errorIntervalTime 与 maxErrorNumberSize 可通过 init 配置', () => {
    options.bindOptions({ errorIntervalTime: 1, maxErrorNumberSize: 10 });
    expect(options.errorIntervalTime).toBe(1);
    expect(options.maxErrorNumberSize).toBe(10);
  });
});
