import { describe, it, expect, afterEach } from 'vitest';
import { globalVar } from 'encode-yt-monitor-shared';
import { silentConsoleScope } from 'encode-yt-monitor-utils';

/**
 * silentConsoleScope 用来在「不应该产生 console 面包屑」的代码块里临时关闭采集
 * （例如 SDK 自己打印的 warning、业务 beforePushBreadcrumb 里打的日志）。
 *
 * 开关是全局状态，一旦没有正确恢复，后续所有 console 面包屑都会静默丢失，
 * 而且这种问题在线上完全不可见，因此这里重点覆盖「异常 / 嵌套」两条路径。
 */

const defaultIsLogAddBreadcrumb = globalVar.isLogAddBreadcrumb;

afterEach(() => {
  globalVar.isLogAddBreadcrumb = defaultIsLogAddBreadcrumb;
});

describe('silentConsoleScope（console 面包屑静默作用域）', () => {
  it('作用域内部关闭采集，结束后恢复为 true', () => {
    const seen: boolean[] = [];
    silentConsoleScope(() => {
      seen.push(globalVar.isLogAddBreadcrumb);
    });
    expect(seen).toEqual([false]);
    expect(globalVar.isLogAddBreadcrumb).toBe(true);
  });

  it('callback 抛错时仍然恢复开关（否则 console 面包屑永久丢失）', () => {
    expect(() =>
      silentConsoleScope(() => {
        throw new Error('beforePushBreadcrumb boom');
      }),
    ).toThrow('beforePushBreadcrumb boom');
    expect(globalVar.isLogAddBreadcrumb).toBe(true);
  });

  it('嵌套调用结束后恢复成外层的关闭状态，不会提前把采集打开', () => {
    const seen: boolean[] = [];
    silentConsoleScope(() => {
      silentConsoleScope(() => {
        seen.push(globalVar.isLogAddBreadcrumb);
      });
      // 内层结束不能把开关错误地打开
      seen.push(globalVar.isLogAddBreadcrumb);
    });
    expect(seen).toEqual([false, false]);
    expect(globalVar.isLogAddBreadcrumb).toBe(true);
  });

  it('进入前已被关闭时，结束后不会错误地打开开关', () => {
    globalVar.isLogAddBreadcrumb = false;
    silentConsoleScope(() => undefined);
    expect(globalVar.isLogAddBreadcrumb).toBe(false);
  });

  it('透传 callback 的返回值', () => {
    expect(silentConsoleScope(() => 42)).toBe(42);
  });
});
