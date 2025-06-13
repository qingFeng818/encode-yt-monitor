import { InitOptions } from 'encode-yt-monitor-types';
import { isWxMiniEnv } from 'encode-yt-monitor-utils';
import { setupReplace } from './load';
import { initOptions, log } from 'encode-yt-monitor-core';
import { sendTrackData, track } from './initiative';
import { SDK_NAME, SDK_VERSION } from 'encode-yt-monitor-shared';
import { MonitorVue } from 'encode-yt-monitor-vue';
import { errorBoundaryReport } from 'encode-yt-monitor-react';

export function init(options: InitOptions = {}) {
  if (!isWxMiniEnv) return;
  initOptions(options);
  setupReplace();
  Object.assign(wx, { monitorLog: log, SDK_NAME, SDK_VERSION });
}
export { log, sendTrackData, track, MonitorVue, errorBoundaryReport };
