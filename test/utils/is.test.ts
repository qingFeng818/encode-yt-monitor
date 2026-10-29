import { describe, it, expect } from 'vitest';
import {
  isError,
  isEmpty,
  isEmptyObject,
  isExistProperty,
  isInstanceOf,
  variableTypeDetection,
} from 'encode-yt-monitor-utils';

/**
 * is.ts 是「判断要不要上报 / 要不要继续处理」的基础设施：
 * 一次误判就可能把错误吞掉（isError 返回 false）或者把正常值当空值丢弃。
 * 这里覆盖跨类型、DOMException、继承关系与异常路径。
 */

describe('variableTypeDetection', () => {
  it('按 Object.prototype.toString 结果判断基础类型', () => {
    expect(variableTypeDetection.isNumber(1)).toBe(true);
    // NaN 的 typeof 是 number，这里也是 true，属于「类型判断」而不是「有效数字判断」
    expect(variableTypeDetection.isNumber(NaN)).toBe(true);
    expect(variableTypeDetection.isString('a')).toBe(true);
    expect(variableTypeDetection.isBoolean(false)).toBe(true);
    expect(variableTypeDetection.isNull(null)).toBe(true);
    expect(variableTypeDetection.isUndefined(undefined)).toBe(true);
    expect(variableTypeDetection.isSymbol(Symbol('s'))).toBe(true);
    expect(variableTypeDetection.isFunction(() => undefined)).toBe(true);
    expect(variableTypeDetection.isObject({})).toBe(true);
    expect(variableTypeDetection.isArray([])).toBe(true);
  });

  it('不会把「包装对象」和原始值混为一谈', () => {
    expect(variableTypeDetection.isString(1)).toBe(false);
    expect(variableTypeDetection.isObject([])).toBe(false);
    expect(variableTypeDetection.isObject(null)).toBe(false);
    expect(variableTypeDetection.isArray({ length: 0 })).toBe(false);
  });

  it('jsdom 下 window 能被识别为 Window（isBrowserEnv 依赖它）', () => {
    expect(variableTypeDetection.isWindow(window)).toBe(true);
  });
});

describe('isError', () => {
  it('各类原生 Error 子类都返回 true', () => {
    expect(isError(new Error('boom'))).toBe(true);
    expect(isError(new TypeError('bad type'))).toBe(true);
    expect(isError(new RangeError('bad range'))).toBe(true);
  });

  it('DOMException 也算错误（拦截层上报的 AbortError 就属于这一类）', () => {
    expect(isError(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('普通对象 / 字符串 / null / undefined 都返回 false', () => {
    expect(isError({ message: 'not an error' })).toBe(false);
    expect(isError('Error: fake')).toBe(false);
    expect(isError(null)).toBe(false);
    expect(isError(undefined)).toBe(false);
  });

  it('原型链指向 Error 的对象也识别为错误', () => {
    const fake = Object.create(Error.prototype);
    fake.message = 'from prototype';
    expect(isError(fake)).toBe(true);
  });

  it('instanceof 抛错时不向外抛出（跨 iframe 场景）', () => {
    // 模拟 instanceof 抛错：把 base 换成没有 call 的 Proxy
    const throwingBase = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new TypeError('cross realm');
        },
      },
    );
    expect(() => isInstanceOf({}, throwingBase)).not.toThrow();
    expect(isInstanceOf({}, throwingBase)).toBe(false);
  });
});

describe('isInstanceOf', () => {
  it('常规继承关系判断正确', () => {
    expect(isInstanceOf(new TypeError('x'), Error)).toBe(true);
    expect(isInstanceOf({}, Error)).toBe(false);
  });

  it('base 非法（null）时返回 false 而不是抛错', () => {
    expect(isInstanceOf(1, null)).toBe(false);
  });
});

describe('isEmpty / isEmptyObject / isExistProperty', () => {
  it('isEmpty 把空字符串、undefined、null 视为空', () => {
    expect(isEmpty('')).toBe(true);
    expect(isEmpty('   ')).toBe(true);
    expect(isEmpty(undefined)).toBe(true);
    expect(isEmpty(null)).toBe(true);
  });

  it('isEmpty 不把 0 / false / NaN 当成空值（否则会被误丢弃）', () => {
    expect(isEmpty(0)).toBe(false);
    expect(isEmpty(false)).toBe(false);
    expect(isEmpty(NaN)).toBe(false);
    expect(isEmpty('0')).toBe(false);
    expect(isEmpty([])).toBe(false);
  });

  it('isEmptyObject 只认「普通对象且没有自有 key」', () => {
    expect(isEmptyObject({})).toBe(true);
    expect(isEmptyObject(Object.create(null))).toBe(true);
    expect(isEmptyObject({ a: 1 })).toBe(false);
    // 数组不算 object 类型
    expect(isEmptyObject([])).toBe(false);
    expect(isEmptyObject(null)).toBe(false);
  });

  it('isExistProperty 只看自有属性，不看原型链', () => {
    expect(isExistProperty({ a: 1 }, 'a')).toBe(true);
    expect(isExistProperty({ a: 1 }, 'b')).toBe(false);
    expect(isExistProperty(Object.create({ inherited: 1 }), 'inherited')).toBe(false);
  });
});
