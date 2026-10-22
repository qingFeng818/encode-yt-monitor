import { StaticTypes } from 'encode-yt-monitor-shared';
import { ReportDataPvUv } from 'encode-yt-monitor-types';
import { transportData } from 'encode-yt-monitor-core';
import {
  _global,
  getLocationHref,
  getTimestamp,
  logger,
  Severity,
  validateOption,
} from 'encode-yt-monitor-utils';
import { VueInstance, VueMonitorOptions, VueRoute, VueRouter } from './types';

/**
 * 已经注册过 afterEach 的 router。
 * 用数组而不是 WeakSet，保证 es5 产物在低版本浏览器里也能运行；
 * 页面生命周期内 router 实例数量极少，不会有内存问题。
 */

const DEFAULT_REPORT_INTERVAL = 1000 * 60 * 60;
const DEFAULT_REPORT_COUNT = 10;
const PENDING_STORAGE_KEY = 'encode-yt-monitor-pv-uv-pending';

class PVReport {
  platform: string = 'web';
  isFirstPV: boolean = true;
  lastReportTime: number | undefined;
  reportInterval: number = DEFAULT_REPORT_INTERVAL;
  reportCount: number = DEFAULT_REPORT_COUNT;
  isLifecycleBound: boolean = false;
  detachLifecycle: () => void | undefined;
  reportData: Map<string, ReportDataPvUv> = new Map();
  constructor(options?: VueMonitorOptions) {
    if (options) {
      this.initOptions(options);
    }
  }

  initOptions(options?: VueMonitorOptions) {
    if (!options) return;
    if (validateOption(options.reportCount, 'reportCount', 'number')) {
      this.reportCount = options.reportCount;
    }
    if (validateOption(options.reportInterval, 'reportInterval', 'number')) {
      this.reportInterval = options.reportInterval;
    }
  }

  /**
   * 未上报 PV/UV 的本地备份 key。
   *
   * 浏览器崩溃 / 被系统杀掉时不会再触发 pagehide，内存里的聚合数据只能靠备份兜底：
   * 写入 sessionStorage 后，下一次进入站点时补发；正常 flush 后立即删除，不会重复上报。
   */

  getSessionStorage(): Storage | undefined {
    try {
      // 隐私模式 / 禁用站点数据时，访问 sessionStorage 本身就可能抛错
      return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
    } catch (error) {
      return undefined;
    }
  }

