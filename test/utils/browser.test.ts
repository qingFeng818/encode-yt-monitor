import { describe, it, expect } from 'vitest';
import { EventTypes, WxAppEvents } from 'encode-yt-monitor-shared';
import { getFlag, htmlElementAsString, parseUrlToObj, setSilentFlag } from 'encode-yt-monitor-utils';

/**
 * browser.ts 里的三个函数分别服务于：点击面包屑（htmlElementAsString）、
 * 路由面包屑（parseUrlToObj）、以及 silent* 开关（setSilentFlag）。
 * 三者都属于「错了不会报错、只会静默丢数据」的类型，之前没有被直接覆盖。
 */

describe('htmlElementAsString', () => {
  it('body 不生成面包屑（避免刷屏）', () => {
    expect(htmlElementAsString(document.body)).toBeNull();
  });

  it('输出 tag + id + class + innerText', () => {
    const btn = document.createElement('button');
    btn.id = 'submit';
    btn.className = 'primary large';
    // jsdom 没有实现 innerText，这里直接定义，保证断言与浏览器行为一致
    Object.defineProperty(btn, 'innerText', { value: '提交', configurable: true });

    expect(htmlElementAsString(btn)).toBe('<button id="submit" class="primary large">提交</button>');
  });

  it('没有 id / class 时不出现空属性', () => {
    const div = document.createElement('div');
    Object.defineProperty(div, 'innerText', { value: '文本', configurable: true });

    expect(htmlElementAsString(div)).toBe('<div>文本</div>');
  });

  it('只有 class 时也能拼出 class 属性', () => {
    const span = document.createElement('span');
    span.className = 'tag';
    Object.defineProperty(span, 'innerText', { value: 'x', configurable: true });

    expect(htmlElementAsString(span)).toBe('<span class="tag">x</span>');
  });
});

describe('parseUrlToObj', () => {
  it('拆分出 host / path / protocol / relative', () => {
    expect(parseUrlToObj('https://example.com/user/list?page=1#top')).toEqual({
      host: 'example.com',
      path: '/user/list',
      protocol: 'https',
      relative: '/user/list?page=1#top',
    });
  });

  it('空值 / 非法输入返回空对象，不抛错', () => {
    expect(parseUrlToObj('')).toEqual({});
    expect(parseUrlToObj(undefined as unknown as string)).toEqual({});
  });

  it('带端口的地址 host 保留端口', () => {
    const parsed = parseUrlToObj('http://localhost:3000/detail');
    expect(parsed.protocol).toBe('http');
    expect(parsed.host).toBe('localhost:3000');
    expect(parsed.relative).toBe('/detail');
  });

  it('纯 hash 路由的相对地址保留 # 前缀', () => {
    expect(parseUrlToObj('#/home').relative).toBe('#/home');
  });
});

describe('setSilentFlag（silent* 开关）', () => {
  it('默认（不传配置）时所有事件都开启采集', () => {
    setSilentFlag();
    expect(getFlag(EventTypes.XHR)).toBe(false);
    expect(getFlag(EventTypes.FETCH)).toBe(false);
    expect(getFlag(EventTypes.CONSOLE)).toBe(false);
    expect(getFlag(EventTypes.ERROR)).toBe(false);
    expect(getFlag(WxAppEvents.AppOnError)).toBe(false);
  });

  it('silentXhr 只关闭 XHR，不影响 fetch', () => {
    setSilentFlag({ silentXhr: true });
    expect(getFlag(EventTypes.XHR)).toBe(true);
    expect(getFlag(EventTypes.FETCH)).toBe(false);
  });

  it('silentUnhandledrejection 同时作用于 web 与小程序两条链路', () => {
    setSilentFlag({ silentUnhandledrejection: true });
    expect(getFlag(EventTypes.UNHANDLEDREJECTION)).toBe(true);
    expect(getFlag(WxAppEvents.AppOnUnhandledRejection)).toBe(true);
  });

  it('小程序相关开关映射到对应的 wx 事件', () => {
    setSilentFlag({ silentWxOnError: true, silentWxOnPageNotFound: true });
    expect(getFlag(WxAppEvents.AppOnError)).toBe(true);
    expect(getFlag(WxAppEvents.AppOnPageNotFound)).toBe(true);
  });
});
