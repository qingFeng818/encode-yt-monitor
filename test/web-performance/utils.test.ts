import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  afterLoad,
  beforeUnload,
  convertToMB,
  getApiPath,
  isEqualArr,
  isExistPath,
  isIncludeArr,
  roundByFour,
  unload,
  validNumber,
} from '../../packages/web-performance/src/utils';
import generateUniqueID from '../../packages/web-performance/src/utils/generateUniqueID';

/**
 * web-performance 包此前完全没有测试（vitest.config.mjs 的 alias 也没包含它）。
 * utils 是 CCP 指标判定（getCCP）与上报数据清洗的公共依赖，先补这层纯函数。
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('roundByFour / convertToMB', () => {
  it('默认保留 4 位小数，也可指定精度', () => {
    expect(roundByFour(1.23456789)).toBe(1.2346);
    expect(roundByFour(1.23456789, 2)).toBe(1.23);
    expect(roundByFour(2)).toBe(2);
  });

  it('convertToMB 按 1024 进制换算，非数字返回 null', () => {
    expect(convertToMB(1024 * 1024)).toBe(1);
    expect(convertToMB(1536 * 1024)).toBe(1.5);
    expect(convertToMB('1024' as unknown as number)).toBeNull();
  });
});

describe('validNumber', () => {
  it('单个数字必须 >= 0', () => {
    expect(validNumber(0)).toBe(true);
    expect(validNumber(12.5)).toBe(true);
    expect(validNumber(-1)).toBe(false);
  });

  it('数组要求每一项都 >= 0', () => {
    expect(validNumber([0, 1, 2])).toBe(true);
    expect(validNumber([1, -1])).toBe(false);
    expect(validNumber([])).toBe(true);
  });
});

describe('isIncludeArr / isEqualArr', () => {
  it('isIncludeArr 判断前者的元素是否都出现在后者中', () => {
    expect(isIncludeArr(['/a'], ['/a', '/b'])).toBe(true);
    expect(isIncludeArr(['/a', '/b'], ['/a'])).toBe(false);
    expect(isIncludeArr(['/c'], ['/a', '/b'])).toBe(false);
  });

  it('isIncludeArr 对空数组一律返回 false（避免把空队列当成包含关系）', () => {
    expect(isIncludeArr([], ['/a'])).toBe(false);
    expect(isIncludeArr(['/a'], [])).toBe(false);
    expect(isIncludeArr(null as unknown as string[], ['/a'])).toBe(false);
  });

  it('isEqualArr 忽略元素顺序，比较长度与内容', () => {
    expect(isEqualArr(['/a', '/b'], ['/b', '/a'])).toBe(true);
    expect(isEqualArr(['/a'], ['/a', '/b'])).toBe(false);
    expect(isEqualArr(['/a'], ['/c'])).toBe(false);
  });

  it('isEqualArr 不修改入参数组（getCCP 依赖队列原始顺序）', () => {
    const queue = ['/b', '/a'];
    const other = ['/a', '/b'];

    expect(isEqualArr(queue, other)).toBe(true);
    expect(queue).toEqual(['/b', '/a']);
    expect(other).toEqual(['/a', '/b']);
  });
});

describe('getApiPath', () => {
  it('去掉协议、域名、query 与 hash', () => {
    expect(getApiPath('https://api.example.com/user/list?page=1#top')).toBe('/user/list');
    expect(getApiPath('/user/list?page=1')).toBe('/user/list');
  });

  it('空值返回空字符串', () => {
    expect(getApiPath('')).toBe('');
    expect(getApiPath(undefined as unknown as string)).toBe('');
  });
});

describe('isExistPath', () => {
  it('支持 path-to-regexp 的占位符匹配', () => {
    expect(isExistPath(['/user/:id'], '/user/123')).toBe(true);
    expect(isExistPath(['/user/:id'], '/order/123')).toBe(false);
  });

  it('空规则列表返回 false', () => {
    expect(isExistPath([], '/user/123')).toBe(false);
  });
});

describe('generateUniqueID', () => {
  it('生成符合 UUID v4 格式的字符串', () => {
    expect(generateUniqueID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('连续生成不重复', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateUniqueID()));
    expect(ids.size).toBe(200);
  });
});

describe('afterLoad / beforeUnload / unload', () => {
  it('document 已加载完成时异步执行回调，不阻塞主线程', () => {
    vi.useFakeTimers();
    const readyStateSpy = vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
    const callback = vi.fn();

    afterLoad(callback);
    expect(callback).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(callback).toHaveBeenCalledTimes(1);
    readyStateSpy.mockRestore();
  });

  it('document 未加载完成时挂在 pageshow 上', () => {
    const readyStateSpy = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    const callback = vi.fn();

    afterLoad(callback);
    window.dispatchEvent(new Event('pageshow'));

    expect(callback).toHaveBeenCalledTimes(1);
    readyStateSpy.mockRestore();
  });

  it('beforeUnload / unload 分别监听对应事件', () => {
    const onBeforeUnload = vi.fn();
    const onUnload = vi.fn();

    beforeUnload(onBeforeUnload);
    unload(onUnload);

    window.dispatchEvent(new Event('beforeunload'));
    expect(onBeforeUnload).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('unload'));
    expect(onUnload).toHaveBeenCalledTimes(1);
  });
});
