import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MonitorVue, registerVuePv } from 'encode-yt-monitor-vue/index';
import { resetVuePvState } from 'encode-yt-monitor-vue/pv';
import { transportData } from 'encode-yt-monitor-core';
import { StaticTypes } from 'encode-yt-monitor-shared';
import { Severity } from 'encode-yt-monitor-utils';
import type { ReportDataPvUv } from 'encode-yt-monitor-types';
import type {
  VueInstance,
  VueMonitorOptions,
  VueRoute,
  VueRouter,
} from 'encode-yt-monitor-vue/types';

type AfterEachHook = (to: VueRoute, from: VueRoute) => void;

interface RouterMock {
  router: VueRouter;
  trigger: (to: VueRoute, from?: VueRoute) => void;
  hookCount: () => number;
}

function createRouterMock(): RouterMock {
  let hook: AfterEachHook | undefined;
  const registerHook = vi.fn((fn: AfterEachHook) => {
    hook = fn;
    return () => {
      hook = undefined;
    };
  });
  return {
    router: { afterEach: registerHook } as unknown as VueRouter,
    trigger: (to: VueRoute, from: VueRoute = {}) => {
      if (!hook) throw new Error('afterEach hook 未注册');
      hook(to, from);
    },
    hookCount: () => registerHook.mock.calls.length,
  };
}

function createVue3Instance(router?: VueRouter): VueInstance {
  return {
    version: '3.4.0',
    config: {
      errorHandler: undefined,
      silent: true,
      globalProperties: { $router: router },
    },
  } as unknown as VueInstance;
}

function createVue2Instance(router?: VueRouter): VueInstance {
  return {
    version: '2.7.16',
    config: {
      errorHandler: undefined,
      silent: true,
    },
    prototype: { $router: router },
  } as unknown as VueInstance;
}

/** reportCount = 1：每次路由跳转都立即把聚合结果发出去，便于断言 */
const instantOptions = (extra: VueMonitorOptions = {}): VueMonitorOptions => ({
  isReportPvUv: true,
  reportCount: 1,
  ...extra,
});

