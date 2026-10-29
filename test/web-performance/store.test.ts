import { describe, it, expect } from 'vitest';
import MetricsStore from '../../packages/web-performance/src/lib/store';
import { metricsName } from '../../packages/web-performance/src/constants';

/**
 * MetricsStore 是 WebVitals 的唯一数据源（getCurrentMetrics 直接读它）。
 * 它的 clear / has 语义如果出错，会出现「指标重复上报」或「卸载时上报空对象」。
 */

describe('MetricsStore', () => {
  it('set 之后能 get / has 到，并保留引用', () => {
    const store = new MetricsStore();
    const metric = { name: metricsName.FP, value: 1200, score: 0.9 };

    store.set(metricsName.FP, metric);

    expect(store.has(metricsName.FP)).toBe(true);
    expect(store.get(metricsName.FP)).toBe(metric);
  });

  it('getValues 把 Map 摊平成 { [metricsName]: metric }', () => {
    const store = new MetricsStore();
    store.set(metricsName.FCP, { name: metricsName.FCP, value: 1500 });
    store.set(metricsName.LCP, { name: metricsName.LCP, value: 2500 });

    expect(store.getValues()).toEqual({
      [metricsName.FCP]: { name: metricsName.FCP, value: 1500 },
      [metricsName.LCP]: { name: metricsName.LCP, value: 2500 },
    });
  });

  it('重复 set 同一个 key 会覆盖，不会产生重复项', () => {
    const store = new MetricsStore();
    store.set(metricsName.CLS, { name: metricsName.CLS, value: 0.1 });
    store.set(metricsName.CLS, { name: metricsName.CLS, value: 0.2 });

    expect(Object.keys(store.getValues())).toEqual([metricsName.CLS]);
    expect(store.get(metricsName.CLS).value).toBe(0.2);
  });

  it('clear 之后所有指标清空（避免页面切走时重复上报）', () => {
    const store = new MetricsStore();
    store.set(metricsName.FP, { name: metricsName.FP, value: 1 });

    store.clear();

    expect(store.has(metricsName.FP)).toBe(false);
    expect(store.getValues()).toEqual({});
  });

  it('未设置过的 key 返回 undefined，不影响其它指标', () => {
    const store = new MetricsStore();
    expect(store.get(metricsName.FID)).toBeUndefined();
    expect(store.getValues()).toEqual({});
  });
});
