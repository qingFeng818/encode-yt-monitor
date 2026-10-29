import { describe, it, expect, vi, afterEach } from 'vitest';
import { ErrorTypes } from 'encode-yt-monitor-shared';
import {
  getBigVersion,
  getFunctionName,
  interceptStr,
  isHttpFail,
  on,
  parseErrorString,
  replaceOld,
  setUrlQuery,
  splitObjToQuery,
  throttle,
  unknownToString,
} from 'encode-yt-monitor-utils';

/**
 * helpers.ts 里的纯函数被上报链路大量复用（拼 body、拼 query、判断是否失败、解析微信错误串）。
 * 这些函数出错的表现是「数据悄悄变样」而不是抛错，很难通过集成用例发现，所以单独覆盖。
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('splitObjToQuery', () => {
  it('普通值用 & 拼接', () => {
    expect(splitObjToQuery({ a: 1, b: 'x' })).toBe('a=1&b=x');
  });

  it('对象 / 数组值会 JSON 序列化，避免拼出 [object Object]', () => {
    expect(splitObjToQuery({ ids: [1, 2] })).toBe('ids=[1,2]');
    expect(splitObjToQuery({ filter: { k: 'v' } })).toBe('filter={"k":"v"}');
  });

  it('空对象返回空字符串', () => {
    expect(splitObjToQuery({})).toBe('');
  });
});

describe('setUrlQuery', () => {
  it('已有 query 时用 & 追加', () => {
    expect(setUrlQuery('/pages/index?a=1', { b: 2 })).toBe('/pages/index?a=1&b=2');
  });

  it('没有 query 时用 ? 追加', () => {
    expect(setUrlQuery('/pages/index', { b: 2, c: 3 })).toBe('/pages/index?b=2&c=3');
  });
});

describe('getFunctionName', () => {
  it('具名函数返回函数名', () => {
    expect(getFunctionName(function namedFn() {})).toBe('namedFn');
  });

  it('匿名函数 / 非函数 / 空值统一返回 <anonymous>', () => {
    expect(getFunctionName(() => undefined)).toBe('<anonymous>');
    expect(getFunctionName(null)).toBe('<anonymous>');
    expect(getFunctionName({ name: 'fake' })).toBe('<anonymous>');
  });
});

describe('throttle', () => {
  it('同一时间内只执行第一次，间隔结束后恢复', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const throttled = throttle(fn, 100);

    throttled('first');
    throttled('second');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith('first');

    vi.advanceTimersByTime(100);
    throttled('third');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith('third');
  });
});

describe('on / replaceOld', () => {
  it('on 把事件原样委托给 addEventListener', () => {
    const target = { addEventListener: vi.fn() };
    const handler = () => undefined;
    on(target, 'click', handler);
    expect(target.addEventListener).toHaveBeenCalledWith('click', handler, false);
  });

  it('replaceOld 用原函数包装出新函数', () => {
    const source = { foo: () => 'orig' };
    replaceOld(source, 'foo', (original: () => string) => () => `wrapped:${original()}`);
    expect(source.foo()).toBe('wrapped:orig');
  });

  it('属性不存在且非强制时不新增属性', () => {
    const source: Record<string, any> = {};
    replaceOld(source, 'missing', () => () => 'x');
    expect('missing' in source).toBe(false);
  });

  it('isForced 为 true 时即使属性不存在也写入', () => {
    const source: Record<string, any> = {};
    replaceOld(source, 'bar', () => () => 'x', true);
    expect(source.bar()).toBe('x');
  });

  it('source 为 undefined 时不抛错；replacement 返回非函数时保留原实现', () => {
    expect(() => replaceOld(undefined as any, 'x', () => () => 'y')).not.toThrow();

    const source = { f: () => 1 };
    replaceOld(source, 'f', () => undefined as any);
    expect(source.f()).toBe(1);
  });
});

describe('isHttpFail', () => {
  it('0 与 >= 400 视为失败，其余视为成功', () => {
    expect(isHttpFail(0)).toBe(true);
    expect(isHttpFail(400)).toBe(true);
    expect(isHttpFail(500)).toBe(true);
    expect(isHttpFail(304)).toBe(false);
    expect(isHttpFail(200)).toBe(false);
  });

  it('非法状态码（NaN）不会被误判为失败', () => {
    expect(isHttpFail(Number.NaN)).toBe(false);
  });
});

describe('interceptStr / unknownToString / getBigVersion', () => {
  it('超长字符串截断并标注截断长度', () => {
    expect(interceptStr('abcdef', 3)).toBe('abc:截取前3个字符');
  });

  it('未超长时原样返回，非字符串返回空串', () => {
    expect(interceptStr('abc', 3)).toBe('abc');
    expect(interceptStr(123 as any, 3)).toBe('');
  });

  it('unknownToString 覆盖字符串、空值、Symbol、循环引用', () => {
    expect(unknownToString('plain')).toBe('plain');
    expect(unknownToString(undefined)).toBe('undefined');
    expect(unknownToString(null)).toBe('null');
    expect(unknownToString(0)).toBe('0');
    expect(unknownToString(false)).toBe('false');
    expect(unknownToString(Symbol('s'))).toBe('Symbol(s)');

    const circular: Record<string, any> = {};
    circular.self = circular;
    expect(unknownToString(circular)).toBe('[object Object]');
  });

  it('getBigVersion 取主版本号', () => {
    expect(getBigVersion('1.2.3')).toBe(1);
    expect(getBigVersion('12.0.0')).toBe(12);
  });
});

describe('parseErrorString（小程序错误字符串解析）', () => {
  it('单行字符串无法解析，返回 null', () => {
    expect(parseErrorString('boom')).toBeNull();
  });

  it('带 MiniProgramError 头时先剔除该行', () => {
    const raw = [
      'MiniProgramError',
      'TypeError: Cannot read property x of undefined',
      'TypeError: Cannot read property x of undefined',
      '    at foo (http://tmp/app.js:10:5)',
    ].join('\n');

    const parsed = parseErrorString(raw);
    expect(parsed.message).toBe('TypeError: Cannot read property x of undefined');
    expect(parsed.name).toBe('TypeError');
    expect(parsed.stack).toEqual([
      { args: [], func: 'foo', column: 5, line: 10, url: 'http://tmp/app.js' },
    ]);
  });

  it('没有括号的堆栈行也能解析出 url / line / column', () => {
    const raw = ['Error: boom', 'Error', '    at http://tmp/app.js:3:7'].join('\n');

    const parsed = parseErrorString(raw);
    expect(parsed.message).toBe('Error: boom');
    expect(parsed.stack).toEqual([
      { args: [], func: ErrorTypes.UNKNOWN_FUNCTION, column: 7, line: 3, url: 'http://tmp/app.js' },
    ]);
  });
});
