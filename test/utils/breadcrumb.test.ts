import { describe, it, expect, afterEach } from 'vitest';
import { breadcrumb } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, globalVar } from 'encode-yt-monitor-shared';
import { Severity } from 'encode-yt-monitor-utils';
import type { BreadcrumbPushData } from 'encode-yt-monitor-types';

/**
 * beforePushBreadcrumb 是业务方提供的钩子，必须被完全隔离：
 * 一旦它的异常向上冒泡，就会沿着 console 拦截 → breadcrumb.push → 钩子再抛错 形成自激。
 */

const makeCrumb = (): BreadcrumbPushData => ({
  type: BreadCrumbTypes.CONSOLE,
  data: { args: ['hello'], level: 'log' },
  level: Severity.Info,
});

const defaultIsLogAddBreadcrumb = globalVar.isLogAddBreadcrumb;

afterEach(() => {
  breadcrumb.clear();
  breadcrumb.beforePushBreadcrumb = null;
  breadcrumb.maxBreadcrumbs = 10;
  globalVar.isLogAddBreadcrumb = defaultIsLogAddBreadcrumb;
});

describe('breadcrumb.push 钩子健壮性（beforePushBreadcrumb）', () => {
  it('钩子抛错时只丢弃本条面包屑，不向调用方抛异常', () => {
    breadcrumb.beforePushBreadcrumb = () => {
      throw new Error('beforePushBreadcrumb boom');
    };

    expect(() => breadcrumb.push(makeCrumb())).not.toThrow();
    expect(breadcrumb.getStack()).toHaveLength(0);
    // 静默作用域必须被正确退出，否则后续 console 面包屑会被永久吞掉
    expect(globalVar.isLogAddBreadcrumb).toBe(true);
  });

  it('钩子抛错后，后续正常 push 依然能记录（开关已恢复）', () => {
    breadcrumb.beforePushBreadcrumb = () => {
      throw new Error('boom once');
    };
    breadcrumb.push(makeCrumb());
    expect(breadcrumb.getStack()).toHaveLength(0);

    breadcrumb.beforePushBreadcrumb = null;
    breadcrumb.push(makeCrumb());
    expect(breadcrumb.getStack()).toHaveLength(1);
  });

  it('钩子返回新对象时以返回值入库，返回空值时丢弃', () => {
    breadcrumb.beforePushBreadcrumb = (_breadcrumb: unknown, data: BreadcrumbPushData) => ({
      ...data,
      category: 'rewritten',
    });
    breadcrumb.push(makeCrumb());
    expect(breadcrumb.getStack()[0].category).toBe('rewritten');

    breadcrumb.beforePushBreadcrumb = () => null;
    breadcrumb.push(makeCrumb());
    expect(breadcrumb.getStack()).toHaveLength(1);
  });
});
