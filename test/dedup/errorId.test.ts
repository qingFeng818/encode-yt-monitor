import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createErrorId,
  getRealPath,
  options,
  transportData,
  clearErrorIdCache,
  getErrorIdCacheSize,
} from 'encode-yt-monitor-core';
import { ErrorTypes, EventTypes, HttpTypes, StaticTypes } from 'encode-yt-monitor-shared';
import type { FinalReportType, ReportDataType } from 'encode-yt-monitor-types';

/**
 * 去重（时间窗口，不计数）：createErrorId 按 type+name+message 生成指纹，
 * 同一个指纹在 errorIntervalTime（默认 30s）内只上报一次（返回 null），
 * 距上次上报超过该间隔后即可再次上报。
 * 指纹缓存 allErrorNumber 是有界的：超过 maxErrorNumberSize 直接按 LRU 淘汰队首。
 *
 * allErrorNumber 是模块级状态，因此这里每个用例前都 clearErrorIdCache()。
 */
let counter = 0;
const newKey = () => `key-${++counter}`;

/**
 * 以「首次出现」的身份计算指纹 id（先清空缓存）。
 * 用于比较「两个输入是否命中同一指纹」——此时去重窗口不会干扰结果。
 */
function idOf(data: ReportDataType, apikey: string): number | null {
  clearErrorIdCache();
  return createErrorId(data, apikey);
}

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
  errorIntervalTime: options.errorIntervalTime,
  maxErrorNumberSize: options.maxErrorNumberSize,
};

// 指纹缓存是模块级状态，清空后用例之间互不影响
beforeEach(() => {
  clearErrorIdCache();
});

afterEach(() => {
  options.errorIntervalTime = INITIAL_OPTIONS.errorIntervalTime;
  options.maxErrorNumberSize = INITIAL_OPTIONS.maxErrorNumberSize;
  clearErrorIdCache();
  vi.useRealTimers();
});

