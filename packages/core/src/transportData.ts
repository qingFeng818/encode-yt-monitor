import {
  _support,
  _global,
  validateOption,
  logger,
  isBrowserEnv,
  isWxMiniEnv,
  variableTypeDetection,
  Queue,
  isEmpty,
} from 'encode-yt-monitor-utils';
import { createErrorId } from './errorId';
import { SDK_NAME, SDK_VERSION } from 'encode-yt-monitor-shared';
import { breadcrumb } from './breadcrumb';
import {
  AuthInfo,
  TransportDataType,
  EMethods,
  InitOptions,
  isReportDataType,
  DeviceInfo,
  FinalReportType,
  BatchTransportDataType,
} from 'encode-yt-monitor-types';

/** 单条上报请求超时（ms）：避免挂死的请求长期占用队列的并发槽位 */
const REPORT_REQUEST_TIMEOUT = 10 * 1000;

export class TransportData {
  queue: Queue;
  beforeDataReport: unknown = null;
  backTrackerId: unknown = null;
  configReportXhr: unknown = null;
  configReportUrl: unknown = null;
  configReportWxRequest: unknown = null;
  useImgUpload = false;
  apikey = '';
  trackKey = '';
  errorDsn = '';
  trackDsn = '';
  /** 批量上报开关，默认关闭，保持「一条数据一个请求」的原有协议 */
  enableBatch = false;
  /** 攒够多少条立即发送 */
  batchSize = 5;
  /** 批量上报的最大等待时间（ms），到点即使没攒够 batchSize 也会发送 */
  batchDelay = 2000;
  /** dsn -> 待合并的报文；按 dsn 分组，避免错误与埋点串到同一个上报地址 */
  private batchBuffer: Map<string, TransportDataType[]> = new Map();
  private batchTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isBatchFlushBound = false;
  /** 页面是否正在卸载：此时 XHR 可能被浏览器中断，改走 sendBeacon */
  private isUnloading = false;
  constructor() {
    this.queue = new Queue();
  }

