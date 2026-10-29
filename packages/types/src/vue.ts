import { IAnyObject } from './common';
import { ReportPvOptions } from './options';

/**
 * 路由对象的最小结构（同时兼容 vue-router 3 / 4）
 */
export interface VueRoute {
  path?: string;
  fullPath?: string;
  name?: string | symbol | null;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  matched?: unknown[];
  [key: string]: any;
}

export interface VueRouter {
  afterEach(hook: (to: VueRoute, from: VueRoute) => void): unknown;
  [key: string]: any;
}

/**
 * Vue.use(MonitorVue, { router }) 时传入的配置
 */
export interface VueReportPvOptions extends ReportPvOptions {
  router?: VueRouter;
  isReportPvUv?: boolean;
}

/**
 * 兼容旧命名：等价于 VueReportPvOptions
 * @deprecated 请改用 VueReportPvOptions
 */
export type VueMonitorOptions = VueReportPvOptions;


export interface VueInstance {
  config?: VueConfiguration;
  mixin(hooks: { [key: string]: () => void }): void;
  util: {
    warn(...input: any): void;
  };
  version: string;
  // vue2 的 Vue.prototype，VueRouter 安装后会挂载 $router
  prototype?: {
    $router?: VueRouter;
    [key: string]: any;
  };
}
export interface VueConfiguration {
  silent: boolean;
  errorHandler(err: Error, vm: ViewModel, info: string): void;
  warnHandler(msg: string, vm: ViewModel, trace: string): void;
  ignoredElements: (string | RegExp)[];
  keyCodes: { [key: string]: number | number[] };
  async: boolean;
  globalProperties: {
    $vue: VueInstance;
    // vue3 中 app.use(router) 后挂载在这里
    $router?: VueRouter;
    [key: string]: any;
  };
}
export interface ViewModel {
  [key: string]: any;
  $root: Record<string, unknown>;
  $options: {
    [key: string]: any;
    name?: string;
    // vue2.6
    propsData?: IAnyObject;
    _componentTag?: string;
    __file?: string;
    props?: IAnyObject;
  };
  $props: Record<string, unknown>;
}