describe('错误去重（createErrorId）', () => {
  describe('时间窗口去重（默认 errorIntervalTime = 30s 内同一指纹只上报一次）', () => {
    it('同一错误窗口内第二次会被去重（返回 null）', () => {
      const key = newKey();
      const msg = `window-${++counter}`;

      const first = createErrorId(makeJsError(msg), key);
      expect(first).not.toBeNull();
      expect(typeof first).toBe('number');

      // 同一指纹，窗口内不再上报
      expect(createErrorId(makeJsError(msg), key)).toBeNull();
    });

    it('超过窗口后可再次上报，且窗口锚点是「上次上报时间」', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      options.errorIntervalTime = 30;
      const key = newKey();
      const msg = `window-reset-${++counter}`;

      expect(createErrorId(makeJsError(msg), key)).not.toBeNull();

      // 29s：仍在窗口内
      vi.setSystemTime(new Date('2026-01-01T00:00:29Z'));
      expect(createErrorId(makeJsError(msg), key)).toBeNull();

      // 30s：到达窗口边界，可再次上报
      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      expect(createErrorId(makeJsError(msg), key)).not.toBeNull();

      // 锚点刷新为本次上报时间，因此 1s 后又被去重
      vi.setSystemTime(new Date('2026-01-01T00:00:31Z'));
      expect(createErrorId(makeJsError(msg), key)).toBeNull();
    });

    it('窗口内被去重时不刷新锚点（持续报错至少每 30s 上报一次）', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      options.errorIntervalTime = 30;
      const key = newKey();
      const msg = `window-anchor-${++counter}`;

      createErrorId(makeJsError(msg), key);
      // 期间一直报错，但都没到窗口，因此锚点保持在 t0
      vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
      expect(createErrorId(makeJsError(msg), key)).toBeNull();
      vi.setSystemTime(new Date('2026-01-01T00:00:20Z'));
      expect(createErrorId(makeJsError(msg), key)).toBeNull();

      // 距 t0 满 30s，即可上报（不会被"一直报错"拖成永不报）
      vi.setSystemTime(new Date('2026-01-01T00:00:30Z'));
      expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
    });

    it('不同 message 应生成不同 id，互不影响', () => {
      const key = newKey();
      const a = idOf(makeJsError(`unique-a-${++counter}`), key);
      const b = idOf(makeJsError(`unique-b-${++counter}`), key);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('相同 message 但 name 不同（TypeError vs RangeError）应生成不同 id', () => {
      const key = newKey();
      const msg = `name-diff-${++counter}`;
      const typeError = idOf({ ...makeJsError(msg), name: 'TypeError' }, key);
      const rangeError = idOf({ ...makeJsError(msg), name: 'RangeError' }, key);
      expect(typeError).not.toBe(rangeError);
    });

    it('相同错误但 apikey 不同应生成不同 id（去重按 apikey 隔离）', () => {
      const msg = `apikey-isolation-${++counter}`;
      const a = idOf(makeJsError(msg), `key-a-${++counter}`);
      const b = idOf(makeJsError(msg), `key-b-${++counter}`);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('同一 message 在 JAVASCRIPT_ERROR / VUE_ERROR / REACT_ERROR 之间互不冲突', () => {
      const key = newKey();
      const msg = `cross-type-${++counter}`;
      const js = idOf(makeJsError(msg), key);
      const vue = idOf({ ...makeJsError(msg), type: ErrorTypes.VUE_ERROR }, key);
      const react = idOf({ ...makeJsError(msg), type: ErrorTypes.REACT_ERROR }, key);
      expect(js).not.toBeNull();
      expect(new Set([js, vue, react]).size).toBe(3);
    });
  });

  describe('HTTP 错误（FETCH_ERROR）指纹 = method + status + 归一化 url + apikey', () => {
    it('同一路由不同动态 id 命中同一指纹', () => {
      const key = newKey();
      // url 中动态 id 会被 getRealPath 归一化为 {param}，因此同一路由不同 id 应命中同一指纹
      const id1 = idOf(makeHttpError({ url: 'https://api.example.com/order/123' }), key);
      const id2 = idOf(makeHttpError({ url: 'https://api.example.com/order/999' }), key);
      expect(id1).not.toBeNull();
      expect(id1).toBe(id2);
    });

    it('query 与 hash 不参与指纹', () => {
      const key = newKey();
      const id1 = idOf(makeHttpError({ url: 'https://api.example.com/order/1?page=1' }), key);
      const id2 = idOf(makeHttpError({ url: 'https://api.example.com/order/2#section' }), key);
      expect(id1).not.toBeNull();
      expect(id1).toBe(id2);
    });

    it('method 或 status 不同应生成不同 id', () => {
      const key = newKey();
      const url = 'https://api.example.com/order/1';
      const get500 = idOf(makeHttpError({ url, method: 'GET', status: 500 }), key);
      const post500 = idOf(makeHttpError({ url, method: 'POST', status: 500 }), key);
      const get502 = idOf(makeHttpError({ url, method: 'GET', status: 502 }), key);
      expect(new Set([get500, post500, get502]).size).toBe(3);
    });

    it('路径中间的数字段不归一化（只有末尾数字段归一化）', () => {
      const key = newKey();
      const id1 = idOf(makeHttpError({ url: 'https://api.example.com/user/1/order' }), key);
      const id2 = idOf(makeHttpError({ url: 'https://api.example.com/user/2/order' }), key);
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });

    it('非数字动态段（如 uuid/短 hash）不归一化', () => {
      const key = newKey();
      const id1 = idOf(makeHttpError({ url: 'https://api.example.com/order/abc-123' }), key);
      const id2 = idOf(makeHttpError({ url: 'https://api.example.com/order/def-456' }), key);
      expect(id1).not.toBeNull();
      expect(id2).not.toBeNull();
      expect(id1).not.toBe(id2);
    });

    it('末尾带斜杠与不带斜杠会被视为不同指纹（记录当前实现行为）', () => {
      const key = newKey();
      const id1 = idOf(makeHttpError({ url: 'https://api.example.com/order/123' }), key);
      const id2 = idOf(makeHttpError({ url: 'https://api.example.com/order/123/' }), key);
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
    const a = idOf(makeLogError(tag, '第一条日志'), key);
    const b = idOf(makeLogError(tag, '第二条日志'), key);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('不同 customTag 相互独立', () => {
    const key = newKey();
    const a = idOf(makeLogError(`tag-a-${++counter}`), key);
    const b = idOf(makeLogError(`tag-b-${++counter}`), key);
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
      const a = idOf(makePromiseError({ message: `{"code":${n},"msg":"oops"}` }), key);
      const b = idOf(makePromiseError({ message: `{"msg":"oops","code":${n}}` }), key);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });

    it('不同 message 内容应生成不同 id', () => {
      const key = newKey();
      const a = idOf(makePromiseError({ message: `{"code":${++counter}}` }), key);
      const b = idOf(makePromiseError({ message: `{"code":${++counter}}` }), key);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('页面 url 不参与指纹（同一错误在不同页面视为同一指纹）', () => {
      const key = newKey();
      const msg = `{"code":${++counter}}`;
      const a = idOf(makePromiseError({ message: msg, url: 'https://a.example.com/page/1' }), key);
      const b = idOf(makePromiseError({ message: msg, url: 'https://b.example.com/other/2' }), key);
      expect(a).toBe(b);
    });

    it('非 JSON 字符串 reason 应生成不同 id（不能退化成同一个指纹）', () => {
      const key = newKey();
      const a = idOf(makePromiseError({ message: 'async boom A' }), key);
      const b = idOf(makePromiseError({ message: 'async boom B' }), key);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('非法 JSON（形如 {foo} 但无法解析）按原文参与指纹，不同原文不碰撞', () => {
      const key = newKey();
      const a = idOf(makePromiseError({ message: '{foo A}' }), key);
      const b = idOf(makePromiseError({ message: '{foo B}' }), key);
      expect(a).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('message 为空串或 undefined 时仍能算出指纹（不返回 null、不碰撞）', () => {
      const key = newKey();
      const empty = idOf(makePromiseError({ message: '' }), key);
      const missing = idOf(makePromiseError({ message: undefined }), key);
      expect(empty).not.toBeNull();
      expect(missing).not.toBeNull();
      // 二者归一化后都为空串，属于「同一个空 reason」，命中同一指纹是预期行为
      expect(empty).toBe(missing);
    });

    it('嵌套对象键顺序不同但内容相同应命中同一指纹', () => {
      const key = newKey();
      const n = ++counter;
      const a = idOf(
        makePromiseError({ message: `{"outer":{"b":${n},"a":1},"list":[{"y":2,"x":1}]}` }),
        key,
      );
      const b = idOf(
        makePromiseError({ message: `{"list":[{"x":1,"y":2}],"outer":{"a":1,"b":${n}}}` }),
        key,
      );
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });
  });

  describe('name 非 unhandledrejection：type + name + 排序后的 message + 页面路径（不含 apikey）', () => {
    it('name 不同应生成不同 id', () => {
      const msg = `{"code":${++counter}}`;
      const a = idOf(makePromiseError({ name: 'ResourceError', message: msg }), newKey());
      const b = idOf(makePromiseError({ name: 'NetworkError', message: msg }), newKey());
      expect(a).not.toBe(b);
    });

    it('页面路径末尾数字段会被归一化，命中同一指纹', () => {
      const msg = `{"code":${++counter}}`;
      const a = idOf(
        makePromiseError({
          name: 'ResourceError',
          message: msg,
          url: 'https://api.example.com/detail/1',
        }),
        newKey(),
      );
      const b = idOf(
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
      const a = idOf(
        makePromiseError({
          name: 'ResourceError',
          message: msg,
          url: 'https://api.example.com/list',
        }),
        newKey(),
      );
      const b = idOf(
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
      const a = idOf(
        makePromiseError({ name: 'ResourceError', message: msg, url }),
        `key-x-${++counter}`,
      );
      const b = idOf(
        makePromiseError({ name: 'ResourceError', message: msg, url }),
        `key-y-${++counter}`,
      );
      expect(a).toBe(b);
    });
  });
});

describe('默认分支（RESOURCE_ERROR / ROUTE_ERROR 等）指纹 = type + message + apikey', () => {
  it('相同 message 命中同一指纹', () => {
    const key = newKey();
    const msg = `资源地址: https://cdn.example.com/app-${++counter}.js`;
    const a = idOf(makeDefaultError(msg), key);
    const b = idOf(makeDefaultError(msg), key);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('相同 message 但 type 不同（RESOURCE_ERROR vs ROUTE_ERROR）互不冲突', () => {
    const key = newKey();
    const msg = `shared-message-${++counter}`;
    const resource = idOf(makeDefaultError(msg, ErrorTypes.RESOURCE_ERROR), key);
    const route = idOf(makeDefaultError(msg, ErrorTypes.ROUTE_ERROR), key);
    expect(resource).not.toBeNull();
    expect(route).not.toBeNull();
    expect(resource).not.toBe(route);
  });
});

describe('错误指纹缓存的有界性与 LRU 淘汰（allErrorNumber）', () => {
  it('缓存条目数不会超过 maxErrorNumberSize（不再是只增不减）', () => {
    options.maxErrorNumberSize = 20;
    for (let i = 0; i < 200; i++) {
      createErrorId(makeJsError(`bounded-${i}`), `key-${i}`);
    }
    expect(getErrorIdCacheSize()).toBe(20);
  });

  it('默认配置下大量不同指纹也不会撑爆缓存', () => {
    for (let i = 0; i < 3000; i++) {
      createErrorId(makeJsError(`default-bounded-${i}`), `key-${i}`);
    }
    expect(getErrorIdCacheSize()).toBe(INITIAL_OPTIONS.maxErrorNumberSize);
  });

  it('缓存满时直接淘汰队首（最久没有上报过的一条）', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    options.maxErrorNumberSize = 3;
    const key = newKey();
    const a = `lru-a-${++counter}`;
    const b = `lru-b-${++counter}`;
    const c = `lru-c-${++counter}`;
    const d = `lru-d-${++counter}`;

    createErrorId(makeJsError(a), key);
    createErrorId(makeJsError(b), key);
    createErrorId(makeJsError(c), key);

    // 过了窗口后重新上报 A → A 被移到队尾（变成"最近上报过"）
    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'));
    expect(createErrorId(makeJsError(a), key)).not.toBeNull();

    // 插入 D 时淘汰的是队首 B，而不是刚上报过的 A
    createErrorId(makeJsError(d), key);
    vi.setSystemTime(new Date('2026-01-01T00:00:32Z'));
    expect(createErrorId(makeJsError(b), key)).not.toBeNull();
    expect(createErrorId(makeJsError(a), key)).toBeNull();
  });

  it('clearErrorIdCache 可清空缓存并重置去重窗口', () => {
    const key = newKey();
    const msg = `clear-${++counter}`;

    createErrorId(makeJsError(msg), key);
    expect(createErrorId(makeJsError(msg), key)).toBeNull();
    expect(getErrorIdCacheSize()).toBe(1);

    clearErrorIdCache();
    expect(getErrorIdCacheSize()).toBe(0);
    expect(createErrorId(makeJsError(msg), key)).not.toBeNull();
  });

  it('errorIntervalTime 与 maxErrorNumberSize 可通过 init 配置', () => {
    options.bindOptions({ errorIntervalTime: 5, maxErrorNumberSize: 10 });
    expect(options.errorIntervalTime).toBe(5);
    expect(options.maxErrorNumberSize).toBe(10);
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

  it('入参不是字符串时不会抛 TypeError（拦截层可能传 URL 对象）', () => {
    expect(getRealPath(new URL('https://a.example.com/order/123?x=1') as any)).toBe(
      'https://a.example.com/order{param}',
    );
    expect(getRealPath(undefined as any)).toBe('');
  });
});

describe('与 transportData.beforePost 集成（去重后不再进入上报流程）', () => {
  it('同一错误第 1 次可上报（写入 errorId），窗口内第 2 次被拦截', async () => {
    transportData.bindOptions({ apikey: newKey(), dsn: 'https://dsn.example.com/api/report' });
    const msg = `beforepost-${++counter}`;

    const first = makeJsError(msg);
    expect(await transportData.beforePost(first)).toBeTruthy();
    expect(first.errorId).toBeTypeOf('number');

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

  it.each([StaticTypes.PV, StaticTypes.UV])(
    '%s 统计数据不参与错误去重（同一页面重复访问都要上报）',
    async (type) => {
      transportData.bindOptions({ apikey: newKey(), dsn: 'https://dsn.example.com/api/report' });
      const pv: ReportDataType = {
        type,
        message: '/order/123',
        to: '/order/123',
        from: '/home',
        url: 'https://a.example.com/#/order/123',
        level: 'info',
        time: Date.now(),
      };

      expect(await transportData.beforePost(pv)).toBeTruthy();
      expect(await transportData.beforePost(pv)).toBeTruthy();
      expect(pv.errorId).toBeUndefined();
    },
  );
});
