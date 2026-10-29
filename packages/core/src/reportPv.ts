import { StaticTypes } from 'encode-yt-monitor-shared';
import { ReportDataPvUv, ReportPvOptions } from 'encode-yt-monitor-types';
import { transportData } from './transportData';
import {
  _global,
  getLocationHref,
  getTimestamp,
  logger,
  Severity,
  validateOption,
} from 'encode-yt-monitor-utils';

/** PV/UV 聚合上报间隔（毫秒），默认 1 小时 */
const DEFAULT_REPORT_INTERVAL = 1000 * 60 * 60;
/** PV/UV 聚合条数阈值，默认 10 条 */
const DEFAULT_REPORT_COUNT = 10;
/** 未上报 PV/UV 的本地备份 key */
const PENDING_STORAGE_KEY = 'encode-yt-monitor-pv-uv-pending';

/** handlePV 的可选参数 */
export interface HandlePvOptions {
  /** 页面名称（如 vue-router 的 route.name），未传时不写入报文 */
  name?: string;
  /** 页面标题，未传时取 document.title */
  title?: string;
}

/**
 * PV/UV 采集与聚合上报，浏览器 / Vue 共用。
 *
 * 1. 首次调用 handlePV 时额外产生一条 UV，之后只产生 PV；
 * 2. 同一个「路由 + 类型」在聚合窗口内合并成一条，用 count 累加访问次数；
 * 3. 满足 reportCount 或 reportInterval 任一条件即上报；
 * 4. 页面隐藏 / 卸载前兜底上报；聚合中的数据同步备份到 sessionStorage，
 *    页面崩溃 / 被系统杀掉后下次进入时补发。
 */
class ReportPv {
  /** 是否还没上报过 UV（每次页面加载只有首次 PV 计 UV） */
  isUv: boolean = true;
  /** 上次上报时间戳（毫秒） */
  lastReportTime: number | undefined;
  /** 聚合上报间隔（毫秒） */
  reportInterval: number = DEFAULT_REPORT_INTERVAL;
  /** 聚合上报条数阈值 */
  reportCount: number = DEFAULT_REPORT_COUNT;
  /** 是否已绑定页面生命周期 */
  isLifecycleBound: boolean = false;
  /** 解绑页面生命周期（destroy 时调用） */
  detachLifecycle?: () => void;
  /** 聚合中的 PV/UV 数据，key 为「路由|类型」 */
  reportData: Map<string, ReportDataPvUv> = new Map();

  constructor(options?: ReportPvOptions) {
    this.bindPvUvLifecycle();
    if (options) {
      this.bindOptions(options);
    }
  }

  /**
   * 应用 PV/UV 上报配置
   * @param options.reportCount 聚合条数阈值，小于 1 时按 1 处理
   * @param options.reportInterval 聚合间隔（毫秒），小于 0 时按 0 处理
   */
  bindOptions(options?: ReportPvOptions): void {
    if (!options) return;
    const { reportCount, reportInterval } = options;
    // NaN / Infinity 也是 number 类型，必须额外排除，否则聚合条件永远不成立
    if (validateOption(reportCount, 'reportCount', 'number') && isFinite(reportCount as number)) {
      this.reportCount = Math.max(1, Math.floor(reportCount as number));
    }
    if (
      validateOption(reportInterval, 'reportInterval', 'number') &&
      isFinite(reportInterval as number)
    ) {
      this.reportInterval = Math.max(0, reportInterval as number);
    }
  }

  /** 取 sessionStorage；隐私模式 / 禁用站点数据时访问本身就可能抛错 */
  getSessionStorage(): Storage | undefined {
    try {
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
      // 只接受 PV/UV 记录，避免备份内容被其它代码写脏后把垃圾数据上报出去
      return parsed.filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          (item.type === StaticTypes.PV || item.type === StaticTypes.UV),
      );
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
   * 用 | 分隔，避免路径与类型直接拼接后撞 key。
   */
  getDataKey(data: ReportDataPvUv): string {
    return `${data.to || data.message || ''}|${data.type || ''}`;
  }

  /**
   * 把一条数据合并进聚合缓存：
   * 同一 key 已存在时只累加 count，保留首次采集的 from / title / time
   */
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
    try {
      if (unload) {
        transportData.sendPvUvOnUnload(data);
        return;
      }
      // sendPvUv 是异步方法，内部已兜底 beforePost 的异常，
      // 这里再兜底同步抛错 / Promise reject，避免监控自身异常打断业务的路由跳转
      const result = transportData.sendPvUv(data);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => logger.error('PV/UV 上报失败：', error));
      }
    } catch (error) {
      logger.error('PV/UV 上报失败：', error);
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
    try {
      const result = transportData.sendPvUv(pending);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => logger.error('PV/UV 补发失败：', error));
      }
    } catch (error) {
      logger.error('PV/UV 补发失败：', error);
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
      logger.error('PV/UV 崩溃补发失败', error);
    }
  }

  /**
   * 停止采集并解绑全局监听（单测重置 / 需要彻底重建采集器时使用）。
   * 内存中未上报的聚合数据会一并丢弃；崩溃备份（sessionStorage）保持不动。
   */
  destroy(): void {
    if (typeof this.detachLifecycle === 'function') this.detachLifecycle();
    this.detachLifecycle = undefined;
    this.isLifecycleBound = false;
    this.reportData.clear();
    this.isUv = true;
    this.lastReportTime = undefined;
  }

  /**
   * 上报一次页面 PV；页面加载后的首次调用会额外产生一条 UV。
   * @param to 目标路由（完整路径）
   * @param from 来源路由（完整路径）
   * @param options.name 页面名称，通常是 vue-router 的 route.name
   * @param options.title 页面标题，不传时取 document.title
   */
  handlePV(to?: string, from?: string, options?: HandlePvOptions): void {
    const now = getTimestamp();
    const pvData: ReportDataPvUv = {
      type: StaticTypes.PV,
      message: to,
      url: getLocationHref(),
      level: Severity.Info,
      time: now,
      from,
      to,
      title: options?.title || this.getPageTitle(),
      name: options?.name,
      isTrackData: true,
      count: 1,
    };
    this.mergeReportData(pvData);
    if (this.isUv) {
      this.isUv = false;
      // 首屏额外产生一条 UV：服务端按 type 区分 PV / UV，与既有上报协议保持一致
      this.mergeReportData({ ...pvData, type: StaticTypes.UV, isUv: true });
    }

    // 第一次采集时开始计算聚合窗口
    if (this.lastReportTime === undefined) this.lastReportTime = now;
    if (this.reportData.size < this.reportCount && now - this.lastReportTime < this.reportInterval)
      return;
    this.flushPvUv();
  }
}

export { ReportPv };
