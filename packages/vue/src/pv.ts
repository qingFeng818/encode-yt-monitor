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
const registeredRouters: VueRouter[] = [];

/** 默认聚合窗口：1 小时内、最多 10 条（按 路由 + 类型 去重后）触发一次上报 */
const DEFAULT_REPORT_INTERVAL = 1000 * 60 * 60;
const DEFAULT_REPORT_COUNT = 10;

let firstLoad = true;
let lastReportTime: number | undefined;
let reportInterval = DEFAULT_REPORT_INTERVAL;
let reportCount = DEFAULT_REPORT_COUNT;
const reportData = new Map<string, ReportDataPvUv>();

/**
 * 未上报 PV/UV 的本地备份 key。
 *
 * 浏览器崩溃 / 被系统杀掉时不会再触发 pagehide，内存里的聚合数据只能靠备份兜底：
 * 写入 sessionStorage 后，下一次进入站点时补发；正常 flush 后立即删除，不会重复上报。
 */
const PENDING_STORAGE_KEY = 'encode-yt-monitor-pv-uv-pending';

function getSessionStorage(): Storage | undefined {
  try {
    // 隐私模式 / 禁用站点数据时，访问 sessionStorage 本身就可能抛错
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch (error) {
    return undefined;
  }
}

/** 把当前聚合结果写入 sessionStorage，供崩溃 / 被系统杀掉后补发 */
function persistPending(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    if (reportData.size === 0) {
      storage.removeItem(PENDING_STORAGE_KEY);
      return;
    }
    storage.setItem(PENDING_STORAGE_KEY, JSON.stringify(Array.from(reportData.values())));
  } catch (error) {
    // 存储被禁用 / 写满：备份失败不能影响正常上报流程
  }
}

function clearPersisted(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(PENDING_STORAGE_KEY);
  } catch (error) {
    // 存储不可用时忽略
  }
}

function readPersisted(): ReportDataPvUv[] {
  const storage = getSessionStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === 'object');
  } catch (error) {
    // 内容被其它代码改坏时直接丢弃，避免每次启动都解析失败
    clearPersisted();
    return [];
  }
}

let isLifecycleBound = false;
let detachLifecycle: (() => void) | undefined;

/**
 * 判断是不是一个可用的 vue-router 实例（vue-router 3 / 4 都有 afterEach）
 */
export function isVueRouter(router: unknown): router is VueRouter {
  return !!router && typeof (router as VueRouter).afterEach === 'function';
}

function InitOptions(options?: VueMonitorOptions | VueRouter) {
  if (!options) return;
  if (validateOption(options.reportCount, 'reportCount', 'number')) {
    reportCount = options.reportCount;
  }
  if (validateOption(options.reportInterval, 'reportInterval', 'number')) {
    reportInterval = options.reportInterval;
  }
}

function getRouteFullPath(route?: VueRoute): string {
  if (!route) return '';
  if (typeof route.fullPath === 'string') return route.fullPath;
  if (typeof route.path === 'string') return route.path;
  return '';
}

function getRouteName(route?: VueRoute): string | undefined {
  if (!route) return undefined;
  const name = route.name || (route.meta && route.meta.name) || '';
  return typeof name === 'string' ? name : undefined;
}