describe('Vue PV/UV 采集（router.afterEach）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  const sentBatch = (callIndex = 0): ReportDataPvUv[] =>
    sendSpy.mock.calls[callIndex][0] as ReportDataPvUv[];

  const findData = (batch: ReportDataPvUv[], to: string, type: string): ReportDataPvUv =>
    batch.find((item) => item.to === to && item.type === type) as ReportDataPvUv;

  beforeEach(() => {
    // 模块级的聚合缓存 / 首屏标记 / router 注册表需要在用例之间重置
    resetVuePvState();
    sendSpy = vi.spyOn(transportData, 'sendPvUv').mockImplementation(async () => undefined);
    document.title = '订单详情';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('isReportStatic 开启时注册 afterEach，首屏同时上报 PV 与 UV', () => {
    const { router, trigger, hookCount } = createRouterMock();
    const Vue = createVue3Instance();

    MonitorVue.install(Vue, instantOptions({ router }));

    expect(hookCount()).toBe(1);
    // 原来的错误采集不受影响
    expect(Vue.config.errorHandler).toBeTypeOf('function');

    trigger(
      { fullPath: '/order/100?from=home', path: '/order/100', name: 'order-detail' },
      { fullPath: '/home', path: '/home', name: 'home' },
    );

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const batch = sentBatch();
    // 首屏会同时产生一条 PV 和一条 UV
    expect(batch).toHaveLength(2);

    const pv = findData(batch, '/order/100?from=home', StaticTypes.PV);
    expect(pv.level).toBe(Severity.Info);
    expect(pv.from).toBe('/home');
    expect(pv.message).toBe('/order/100?from=home');
    expect(pv.name).toBe('order-detail');
    expect(pv.title).toBe('订单详情');
    expect(pv.time).toBeTypeOf('number');
    expect(pv.url).toContain('/');
    expect(pv.isTrackData).toBe(true);
    expect(pv.count).toBe(1);

    const uv = findData(batch, '/order/100?from=home', StaticTypes.UV);
    expect(uv.count).toBe(1);
    expect(uv.from).toBe('/home');
    expect(uv.title).toBe('订单详情');
  });

  it('未开启 isReportStatic 时不注册 PV，错误采集仍然正常', () => {
    const { router, hookCount } = createRouterMock();
    const Vue = createVue3Instance(router);

    // 直接传 router（旧用法）不再隐式开启 PV 采集
    MonitorVue.install(Vue, router);

    expect(hookCount()).toBe(0);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(Vue.config.errorHandler).toBeTypeOf('function');
  });

  it('install 不传 options 时不抛错，也不注册 PV', () => {
    const Vue = createVue3Instance();

    expect(() => MonitorVue.install(Vue)).not.toThrow();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(Vue.config.errorHandler).toBeTypeOf('function');
  });

  it('支持 Vue.use(MonitorVue, { router }) 的对象传参', () => {
    const { router, trigger, hookCount } = createRouterMock();

    MonitorVue.install(createVue3Instance(), instantOptions({ router }));

    expect(hookCount()).toBe(1);
    trigger({ fullPath: '/list', path: '/list' }, { fullPath: '/', path: '/' });
    expect(findData(sentBatch(), '/list', StaticTypes.PV).from).toBe('/');
  });

  it('未显式传 router 时从 vue3 config.globalProperties.$router 自动获取', () => {
    const { router, trigger, hookCount } = createRouterMock();

    MonitorVue.install(createVue3Instance(router), instantOptions());

    expect(hookCount()).toBe(1);
    trigger({ path: '/detail/1' }, { path: '/list' });
    const batch = sentBatch();
    expect(findData(batch, '/detail/1', StaticTypes.PV).from).toBe('/list');
    expect(findData(batch, '/detail/1', StaticTypes.UV)).toBeTruthy();
  });

  it('未显式传 router 时从 vue2 Vue.prototype.$router 自动获取', () => {
    const { router, trigger, hookCount } = createRouterMock();

    MonitorVue.install(createVue2Instance(router), instantOptions());

    expect(hookCount()).toBe(1);
    trigger({ fullPath: '/legacy', path: '/legacy' }, { fullPath: '/', path: '/' });
    expect(findData(sentBatch(), '/legacy', StaticTypes.PV).to).toBe('/legacy');
  });

  it('vue2 在 install 阶段拿不到 router 时，通过全局 mixin 在根组件创建时捕获', () => {
    const { router, trigger, hookCount } = createRouterMock();
    let mixinHook: (() => void) | undefined;
    const Vue = {
      version: '2.7.16',
      config: { errorHandler: undefined, silent: true },
      prototype: {},
      mixin: vi.fn((hooks: { beforeCreate: () => void }) => {
        mixinHook = hooks.beforeCreate;
      }),
    } as unknown as VueInstance;

    MonitorVue.install(Vue, instantOptions());

    expect(hookCount()).toBe(0);
    expect(mixinHook).toBeTypeOf('function');

    // 模拟根组件 beforeCreate：此时 this.$router 才指向真实 router
    mixinHook!.call({ $router: router });

    expect(hookCount()).toBe(1);
    trigger({ fullPath: '/legacy-list', path: '/legacy-list' }, { fullPath: '/', path: '/' });
    expect(findData(sentBatch(), '/legacy-list', StaticTypes.PV).to).toBe('/legacy-list');
  });

  it('vue2 mixin 执行时 router 还没挂上，会在微任务里重试一次', async () => {
    const { router, trigger, hookCount } = createRouterMock();
    let mixinHook: (() => void) | undefined;
    const Vue = {
      version: '2.7.16',
      config: { errorHandler: undefined, silent: true },
      prototype: {},
      mixin: vi.fn((hooks: { beforeCreate: () => void }) => {
        mixinHook = hooks.beforeCreate;
      }),
    } as unknown as VueInstance;

    MonitorVue.install(Vue, instantOptions());

    const vm: { $router?: VueRouter } = {};
    mixinHook!.call(vm);
    expect(hookCount()).toBe(0);

    // 模拟 VueRouter 的 beforeCreate 在本钩子之后才挂上 $router
    vm.$router = router;
    await Promise.resolve();

    expect(hookCount()).toBe(1);
    trigger({ fullPath: '/late', path: '/late' }, { fullPath: '/', path: '/' });
    expect(findData(sentBatch(), '/late', StaticTypes.PV).to).toBe('/late');
  });

  it('同一个路由重复访问会合并成一条并累加 count', () => {
    const { router, trigger } = createRouterMock();

    // 攒够 3 条（PV/UV 按「路由 + 类型」去重）才上报
    MonitorVue.install(createVue3Instance(), instantOptions({ router, reportCount: 3 }));

    trigger({ fullPath: '/a', path: '/a' }, { fullPath: '/', path: '/' });
    trigger({ fullPath: '/a', path: '/a' }, { fullPath: '/b', path: '/b' });
    expect(sendSpy).not.toHaveBeenCalled();

    // 第三条不同路由，达到 reportCount 触发上报
    trigger({ fullPath: '/b', path: '/b' }, { fullPath: '/a', path: '/a' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const batch = sentBatch();
    expect(batch).toHaveLength(3);
    expect(findData(batch, '/a', StaticTypes.PV).count).toBe(2);
    expect(findData(batch, '/a', StaticTypes.UV).count).toBe(1);
    expect(findData(batch, '/b', StaticTypes.PV).count).toBe(1);
    // 聚合后只保留最后一次跳转的来源路由
    expect(findData(batch, '/b', StaticTypes.PV).from).toBe('/a');
  });

  it('UV 只在首次访问时上报一次', () => {
    const { router, trigger } = createRouterMock();

    MonitorVue.install(createVue3Instance(), instantOptions({ router }));

    trigger({ fullPath: '/first', path: '/first' });
    trigger({ fullPath: '/second', path: '/second' });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sentBatch(0).map((item) => item.type)).toEqual([StaticTypes.PV, StaticTypes.UV]);
    // 第二次跳转只上报 PV
    expect(sentBatch(1)).toHaveLength(1);
    expect(sentBatch(1)[0].type).toBe(StaticTypes.PV);
    expect(sentBatch(1)[0].to).toBe('/second');
  });

  it('reportInterval 到期后即使没攒够 reportCount 也会上报', () => {
    const start = 1700000000000;
    vi.useFakeTimers({ now: start });
    const { router, trigger } = createRouterMock();

    MonitorVue.install(createVue3Instance(), instantOptions({ router, reportCount: 10 }));

    trigger({ fullPath: '/a', path: '/a' }, { fullPath: '/', path: '/' });
    expect(sendSpy).not.toHaveBeenCalled();

    // 默认聚合窗口 1 小时，超过后下一次跳转立即上报
    vi.setSystemTime(start + 60 * 60 * 1000);
    trigger({ fullPath: '/b', path: '/b' }, { fullPath: '/a', path: '/a' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const batch = sentBatch();
    expect(batch.find((item) => item.to === '/a' && item.type === StaticTypes.PV)).toBeTruthy();
    expect(batch.find((item) => item.to === '/a' && item.type === StaticTypes.UV)).toBeTruthy();
    expect(findData(batch, '/b', StaticTypes.PV).count).toBe(1);
  });

  it('没有 fullPath 时回退 path，name 非字符串时忽略', () => {
    const { router, trigger } = createRouterMock();

    MonitorVue.install(createVue3Instance(), instantOptions({ router }));

    trigger({ path: '/fallback', name: Symbol('route-name') });

    const pv = findData(sentBatch(), '/fallback', StaticTypes.PV);
    expect(pv.name).toBeUndefined();
    expect(pv.from).toBe('');
    expect(pv.time).toBeTypeOf('number');
  });

  it('同一个 router 重复注册只生效一次，避免一次跳转上报多条 PV', () => {
    const { router, hookCount } = createRouterMock();

    MonitorVue.install(createVue3Instance(router), instantOptions());
    registerVuePv(router);
    registerVuePv(router);

    expect(hookCount()).toBe(1);
  });

  it('也可以单独使用 registerVuePv 注册，并应用 reportCount 配置', () => {
    const { router, trigger, hookCount } = createRouterMock();

    registerVuePv(router, { reportCount: 1 });
    expect(hookCount()).toBe(1);
    expect(sendSpy).not.toHaveBeenCalled();

    trigger({ fullPath: '/standalone', path: '/standalone' });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(findData(sentBatch(), '/standalone', StaticTypes.PV)).toBeTruthy();
  });

  it('上报异常不应该影响业务路由跳转', async () => {
    const { router, trigger } = createRouterMock();

    MonitorVue.install(createVue3Instance(), instantOptions({ router }));

    // 同步抛错
    sendSpy.mockImplementationOnce(() => {
      throw new Error('send boom');
    });
    expect(() => trigger({ path: '/sync-error' }, { path: '/' })).not.toThrow();

    // 异步 reject：内部会被 catch 掉，不能产生 unhandledrejection
    sendSpy.mockImplementationOnce(() => Promise.reject(new Error('async boom')));
    expect(() => trigger({ path: '/async-error' }, { path: '/' })).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
});

const PENDING_STORAGE_KEY = 'encode-yt-monitor-pv-uv-pending';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

function dispatchPageHide(): void {
  window.dispatchEvent(new Event('pagehide'));
}

describe('Vue PV/UV 页面销毁兜底（隐藏 / 关闭 / 崩溃）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let unloadSpy: ReturnType<typeof vi.spyOn>;

  const pendingPv: ReportDataPvUv = {
    type: StaticTypes.PV,
    message: '/crashed',
    to: '/crashed',
    from: '/home',
    title: '崩溃前的页面',
    url: 'https://a.example.com/#/crashed',
    level: Severity.Info,
    time: 1700000000000,
    isTrackData: true,
    count: 1,
  };

  beforeEach(() => {
    resetVuePvState();
    setVisibility('visible');
    sendSpy = vi.spyOn(transportData, 'sendPvUv').mockImplementation(async () => undefined);
    unloadSpy = vi.spyOn(transportData, 'sendPvUvOnUnload').mockImplementation(() => undefined);
  });

  afterEach(() => {
    resetVuePvState();
    setVisibility('visible');
  });

  it('pagehide 时把没攒够 reportCount 的 PV/UV 一起发出，且重复触发不重复上报', () => {
    const { router, trigger } = createRouterMock();

    MonitorVue.install(createVue3Instance(), instantOptions({ router, reportCount: 10 }));
    trigger({ fullPath: '/a', path: '/a' }, { fullPath: '/', path: '/' });

    expect(sendSpy).not.toHaveBeenCalled();

    dispatchPageHide();

    expect(unloadSpy).toHaveBeenCalledTimes(1);
    const batch = unloadSpy.mock.calls[0][0] as ReportDataPvUv[];
    expect(batch.map((item) => item.type)).toEqual([StaticTypes.PV, StaticTypes.UV]);
    expect(batch[0].to).toBe('/a');

    // pagehide 之后再触发 beforeunload 时缓存已清空，不会重复上报
    window.dispatchEvent(new Event('beforeunload'));
    expect(unloadSpy).toHaveBeenCalledTimes(1);
  });

  it('页面进入后台（visibilitychange = hidden）时立即上报，恢复可见不触发', () => {
    const { router, trigger } = createRouterMock();

    MonitorVue.install(createVue3Instance(), instantOptions({ router, reportCount: 10 }));
    trigger({ fullPath: '/b', path: '/b' }, { fullPath: '/', path: '/' });

    // 可见状态下收到 visibilitychange 不发送
    document.dispatchEvent(new Event('visibilitychange'));
    expect(unloadSpy).not.toHaveBeenCalled();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(unloadSpy).toHaveBeenCalledTimes(1);
    const batch = unloadSpy.mock.calls[0][0] as ReportDataPvUv[];
    expect(batch.map((item) => item.type)).toEqual([StaticTypes.PV, StaticTypes.UV]);
  });

  it('聚合中的 PV/UV 会写入 sessionStorage，上报后立即删除', () => {
    const { router, trigger } = createRouterMock();

    MonitorVue.install(createVue3Instance(), instantOptions({ router, reportCount: 10 }));
    trigger({ fullPath: '/persist', path: '/persist' }, { fullPath: '/', path: '/' });

    const raw = sessionStorage.getItem(PENDING_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(String(raw)) as ReportDataPvUv[];
    expect(stored).toHaveLength(2);
    expect(stored.map((item) => item.type)).toEqual([StaticTypes.PV, StaticTypes.UV]);
    expect(stored[0].to).toBe('/persist');

    dispatchPageHide();

    expect(unloadSpy).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
  });

  it('崩溃残留的数据会在下次初始化时补发，并从 sessionStorage 删除', () => {
    sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify([pendingPv]));
    const originalDsn = transportData.trackDsn;
    transportData.trackDsn = 'https://track.example.com/api/track';

    try {
      const { router } = createRouterMock();
      MonitorVue.install(createVue3Instance(), instantOptions({ router }));

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const batch = sendSpy.mock.calls[0][0] as ReportDataPvUv[];
      expect(batch).toHaveLength(1);
      expect(batch[0].to).toBe('/crashed');
      expect(batch[0].count).toBe(1);
      expect(sessionStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
    } finally {
      transportData.trackDsn = originalDsn;
    }
  });

  it('还没配置 trackDsn 时保留崩溃备份，等下次初始化再补发', () => {
    sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify([pendingPv]));
    const originalDsn = transportData.trackDsn;
    transportData.trackDsn = '';

    try {
      const { router } = createRouterMock();
      MonitorVue.install(createVue3Instance(), instantOptions({ router }));

      expect(sendSpy).not.toHaveBeenCalled();
      expect(sessionStorage.getItem(PENDING_STORAGE_KEY)).not.toBeNull();
    } finally {
      transportData.trackDsn = originalDsn;
    }
  });

  it('sessionStorage 内容损坏时直接丢弃，不影响正常采集', () => {
    sessionStorage.setItem(PENDING_STORAGE_KEY, '{not-json');
    const { router, trigger } = createRouterMock();

    expect(() =>
      MonitorVue.install(createVue3Instance(), instantOptions({ router })),
    ).not.toThrow();
    expect(sessionStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();

    trigger({ fullPath: '/after-broken', path: '/after-broken' });
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('多次 install / registerVuePv 只注册一次生命周期监听', () => {
    const { router, trigger } = createRouterMock();
    const addSpy = vi.spyOn(document, 'addEventListener');

    MonitorVue.install(createVue3Instance(), instantOptions({ router, reportCount: 10 }));
    registerVuePv(router);

    const visibilityListeners = addSpy.mock.calls.filter(([name]) => name === 'visibilitychange');
    expect(visibilityListeners).toHaveLength(1);

    trigger({ fullPath: '/once', path: '/once' });
    dispatchPageHide();

    expect(unloadSpy).toHaveBeenCalledTimes(1);
  });
});
