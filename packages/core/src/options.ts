import { InitOptions, QueueOptions } from 'encode-yt-monitor-types';
import {
  generateUUID,
  toStringValidateOption,
  validateOption,
  _support,
  setSilentFlag,
  logger,
} from 'encode-yt-monitor-utils';
import { breadcrumb } from './breadcrumb';
import { transportData } from './transportData';
export class Options {
  beforeAppAjaxSend: Function = () => {};
  enableTraceId: Boolean;
  filterXhrUrlRegExp: RegExp;
  includeHttpUrlTraceIdRegExp: RegExp;
  traceIdFieldName = 'Trace-Id';
  throttleDelayTime = 0;
  // 同一个错误在多长时间内只上报一次（单位：秒），超过该间隔后即可再次上报
  errorIntervalTime = 30;
  // 错误指纹缓存（allErrorNumber）最大条目数，超过后按 LRU 淘汰队首，避免内存只增不减
  maxErrorNumberSize = 1000;
  // 是否上报静态资源PV、UV
  isReportStatic = false;
  // wx-mini
  appOnLaunch: Function = () => {};
  appOnShow: Function = () => {};
  onPageNotFound: Function = () => {};
  appOnHide: Function = () => {};
  pageOnUnload: Function = () => {};
  pageOnShow: Function = () => {};
  pageOnHide: Function = () => {};
  onShareAppMessage: Function = () => {};
  onShareTimeline: Function = () => {};
  onTabItemTap: Function = () => {};
  // need return opitons，so defaul value is undefined
  wxNavigateToMiniProgram: Function;
  triggerWxEvent: Function = () => {};
  onRouteChange?: Function;

  queueOptions: QueueOptions = {
    maxConcurrent: 5,
    onError: console.error,
  };

  constructor() {
    this.enableTraceId = false;
  }
  bindOptions(options: InitOptions = {}): void {
    const {
      beforeAppAjaxSend,
      enableTraceId,
      filterXhrUrlRegExp,
      traceIdFieldName,
      throttleDelayTime,
      includeHttpUrlTraceIdRegExp,
      appOnLaunch,
      appOnShow,
      appOnHide,
      pageOnUnload,
      pageOnShow,
      pageOnHide,
      onPageNotFound,
      onShareAppMessage,
      onShareTimeline,
      onTabItemTap,
      wxNavigateToMiniProgram,
      triggerWxEvent,
      errorIntervalTime,
      maxErrorNumberSize,
      onRouteChange,
      queueOptions,
      isReportStatic,
    } = options;
    validateOption(beforeAppAjaxSend, 'beforeAppAjaxSend', 'function') &&
      (this.beforeAppAjaxSend = beforeAppAjaxSend);
    validateOption(isReportStatic, 'isReportStatic', 'boolean') &&
      (this.isReportStatic = isReportStatic);
    // wx-mini hooks
    validateOption(appOnLaunch, 'appOnLaunch', 'function') && (this.appOnLaunch = appOnLaunch);
    validateOption(appOnShow, 'appOnShow', 'function') && (this.appOnShow = appOnShow);
    validateOption(appOnHide, 'appOnHide', 'function') && (this.appOnHide = appOnHide);
    validateOption(pageOnUnload, 'pageOnUnload', 'function') && (this.pageOnUnload = pageOnUnload);
    validateOption(pageOnShow, 'pageOnShow', 'function') && (this.pageOnShow = pageOnShow);
    validateOption(pageOnHide, 'pageOnHide', 'function') && (this.pageOnHide = pageOnHide);
    validateOption(onPageNotFound, 'onPageNotFound', 'function') &&
      (this.onPageNotFound = onPageNotFound);
    validateOption(onShareAppMessage, 'onShareAppMessage', 'function') &&
      (this.onShareAppMessage = onShareAppMessage);
    validateOption(onShareTimeline, 'onShareTimeline', 'function') &&
      (this.onShareTimeline = onShareTimeline);
    validateOption(onTabItemTap, 'onTabItemTap', 'function') && (this.onTabItemTap = onTabItemTap);
    validateOption(wxNavigateToMiniProgram, 'wxNavigateToMiniProgram', 'function') &&
      (this.wxNavigateToMiniProgram = wxNavigateToMiniProgram);
    validateOption(triggerWxEvent, 'triggerWxEvent', 'function') &&
      (this.triggerWxEvent = triggerWxEvent);
    // browser hooks
    validateOption(onRouteChange, 'onRouteChange', 'function') &&
      (this.onRouteChange = onRouteChange);

    validateOption(enableTraceId, 'enableTraceId', 'boolean') &&
      (this.enableTraceId = enableTraceId);
    validateOption(traceIdFieldName, 'traceIdFieldName', 'string') &&
      (this.traceIdFieldName = traceIdFieldName);
    validateOption(throttleDelayTime, 'throttleDelayTime', 'number') &&
      (this.throttleDelayTime = throttleDelayTime);
    validateOption(errorIntervalTime, 'errorIntervalTime', 'number') &&
      (this.errorIntervalTime = errorIntervalTime);
    validateOption(maxErrorNumberSize, 'maxErrorNumberSize', 'number') &&
      (this.maxErrorNumberSize = maxErrorNumberSize);
    toStringValidateOption(filterXhrUrlRegExp, 'filterXhrUrlRegExp', '[object RegExp]') &&
      (this.filterXhrUrlRegExp = filterXhrUrlRegExp);
    toStringValidateOption(
      includeHttpUrlTraceIdRegExp,
      'includeHttpUrlTraceIdRegExp',
      '[object RegExp]',
    ) && (this.includeHttpUrlTraceIdRegExp = includeHttpUrlTraceIdRegExp);
    validateOption(queueOptions, 'queueOptions', 'object') &&
      (this.queueOptions = queueOptions || this.queueOptions);
  }
}

const options = _support.options || (_support.options = new Options());

export function setTraceId(
  httpUrl: string,
  callback: (headerFieldName: string, traceId: string) => void,
) {
  const { includeHttpUrlTraceIdRegExp, enableTraceId } = options;
  if (enableTraceId && includeHttpUrlTraceIdRegExp && includeHttpUrlTraceIdRegExp.test(httpUrl)) {
    const traceId = generateUUID();
    callback(options.traceIdFieldName, traceId);
  }
}

/**
 * init core methods
 * @param paramOptions
 */
export function initOptions(paramOptions: InitOptions = {}) {
  setSilentFlag(paramOptions);
  breadcrumb.bindOptions(paramOptions);
  logger.bindOptions(paramOptions.debug);
  transportData.bindOptions(paramOptions);
  // 批量上报依赖定时器延迟发送，页面隐藏/卸载时兜底 flush，避免丢数据
  transportData.bindBatchFlushOnHidden();
  options.bindOptions(paramOptions);
}

export function setEnableBatch(enableBatch: boolean): void {
  transportData.setEnableBatch(enableBatch);
}

export { options };