  /** 把当前聚合结果写入 sessionStorage，供崩溃 / 被系统杀掉后补发 */
  persistPending(): void {
    const storage = this.getSessionStorage();
    if (!storage) return;
    try {
      if (this.reportData.size === 0) {
        storage.removeItem(PENDING_STORAGE_KEY);
        return;
      }
      storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(Array.from(this.reportData.values())));
    } catch (error) {
      // 存储被禁用 / 写满：备份失败不能影响正常上报流程
    }
  }
  clearPersisted(): void {
    const storage = this.getSessionStorage();
    if (!storage) return;
    try {
      storage.removeItem(PENDING_STORAGE_KEY);
    } catch (error) {
      // 存储不可用时忽略
    }
  }
  readPersisted(): ReportDataPvUv[] {
    const storage = this.getSessionStorage();
    if (!storage) return [];
    try {
      const raw = storage.getItem(PENDING_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item) => item && typeof item === 'object');
    } catch (error) {
      // 内容被其它代码改坏时直接丢弃，避免每次启动都解析失败
      this.clearPersisted();
      return [];
    }
  }

  getPageTitle(): string {
    try {
      return typeof document !== 'undefined' && document ? document.title || '' : '';
    } catch (error) {
      return '';
    }
  }
  /**
   * 聚合 key：路由 + 类型。
   * 同一个路由在聚合窗口内多次访问合并成一条，用 count 记录次数。
   */
  getDataKey(data: ReportDataPvUv): string {
    return `${data.to || data.message || ''}${data.type || ''}`;
  }
  mergeReportData(data: ReportDataPvUv): void {
    const key = this.getDataKey(data);
    const oldData = this.reportData.get(key);
    if (!oldData) {
      this.reportData.set(key, data);
    } else {
      this.reportData.set(key, {
        ...oldData,
        count: (oldData.count || 1) + (data.count || 1),
      });
    }
    // 崩溃 / 被系统杀掉时浏览器不会触发 pagehide，这里同步写一份备份供下次补发
    this.persistPending();
  }
  /**
   * 把当前聚合的数据一次性发出去。
   * 先取出快照再清空，保证发送失败也不会把数据留在缓存里反复重试。
   * @param unload 页面隐藏 / 卸载场景：强制走 sendBeacon 并同步清空队列
   */
  flushPvUv(unload = false): void {
    if (this.reportData.size === 0) return;
    this.lastReportTime = getTimestamp();
    const data = Array.from(this.reportData.values());
    this.reportData.clear();
    // 数据已经交给上报层，本地备份同步清掉，避免下次启动重复补发
    this.clearPersisted();
    if (unload) {
      try {
        transportData.sendPvUvOnUnload(data);
      } catch (error) {
        logger.error('Vue PV/UV 卸载上报失败：', error);
      }
      return;
    }
    // sendPvUv 是异步方法，内部已兜底 beforePost 的异常，这里再兜底请求分发阶段的异常，
    // 避免监控自身抛出 unhandledrejection 被再次采集
    const result = transportData.sendPvUv(data);
    if (result && typeof result.catch === 'function') {
      result.catch((error) => logger.error('Vue PV/UV 上报失败：', error));
    }
  }

  /**
   * 补发上一次页面崩溃 / 被系统杀掉时残留在 sessionStorage 里的数据。
   * 没有配置 trackDsn 时保留备份，等用户真正开启埋点后再补发。
   */
  restorePending(): void {
    const pending = this.readPersisted();
    if (pending.length === 0) return;
    if (!transportData.trackDsn) return;
    this.clearPersisted();
    const result = transportData.sendPvUv(pending);
    if (result && typeof result.catch === 'function') {
      result.catch((error) => logger.error('Vue PV/UV 补发失败：', error));
    }
  }
  /**
   * 注册页面生命周期兜底：隐藏 / 卸载 / 关闭前把未上报的聚合数据发出去。
   *
   * - visibilitychange(hidden)：覆盖率最高（切 tab、锁屏、关闭、移动端切后台），
   *   页面随后可能被系统直接销毁，因此统一走 sendBeacon，避免 XHR 被中断；
   * - pagehide / beforeunload：桌面端关闭、刷新、跳转的兜底；
   * - 聚合缓存为空时不会发送，三个事件重复触发也不会重复上报。
   */
  bindPvUvLifecycle(): void {
    if (this.isLifecycleBound) return;
    const globalObj = _global as any;
    const doc = globalObj && globalObj.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    this.isLifecycleBound = true;

    const onVisibilityChange = () => {
      if (doc.visibilityState === 'hidden') this.flushPvUv(true);
    };
    const onPageUnload = () => this.flushPvUv(true);
    const useWindow = typeof globalObj.addEventListener === 'function';

    doc.addEventListener('visibilitychange', onVisibilityChange, true);
    if (useWindow) {
      globalObj.addEventListener('pagehide', onPageUnload, true);
      globalObj.addEventListener('beforeunload', onPageUnload, true);
    }

    this.detachLifecycle = () => {
      doc.removeEventListener('visibilitychange', onVisibilityChange, true);
      if (useWindow && typeof globalObj.removeEventListener === 'function') {
        globalObj.removeEventListener('pagehide', onPageUnload, true);
        globalObj.removeEventListener('beforeunload', onPageUnload, true);
      }
    };

    // 进来就把上次异常退出残留的数据补发掉
    try {
      this.restorePending();
    } catch (error) {
      // 补发失败不能影响采集本身的初始化
      logger.error('Vue PV/UV 崩溃补发失败', error);
    }
  }

  /**
   * 上报一次页面 PV（首次访问额外产生一条 UV）
   * @param to 目标路由
   * @param from 来源路由
   */
  handlePV(to?: string, from?: string, name?: string): void {
    const now = getTimestamp();
    const data: ReportDataPvUv = {
      type: StaticTypes.PV,
      message: to,
      url: getLocationHref(),
      level: Severity.Info,
      time: now,
      from: from,
      to: to,
      title: this.getPageTitle(),
      name: to,
      isTrackData: true,
      count: 1,
    };
    if (this.isFirstPV) {
      this.isFirstPV = false;
      data.isUv = true;
    }
    this.mergeReportData(data);

    // 第一次采集时开始计算聚合窗口
    if (this.lastReportTime === undefined) this.lastReportTime = now;
    if (this.reportData.size < this.reportCount && now - this.lastReportTime < this.reportInterval)
      return;
    this.flushPvUv();
  }
}

export default PVReport;
