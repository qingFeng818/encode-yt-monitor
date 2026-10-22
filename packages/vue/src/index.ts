import { getFlag, setFlag, silentConsoleScope, Severity } from 'encode-yt-monitor-utils';
import { EventTypes } from 'encode-yt-monitor-shared';
import { VueInstance, ViewModel, VueRouter, VueMonitorOptions } from './types';
import { handleVueError } from './helper';
import { registerVuePv, setupVuePvUv } from './pv';

const hasConsole = typeof console !== 'undefined';

const MonitorVue = {
  install(Vue: VueInstance, options?: VueRouter | VueMonitorOptions): void {
    if (getFlag(EventTypes.VUE) || !Vue || !Vue.config) return;
    setFlag(EventTypes.VUE, true);
    // vue 提供 warnHandler errorHandler报错信息
    const originalErrorHandler = Vue.config.errorHandler;
    Vue.config.errorHandler = function (err: Error, vm: ViewModel, info: string): void {
      if (originalErrorHandler) originalErrorHandler.call(this, err, vm, info);
      handleVueError.apply(null, [err, vm, info, Severity.Normal, Severity.Error, Vue]);
      if (hasConsole && !Vue.config.silent) {
        silentConsoleScope(() => {
          console.error('Error in ' + info + ': "' + err.toString() + '"', vm);
          console.error(err);
        });
      }
    };
    try {
      if (options && options.isReportPvUv) setupVuePvUv(Vue, options);
    } catch (error) {
      console.error('MonitorVue install error', error);
    }
  },
};

export { MonitorVue, registerVuePv };
