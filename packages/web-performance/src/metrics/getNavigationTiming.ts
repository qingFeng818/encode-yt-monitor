/**
 * Page loads waterfall stream
 * dns lookup = domainLookupEnd - domainLookupStart
 * initial connection = connectEnd - connectStart
 * ssl = connectEnd - secureConnectionStart
 * ttfb = responseStart - requestStart
 * content download = responseEnd - responseStart
 * dom parse = domInteractive - responseEnd
 * defer execute duration = domContentLoadedEventStart - domInteractive
 * domContentLoadedCallback = domContentLoadedEventEnd - domContentLoadedEventStart
 * resource load = loadEventStart - domContentLoadedEventEnd
 * dom Ready = domContentLoadedEventEnd - fetchStart
 * page load = loadEventStart - fetchStart
 * */
import { IMetrics, IPerformanceNavigationTiming, IReportHandler } from '../types';
import { isPerformanceSupported, isPerformanceObserverSupported } from '../utils/isSupported';
import { metricsName } from '../constants';
import metricsStore from '../lib/store';
import observe from '../lib/observe';
import { roundByFour, validNumber } from '../utils';

const getNavigationTiming = (): Promise<IPerformanceNavigationTiming> | undefined => {
  if (!isPerformanceSupported()) {
    console.warn('browser do not support performance');
    return;
  }

  const resolveNavigationTiming = (entry: PerformanceNavigationTiming, resolve): void => {
    const {
      domainLookupStart,
      domainLookupEnd,
      connectStart,
      connectEnd,
      secureConnectionStart,
      requestStart,
      responseStart,
      responseEnd,
      domInteractive,
      domContentLoadedEventStart,
      domContentLoadedEventEnd,
      loadEventStart,
      fetchStart,
    } = entry;

    resolve({
      dnsLookup: roundByFour(domainLookupEnd - domainLookupStart), // dns查询耗时
      initialConnection: roundByFour(connectEnd - connectStart), // tcp 连接耗时
      ssl: secureConnectionStart ? roundByFour(connectEnd - secureConnectionStart) : 0, // ssl 连接耗时
      ttfb: roundByFour(responseStart - requestStart), // 请求响应耗时
      contentDownload: roundByFour(responseEnd - responseStart), // 内容传输耗时
      domParse: roundByFour(domInteractive - responseEnd), // dom解析耗时
      deferExecuteDuration: roundByFour(domContentLoadedEventStart - domInteractive),
      domContentLoadedCallback: roundByFour(domContentLoadedEventEnd - domContentLoadedEventStart),
      resourceLoad: roundByFour(loadEventStart - domContentLoadedEventEnd), // 资源加载耗时
      domReady: roundByFour(domContentLoadedEventEnd - fetchStart), // dom ready
      pageLoad: roundByFour(loadEventStart - fetchStart), // 页面加载耗时
    });
  };

  return new Promise((resolve) => {
    if (
      isPerformanceObserverSupported() &&
      PerformanceObserver.supportedEntryTypes?.includes('navigation')
    ) {
      const entryHandler = (entry: PerformanceNavigationTiming) => {
        if (entry.entryType === 'navigation') {
          if (po) {
            po.disconnect();
          }

          resolveNavigationTiming(entry, resolve);
        }
      };

      const po = observe('navigation', entryHandler);
    } else {
      const navigation =
        performance.getEntriesByType('navigation').length > 0
          ? performance.getEntriesByType('navigation')[0]
          : performance.timing;
      resolveNavigationTiming(navigation as PerformanceNavigationTiming, resolve);
    }
  });
};

/**
 * @param {metricsStore} store
 * @param {Function} report
 * @param {boolean} immediately, if immediately is true,data will report immediately
 * */
export const initNavigationTiming = (
  store: metricsStore,
  report: IReportHandler,
  immediately = true,
): void => {
  getNavigationTiming()?.then((navigationTiming) => {
    const metrics = { name: metricsName.NT, value: navigationTiming } as IMetrics;

    if (validNumber(Object?.values(metrics.value))) {
      store.set(metricsName.NT, metrics);

      if (immediately) {
        report(metrics);
      }
    }
  });
};
