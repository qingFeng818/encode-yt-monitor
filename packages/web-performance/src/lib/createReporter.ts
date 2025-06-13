import { IMetrics, IReportHandler, IReportData, IMetricsObj } from '../types';

/**
 * @param {string} sessionId
 * @param {string} appId
 * @param {string} version
 * @param {Function} callback
 * @returns {IReportHandler}
 */
const createReporter =
  (sessionId: string, appId: string, version: string, callback: Function): IReportHandler =>
  (data: IMetrics | IMetricsObj) => {
    const reportData: IReportData = {
      sessionId,
      appId,
      version,
      data,
      timestamp: +new Date(),
    };

    if ('requestIdleCallback' in window) {
      //  requestIdleCallback 方法将一个函数放入队列，以便在浏览器空闲期间调用。不会影响动画和输入响应等延迟关键事件
      (window as any).requestIdleCallback(
        () => {
          callback(reportData);
        },
        { timeout: 3000 },
      );
    } else {
      callback(reportData);
    }
  };

export default createReporter;
