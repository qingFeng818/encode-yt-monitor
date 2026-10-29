import {
  ReportPvOptions,
  VueInstance,
  VueReportPvOptions,
  VueRoute,
  VueRouter,
} from 'encode-yt-monitor-types';
import { logger } from 'encode-yt-monitor-utils';
import { ReportPv } from 'encode-yt-monitor-core';

/**
 * 已经注册过 afterEach 的 router。
 * 用数组而不是 WeakSet，保证 es5 产物在低版本浏览器里也能运行；
 * 页面生命周期内 router 实例数量极少，不会有内存问题。
 */
const registeredRouters: VueRouter[] = [];

let reportPv: ReportPv | null = null;
const initReportPv = (reportPvOptions: ReportPvOptions) => {
  if (!reportPv) {
    reportPv = new ReportPv(reportPvOptions);
    return;
  }
  // 重复 install / register 时用最新配置覆盖，避免后面的 reportCount 不生效
  reportPv.bindOptions(reportPvOptions);
};

/** 从 install / register 入参里取出 PV 配置（兼容直接传 router 的旧用法） */
function toPvOptions(param?: VueRouter | ReportPvOptions): ReportPvOptions {
  if (!param || isVueRouter(param)) return {};
  const { reportCount, reportInterval } = param;
  return { reportCount, reportInterval };
}

/**
 * 判断是不是一个可用的 vue-router 实例（vue-router 3 / 4 都有 afterEach）
 */
export function isVueRouter(router: unknown): router is VueRouter {
  return !!router && typeof (router as VueRouter).afterEach === 'function';
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

/**
 * 上报一次页面 PV（首次访问额外产生一条 UV）
 * @param to 目标路由
 * @param from 来源路由
 */
export function handleVuePv(to?: VueRoute, from?: VueRoute): void {
  if (!reportPv) return;
  // name 用路由名，title 交给采集器取 document.title（与历史报文语义保持一致）
  reportPv.handlePV(getRouteFullPath(to), getRouteFullPath(from), { name: getRouteName(to) });
}

/**
 * 注册 vue-router 的 PV 采集，重复注册同一个 router 时直接跳过
 * @param router vue-router 实例
 * @param options PV/UV 上报配置
 */
export function registerVuePv(router?: VueRouter | null, options?: ReportPvOptions): void {
  if (!isVueRouter(router) || registeredRouters.indexOf(router) !== -1) return;
  // 单独使用 registerVuePv 时也必须初始化采集器，否则 handleVuePv 会静默不工作
  initReportPv(toPvOptions(options));
  registeredRouters.push(router);
  router.afterEach((to: VueRoute, from: VueRoute) => {
    try {
      handleVuePv(to, from);
    } catch (error) {
      // 监控逻辑不能影响业务的路由跳转
      logger.error('Vue PV 采集失败：', error);
    }
  });
}

/**
 * 重置 PV 采集模块级状态（仅用于单测 / 需要彻底重建采集器的场景）。
 * 会解绑页面生命周期监听并丢弃内存中未上报的聚合数据。
 */
export function resetVuePvState(): void {
  if (reportPv) {
    reportPv.destroy();
    reportPv = null;
  }
  registeredRouters.length = 0;
  componentRetryScheduled = false;
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

function getRouterFromInstallParam(param?: VueRouter | VueReportPvOptions): VueRouter | undefined {
  if (!param) return undefined;
  if (isVueRouter(param)) return param;
  const { router } = param as VueReportPvOptions;
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
export function setupVuePvUv(Vue: VueInstance, options?: VueRouter | VueReportPvOptions): void {
  const explicitRouter = getRouterFromInstallParam(options);
  const pvOptions = toPvOptions(options);
  // 先初始化采集器：即使暂时拿不到 router，也要把上次崩溃残留的数据补发掉
  initReportPv(pvOptions);
  if (explicitRouter) {
    registerVuePv(explicitRouter, pvOptions);
    return;
  }

  const router = getVueRouter(Vue);
  if (router) {
    registerVuePv(router, pvOptions);
    return;
  }

  setupVue2RouterMixin(Vue);

  if (typeof Promise !== 'undefined') {
    Promise.resolve()
      .then(() => registerVuePv(getVueRouter(Vue), pvOptions))
      .catch(() => undefined);
  }
}

