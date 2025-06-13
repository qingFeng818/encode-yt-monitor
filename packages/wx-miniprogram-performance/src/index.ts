import { isWxMiniEnv } from 'encode-yt-monitor-utils';
import {
  initBatteryInfo,
  initMemoryWarning,
  initNetworkInfo,
  initWxHideReport,
  initWxPerformance,
  initWxNetwork,
} from './wx/index';
import Store from './core/store';
import { version } from '../package.json';
import { WxPerformanceInitOptions } from './types/index';

class WxPerformance {
  appId: string;
  version: string;
  private store: Store;

  constructor(options: WxPerformanceInitOptions) {
    if (!isWxMiniEnv) {
      return;
    }
    const {
      appId,
      report,
      immediately = true,
      ignoreUrl,
      maxBreadcrumbs = 10,
      needNetworkStatus = true,
      needBatteryInfo = true,
      needMemoryWarning = true,
      onAppHideReport = true,
    } = options;

    this.appId = appId;
    this.version = version;

    const store = new Store({ appId, report, immediately, ignoreUrl, maxBreadcrumbs });
    this.store = store;

    initBatteryInfo(store, needBatteryInfo); // 电量
    initNetworkInfo(store, needNetworkStatus); // 网络
    initMemoryWarning(store, needMemoryWarning); // 内存告警
    // 如果 immediately为false 会在appHide的时候发送数据
    initWxHideReport(store, immediately, onAppHideReport); // appHide 切后台
    initWxPerformance(store); // 性能 navigation、render、script
    initWxNetwork(store); // 网络
  }

  customPaint() {
    this.store.customPaint();
  }
}

export { WxPerformance };