  imgRequest(data: any, url: string): void {
    const requestFun = (): Promise<void> =>
      new Promise<void>((resolve) => {
        // 先序列化：失败（循环引用等）直接 reject，交给队列 onError 处理，不留下定时器
        const payload = encodeURIComponent(JSON.stringify(data));
        const img = new Image();
        const spliceStr = url.indexOf('?') === -1 ? '?' : '&';
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          if (timer !== undefined) clearTimeout(timer);
          img.onload = null;
          img.onerror = null;
          resolve();
        };
        // 图片可能因网络/拦截一直不回调，超时兜底释放并发槽位
        timer = setTimeout(done, REPORT_REQUEST_TIMEOUT);
        img.onload = done;
        img.onerror = done;
        img.src = `${url}${spliceStr}data=${payload}`;
      });
    this.queue.addFn(requestFun);
  }

  getRecord(): any[] {
    const recordData = _support.record;
    if (recordData && variableTypeDetection.isArray(recordData) && recordData.length > 2) {
      return recordData;
    }
    return [];
  }

  getDeviceInfo(): DeviceInfo | any {
    return _support.deviceInfo || {};
  }

  async beforePost(data: FinalReportType) {
    if (isReportDataType(data)) {
      const errorId = createErrorId(data, this.apikey);
      if (!errorId) return false;
      data.errorId = errorId;
    }
    let transportData = this.getTransportData(data);
    if (typeof this.beforeDataReport === 'function') {
      transportData = await this.beforeDataReport(transportData);
      if (!transportData) return false;
    }
    return transportData;
  }

  async xhrPost(data: any, url: string) {
    const requestFun = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const body = JSON.stringify(data);
        // 页面正在卸载：XHR 很可能被浏览器中断，改用 sendBeacon 保证送达
        if (this.isUnloading && this.sendByBeacon(url, body)) {
          resolve();
          return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open(EMethods.Post, url);
        xhr.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
        xhr.withCredentials = true;
        // 成功 / 失败 / 超时 / 中断都会触发 loadend，用它作为「请求结束」信号释放并发槽位
        xhr.timeout = REPORT_REQUEST_TIMEOUT;
        const done = () => resolve();
        if (typeof xhr.addEventListener === 'function') {
          xhr.addEventListener('loadend', done);
        } else {
          xhr.onloadend = done;
        }
        if (typeof this.configReportXhr === 'function') {
          this.configReportXhr(xhr, data);
        }
        xhr.send(body);
      });
    this.queue.addFn(requestFun);
  }

  /** 卸载场景的兜底上报；返回 false 表示不支持或发送失败，调用方继续走 XHR */
  private sendByBeacon(url: string, body: string): boolean {
    try {
      const globalObj = _global as any;
      const nav = globalObj && globalObj.navigator;
      if (!nav || typeof nav.sendBeacon !== 'function') return false;
      const payload =
        typeof Blob !== 'undefined' ? new Blob([body], { type: 'application/json' }) : body;
      return nav.sendBeacon(url, payload) !== false;
    } catch (err) {
      return false;
    }
  }

  async wxPost(data: any, url: string) {
    const requestFun = (): Promise<void> =>
      new Promise<void>((resolve) => {
        let requestOptions = { method: 'POST' } as WechatMiniprogram.RequestOption;
        if (typeof this.configReportWxRequest === 'function') {
          const params = this.configReportWxRequest(data);
          requestOptions = { ...requestOptions, ...params };
        }
        const userComplete = requestOptions.complete;
        requestOptions = {
          ...requestOptions,
          data: JSON.stringify(data),
          url,
          // 成功 / 失败都会回调 complete，用它释放并发槽位
          complete: (res: any) => {
            try {
              userComplete?.(res);
            } finally {
              resolve();
            }
          },
        };
        wx.request(requestOptions);
      });
    this.queue.addFn(requestFun);
  }

  getAuthInfo(): AuthInfo {
    const trackerId = this.getTrackerId();
    const result: AuthInfo = {
      trackerId: String(trackerId),
      sdkVersion: SDK_VERSION,
      sdkName: SDK_NAME,
    };
    this.apikey && (result.apikey = this.apikey);
    this.trackKey && (result.trackKey = this.trackKey);
    return result;
  }

  getApikey() {
    return this.apikey;
  }

  getTrackKey() {
    return this.trackKey;
  }

  getTrackerId(): string | number {
    if (typeof this.backTrackerId === 'function') {
      const trackerId = this.backTrackerId();
      if (typeof trackerId === 'string' || typeof trackerId === 'number') {
        return trackerId;
      } else {
        logger.error(
          `trackerId:${trackerId} 期望 string 或 number 类型，但是传入类型为 ${typeof trackerId}`,
        );
      }
    }
    return '';
  }

  getTransportData(data: FinalReportType): TransportDataType {
    return {
      authInfo: this.getAuthInfo(),
      breadcrumb: breadcrumb.getStack(),
      data,
      record: this.getRecord(),
      deviceInfo: this.getDeviceInfo(),
    };
  }

  isSdkTransportUrl(targetUrl: string): boolean {
    let isSdkDsn = false;
    if (this.errorDsn && targetUrl.indexOf(this.errorDsn) !== -1) {
      isSdkDsn = true;
    }
    if (this.trackDsn && targetUrl.indexOf(this.trackDsn) !== -1) {
      isSdkDsn = true;
    }
    return isSdkDsn;
  }

  /**
   * 单条 / 批量上报的分发入口。
   *
   * 批量上报的本质：把同一个 dsn 下的多条「完整单条报文」攒起来，
   * 攒够 batchSize 或等待 batchDelay 后合并成一个请求发出，减少请求数与瞬时并发。
   */
  dispatchReport(dsn: string, reportData: TransportDataType): void {
    // 未开启批量、图片上报（GET query 无法合并）、非浏览器/小程序环境：维持单条上报
    if (!this.enableBatch || this.useImgUpload || !(isBrowserEnv || isWxMiniEnv)) {
      this.postReport(dsn, reportData);
      return;
    }
    const batch = this.batchBuffer.get(dsn) || [];
    batch.push(reportData);
    this.batchBuffer.set(dsn, batch);
    if (this.batchSize > 0 && batch.length >= this.batchSize) {
      this.flushBatch(dsn);
      return;
    }
    this.startBatchTimer(dsn);
  }

  /** 立即发送所有缓冲中的批量数据（页面卸载前 / 手动触发） */
  flushBatches(): void {
    Array.from(this.batchBuffer.keys()).forEach((dsn) => this.flushBatch(dsn));
  }

  /**
   * 批量数据靠定时器延迟发出，页面一旦隐藏/卸载，定时器可能永远不再触发，
   * 这里在卸载前把缓冲中的数据发出去，避免丢数据。
   */
  bindBatchFlushOnHidden(): void {
    if (this.isBatchFlushBound || !isBrowserEnv) return;
    const globalObj = _global as any;
    const doc = globalObj && globalObj.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    this.isBatchFlushBound = true;
    // 隐藏 / 卸载前把批量缓冲发出去；卸载场景没有下一次微任务机会，需要同步执行队列
    const flush = (force: boolean) => {
      this.flushBatches();
      // 页面只是隐藏（切 tab / 切后台）→ 仍按并发上限发送，避免一次性打出一堆请求；
      // 真正卸载 → 没有下一次机会，忽略上限同步发出（配合 sendBeacon）
      force ? this.queue.flushNow() : this.queue.flushStack();
    };
    const onPageHide = () => {
      this.isUnloading = true;
      flush(true);
    };
    doc.addEventListener(
      'visibilitychange',
      () => {
        if (doc.visibilityState === 'hidden') flush(false);
      },
      true,
    );
    if (typeof globalObj.addEventListener === 'function') {
      globalObj.addEventListener('pagehide', onPageHide, true);
      globalObj.addEventListener('beforeunload', onPageHide, true);
      // 从 bfcache 恢复后重新走 XHR（pagehide 并不代表页面一定被销毁）
      globalObj.addEventListener('pageshow', () => (this.isUnloading = false), true);
    }
  }

  private postReport(dsn: string, payload: TransportDataType | BatchTransportDataType): void {
    if (isBrowserEnv) {
      this.useImgUpload ? this.imgRequest(payload, dsn) : this.xhrPost(payload, dsn);
      return;
    }
    if (isWxMiniEnv) {
      this.wxPost(payload, dsn);
    }
  }

  private startBatchTimer(dsn: string): void {
    if (this.batchTimers.has(dsn)) return;
    const timer = setTimeout(
      () => {
        this.batchTimers.delete(dsn);
        this.flushBatch(dsn);
      },
      Math.max(this.batchDelay, 0),
    );
    // Node / SSR 环境下不要因为等待批量上报而阻止进程退出
    typeof (timer as any).unref === 'function' && (timer as any).unref();
    this.batchTimers.set(dsn, timer);
  }

  private flushBatch(dsn: string): void {
    const timer = this.batchTimers.get(dsn);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.batchTimers.delete(dsn);
    }
    const batch = this.batchBuffer.get(dsn);
    if (!batch || batch.length === 0) return;
    this.batchBuffer.delete(dsn);
    // 只有一条时沿用原来的单条协议，服务端不需要感知 batch 字段
    if (batch.length === 1) {
      this.postReport(dsn, batch[0]);
      return;
    }
    const payload: BatchTransportDataType = {
      authInfo: this.getAuthInfo(),
      batch: true,
      count: batch.length,
      data: batch,
    };
    this.postReport(dsn, payload);
  }

  bindOptions(options: InitOptions = {}): void {
    const {
      dsn,
      beforeDataReport,
      apikey,
      configReportXhr,
      backTrackerId,
      trackDsn,
      trackKey,
      configReportUrl,
      useImgUpload,
      configReportWxRequest,
      enableBatch,
      batchSize,
      batchDelay,
    } = options;
    validateOption(apikey, 'apikey', 'string') && (this.apikey = apikey);
    validateOption(trackKey, 'trackKey', 'string') && (this.trackKey = trackKey);
    validateOption(dsn, 'dsn', 'string') && (this.errorDsn = dsn);
    validateOption(trackDsn, 'trackDsn', 'string') && (this.trackDsn = trackDsn);
    validateOption(useImgUpload, 'useImgUpload', 'boolean') && (this.useImgUpload = useImgUpload);
    validateOption(enableBatch, 'enableBatch', 'boolean') && (this.enableBatch = enableBatch);
    validateOption(batchSize, 'batchSize', 'number') && (this.batchSize = batchSize);
    validateOption(batchDelay, 'batchDelay', 'number') && (this.batchDelay = batchDelay);
    validateOption(beforeDataReport, 'beforeDataReport', 'function') &&
      (this.beforeDataReport = beforeDataReport);
    validateOption(configReportXhr, 'configReportXhr', 'function') &&
      (this.configReportXhr = configReportXhr);
    validateOption(backTrackerId, 'backTrackerId', 'function') &&
      (this.backTrackerId = backTrackerId);
    validateOption(configReportUrl, 'configReportUrl', 'function') &&
      (this.configReportUrl = configReportUrl);
    validateOption(configReportWxRequest, 'configReportWxRequest', 'function') &&
      (this.configReportWxRequest = configReportWxRequest);
  }

  /**
   * 监控错误上报的请求函数
   * @param data 错误上报数据格式
   * @returns
   */
  async send(data: FinalReportType) {
    let dsn = '';
    if (isReportDataType(data)) {
      dsn = this.errorDsn;
      if (isEmpty(dsn)) {
        logger.error('dsn为空，没有传入监控错误上报的dsn地址，请在init中传入');
        return;
      }
    } else {
      dsn = this.trackDsn;
      if (isEmpty(dsn)) {
        logger.error('trackDsn为空，没有传入埋点上报的dsn地址，请在init中传入');
        return;
      }
    }
    const result = await this.beforePost(data);
    if (!result) return;
    if (typeof this.configReportUrl === 'function') {
      dsn = this.configReportUrl(result, dsn);
      if (!dsn) return;
    }

    this.dispatchReport(dsn, result);
  }
}

const transportData = _support.transportData || (_support.transportData = new TransportData());

export { transportData };
