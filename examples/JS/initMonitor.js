window.encodeMonitor.init({
  errorIntervalTime: 10,
  isReportPv: true,
  reportPvOptions: {
    reportCount: 2,
    reportInterval: 2 * 1000,
  },
  batchDelay: 10 * 1000,
  silentConsole: true,
  maxBreadcrumbs: 10,
  dsn: 'http://localhost:2021/errors/upload',
  trackDsn: 'http://localhost:2021/pv/upload',
  throttleDelayTime: 0,
});
