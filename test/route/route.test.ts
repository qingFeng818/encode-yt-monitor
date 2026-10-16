import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HandleEvents } from '../../packages/browser/src/handleEvents';
import { breadcrumb } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, BreadCrumbCategory } from 'encode-yt-monitor-shared';

describe('路由行为采集（history / hashchange，仅面包屑）', () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  it('history 跳转应记 ROUTE 面包屑并解析相对路径', () => {
    HandleEvents.handleHistory({
      from: 'https://example.com/home',
      to: 'https://example.com/user/123?tab=info',
    });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const crumb = pushSpy.mock.calls[0][0];
    expect(crumb.type).toBe(BreadCrumbTypes.ROUTE);
    expect(crumb.category).toBe(BreadCrumbCategory.USER);
    expect(crumb.data.from).toBe('/home');
    expect(crumb.data.to).toBe('/user/123?tab=info');
  });

  it('hashchange 应记 ROUTE 面包屑', () => {
    const ev = new HashChangeEvent('hashchange', {
      oldURL: 'https://example.com/#/list',
      newURL: 'https://example.com/#/detail/1',
    });
    HandleEvents.handleHashchange(ev);

    const crumb = pushSpy.mock.calls[0][0];
    expect(crumb.type).toBe(BreadCrumbTypes.ROUTE);
    expect(crumb.data.to).toContain('detail');
  });
});
