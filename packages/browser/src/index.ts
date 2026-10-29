export * from './handleEvents';
export * from './load';
export * from './replace';
import { setupReplace } from './load';
import { HandleEvents } from './handleEvents';
import { initOptions, log, setEnableBatch } from 'encode-yt-monitor-core';
import { _global, getLocationHref } from 'encode-yt-monitor-utils';
import { SDK_VERSION, SDK_NAME } from 'encode-yt-monitor-shared';
import { InitOptions } from 'encode-yt-monitor-types';

function webInit(options: InitOptions = {}): void {
  if (!('XMLHttpRequest' in _global) || options.disabled) return;
  initOptions(options);
  setupReplace();
  // 首屏不会产生 history / hashchange 事件，这里补一条 PV（UV 也在这一步产生），
  // 否则首个页面的 PV 会丢失、UV 会被算到第二个页面上
  if (options.isReportPv || options.isReportStatic) {
    try {
      HandleEvents.handlePv({ from: '', to: getLocationHref() });
    } catch (error) {
      // 首屏 PV 失败不能影响监控 / 业务初始化
    }
  }
}

function init(options: InitOptions = {}): void {
  webInit(options);
}

export { SDK_VERSION, SDK_NAME, init, log, setEnableBatch };