function getPageTitle(): string {
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
function getDataKey(data: ReportDataPvUv): string {
  return `${data.to || data.message || ''}${data.type || ''}`;
}

function mergeReportData(data: ReportDataPvUv): void {
  const key = getDataKey(data);
  const oldData = reportData.get(key);
  if (!oldData) {
    reportData.set(key, data);
  } else {
    reportData.set(key, {
      ...oldData,
      count: (oldData.count || 1) + (data.count || 1),
    });
  }
  // 崩溃 / 被系统杀掉时浏览器不会触发 pagehide，这里同步写一份备份供下次补发
  persistPending();
}

/**
 * 把当前聚合的数据一次性发出去。
 * 先取出快照再清空，保证发送失败也不会把数据留在缓存里反复重试。
 * @param unload 页面隐藏 / 卸载场景：强制走 sendBeacon 并同步清空队列
 */
function flushPvUv(unload = false): void {
  if (reportData.size === 0) return;
  lastReportTime = getTimestamp();
  const data = Array.from(reportData.values());
  reportData.clear();
  // 数据已经交给上报层，本地备份同步清掉，避免下次启动重复补发
  clearPersisted();
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
function restorePending(): void {
  const pending = readPersisted();
  if (pending.length === 0) return;
  if (!transportData.trackDsn) return;
  clearPersisted();
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
function bindPvUvLifecycle(): void {
  if (isLifecycleBound) return;
  const globalObj = _global as any;
  const doc = globalObj && globalObj.document;
  if (!doc || typeof doc.addEventListener !== 'function') return;
  isLifecycleBound = true;

  const onVisibilityChange = () => {
    if (doc.visibilityState === 'hidden') flushPvUv(true);
  };
  const onPageUnload = () => flushPvUv(true);
  const useWindow = typeof globalObj.addEventListener === 'function';

  doc.addEventListener('visibilitychange', onVisibilityChange, true);
  if (useWindow) {
    globalObj.addEventListener('pagehide', onPageUnload, true);
    globalObj.addEventListener('beforeunload', onPageUnload, true);
  }

  detachLifecycle = () => {
    doc.removeEventListener('visibilitychange', onVisibilityChange, true);
    if (useWindow && typeof globalObj.removeEventListener === 'function') {
      globalObj.removeEventListener('pagehide', onPageUnload, true);
      globalObj.removeEventListener('beforeunload', onPageUnload, true);
    }
  };

  // 进来就把上次异常退出残留的数据补发掉
  try {
    restorePending();
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
export function handleVuePv(to?: VueRoute, from?: VueRoute): void {
  const toPath = getRouteFullPath(to);
  const now = getTimestamp();
  const data: ReportDataPvUv = {
    type: StaticTypes.PV,
    message: toPath,
    url: getLocationHref(),
    name: getRouteName(to),
    level: Severity.Info,
    time: now,
    from: getRouteFullPath(from),
    to: toPath,
    title: getPageTitle(),
    isTrackData: true,
    count: 1,
  };
  mergeReportData(data);
  if (firstLoad) {
    firstLoad = false;
    // 首屏额外记一条 UV，后续访问只累加 PV
    mergeReportData({ ...data, type: StaticTypes.UV });
  }
  // 第一次采集时开始计算聚合窗口
  if (lastReportTime === undefined) lastReportTime = now;
  if (reportData.size < reportCount && now - lastReportTime < reportInterval) return;
  flushPvUv();
}

/**
 * 注册 vue-router 的 PV 采集，重复注册同一个 router 时直接跳过
 * @param router vue-router 实例
 */
export function registerVuePv(router?: VueRouter | null, options?: VueMonitorOptions): void {
  if (!isVueRouter(router) || registeredRouters.indexOf(router) !== -1) return;
  bindPvUvLifecycle();
  registeredRouters.push(router);
  if (options) InitOptions(options);
  router.afterEach((to: VueRoute, from: VueRoute) => {
    try {
      handleVuePv(to, from);
    } catch (error) {
      // 监控逻辑不能影响业务的路由跳转
      logger.error('Vue PV 采集失败：', error);
    }
  });
}

function readRouter(getter: () => unknown): VueRouter | undefined {
  try {
    const router = getter();
    return isVueRouter(router) ? router : undefined;
  } catch (error) {
    // vue2 的 Vue.prototype.$router 是依赖 this._routerRoot 的 getter，
    // 直接在原型上读取会抛错，这里静默降级
    return undefined;
  }
}

function getRouterFromInstallParam(param?: VueRouter | VueMonitorOptions): VueRouter | undefined {
  if (!param) return undefined;
  if (isVueRouter(param)) return param;
  const { router } = param as VueMonitorOptions;
  return isVueRouter(router) ? router : undefined;
}

function getVueRouter(Vue: VueInstance): VueRouter | undefined {
  // vue2: Vue.use(VueRouter) 之后 $router 挂在 Vue.prototype 上
  const prototypeRouter = readRouter(() => Vue.prototype && Vue.prototype.$router);
  if (prototypeRouter) return prototypeRouter;
  // vue3: app.use(router) 之后 $router 挂在 app.config.globalProperties 上
  return readRouter(
    () => Vue.config && Vue.config.globalProperties && Vue.config.globalProperties.$router,
  );
}

/** vue2 mixin 的兜底重试只安排一次，避免无 router 的应用在每个组件上都排一个微任务 */
let componentRetryScheduled = false;

function registerRouterFromComponent(vm?: { $router?: VueRouter }): boolean {
  const router = readRouter(() => vm && vm.$router);
  if (!router) return false;
  registerVuePv(router);
  return true;
}

/**
 * vue2 的 router 实例只挂在根组件上，install 阶段（new Vue 之前）拿不到，
 * 因此用一次性的全局 mixin 在根组件创建时捕获。
 * vue3 有 config.globalProperties.$router，不需要 mixin。
 */
function setupVue2RouterMixin(Vue: VueInstance): void {
  if (!Vue || typeof Vue.mixin !== 'function' || !/^2\./.test(Vue.version || '')) return;
  Vue.mixin({
    beforeCreate(this: { $router?: VueRouter }) {
      if (registerRouterFromComponent(this)) return;
      // 极少数场景：MonitorVue 比 VueRouter 先 use，本钩子会先于 router 的 beforeCreate 执行，
      // 此时 this.$router 还没挂上，等当前同步流程结束（router 初始化完成）后再取一次
      if (componentRetryScheduled || typeof Promise === 'undefined') return;
      componentRetryScheduled = true;
      Promise.resolve()
        .then(() => registerRouterFromComponent(this))
        .catch(() => undefined);
    },
  });
}

/**
 * 在 install 阶段完成 PV 采集的注册：
 * 1. 优先使用 Vue.use(MonitorVue, router) / Vue.use(MonitorVue, { router }) 显式传入的 router
 * 2. 其次从 Vue.prototype.$router（vue2）、config.globalProperties.$router（vue3）自动获取
 * 3. vue2 再退化为全局 mixin，在根组件创建时拿到 router
 * 4. 若此时还拿不到（例如 app.use(MonitorVue).use(router) 的调用顺序），
 *    等当前同步流程结束后再尝试一次
 */
export function setupVuePvUv(Vue: VueInstance, options?: VueRouter | VueMonitorOptions): void {
  InitOptions(options);
  // 即使暂时拿不到 router，也先把生命周期兜底挂上：
  // 首屏打开后立刻关闭 / 崩溃时，数据同样需要尽力发出去
  bindPvUvLifecycle();
  const explicitRouter = getRouterFromInstallParam(options);
  if (explicitRouter) {
    registerVuePv(explicitRouter);
    return;
  }

  const router = getVueRouter(Vue);
  if (router) {
    registerVuePv(router);
    return;
  }

  setupVue2RouterMixin(Vue);

  if (typeof Promise !== 'undefined') {
    Promise.resolve()
      .then(() => registerVuePv(getVueRouter(Vue)))
      .catch(() => undefined);
  }
}

/**
 * 重置 PV/UV 的模块级状态（已注册的 router、首屏标记、聚合缓存、配置）。
 *
 * 仅供单元测试以及需要重新初始化采集状态的场景使用，业务代码不需要调用。
 */
export function resetVuePvState(): void {
  registeredRouters.length = 0;
  firstLoad = true;
  lastReportTime = undefined;
  reportInterval = DEFAULT_REPORT_INTERVAL;
  reportCount = DEFAULT_REPORT_COUNT;
  reportData.clear();
  componentRetryScheduled = false;
  // 解绑生命周期监听并清掉本地备份，避免用例之间互相影响
  if (detachLifecycle) {
    detachLifecycle();
    detachLifecycle = undefined;
  }
  isLifecycleBound = false;
  clearPersisted();
}
