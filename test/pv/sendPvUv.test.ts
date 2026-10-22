import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { breadcrumb, TransportData } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, StaticTypes } from 'encode-yt-monitor-shared';
import { logger, Severity } from 'encode-yt-monitor-utils';
import type { ReportDataPvUv } from 'encode-yt-monitor-types';

/**
 * PV / UV 上报通道（transportData.sendPvUv）。
 *
 * 与错误上报的区别：
 * 1. 固定走 trackDsn（埋点通道），不是 dsn；
 * 2. 报文 data 直接是数组（PV/UV 在采集侧已经按路由聚合好了）；
 * 3. 不参与错误指纹去重，同一个页面重复访问都要上报。
 */

const TRACK_DSN = 'https://track.example.com/api/track';
const ERROR_DSN = 'https://error.example.com/api/error';

/** 捕获 SDK 发出的上报请求体 */
class StubXHR {
  static instances: StubXHR[] = [];

  method = '';
  url = '';
  body: any = undefined;
  withCredentials = false;
  timeout = 0;
  requestHeaders: Array<[string, string]> = [];
  listeners: Record<string, Array<() => void>> = {};

  constructor() {
    StubXHR.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders.push([name, value]);
  }

  addEventListener(name: string, fn: () => void): void {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  }

  send(body?: any): void {
    this.body = body;
    (this.listeners.loadend || []).forEach((fn) => fn());
  }
}

const originalXHR = (globalThis as any).XMLHttpRequest;

/** 等待宏任务：队列本身是微任务 flush，这里一并把微任务队列清空 */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type BeaconMock = ReturnType<typeof vi.fn>;

/** jsdom 默认没有 sendBeacon，按需注入 */
function setSendBeacon(beacon?: BeaconMock): void {
  Object.defineProperty(window.navigator, 'sendBeacon', {
    value: beacon,
    configurable: true,
    writable: true,
  });
}

/** sendBeacon 的第二个参数是 Blob，这里统一读成 JSON 便于断言 */
function readBlob(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

async function beaconBodies(beacon: BeaconMock): Promise<any[]> {
  const bodies: any[] = [];
  for (const call of beacon.mock.calls) {
    const payload = call[1];
    const text = typeof payload === 'string' ? payload : await readBlob(payload);
    bodies.push(JSON.parse(text));
  }
  return bodies;
}

const makePv = (to: string, type: string = StaticTypes.PV, count = 1): ReportDataPvUv => ({
  type,
  message: to,
  to,
  from: '/home',
  title: '页面标题',
  url: `https://a.example.com/#${to}`,
  level: Severity.Info,
  time: Date.now(),
  isTrackData: true,
  count,
});

function makeTransport(options: Record<string, any> = {}): TransportData {
  const transport = new TransportData();
  transport.bindOptions({
    dsn: ERROR_DSN,
    apikey: 'test-apikey',
    trackDsn: TRACK_DSN,
    trackKey: 'track-key',
    ...options,
  });
  return transport;
}

const sentBodies = (): any[] => StubXHR.instances.map((xhr) => JSON.parse(xhr.body));

beforeEach(() => {
  StubXHR.instances = [];
  (globalThis as any).XMLHttpRequest = StubXHR;
  (window as any).XMLHttpRequest = StubXHR;
  breadcrumb.clear();
});

afterEach(() => {
  (globalThis as any).XMLHttpRequest = originalXHR;
  (window as any).XMLHttpRequest = originalXHR;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PV/UV 上报通道（sendPvUv）', () => {
  it('走 trackDsn 上报，data 为数组且保留 PV/UV 字段', async () => {
    const transport = makeTransport();

    await transport.sendPvUv([makePv('/order/1'), makePv('/order/1', StaticTypes.UV)]);
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    const xhr = StubXHR.instances[0];
    expect(xhr.url).toBe(TRACK_DSN);

    const body = sentBodies()[0];
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0].type).toBe(StaticTypes.PV);
    expect(body.data[1].type).toBe(StaticTypes.UV);
    expect(body.data[0].from).toBe('/home');
    expect(body.data[0].title).toBe('页面标题');
    expect(body.data[0].count).toBe(1);
    // PV/UV 不参与错误指纹，报文里不应出现 errorId；也不是批量上报协议
    expect(body.data[0].errorId).toBeUndefined();
    expect(body.batch).toBeUndefined();
    expect(body.authInfo.trackKey).toBe('track-key');
  });

  it('trackDsn 为空时不上报，并记录错误', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const transport = new TransportData();
    transport.bindOptions({ dsn: ERROR_DSN });

    await transport.sendPvUv([makePv('/a')]);
    await nextTask();

    expect(StubXHR.instances).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
    expect(String(errorSpy.mock.calls[0][0])).toContain('trackDsn');
  });

  it('同一条 PV 重复上报不会被错误指纹拦截', async () => {
    const transport = makeTransport();

    await transport.sendPvUv([makePv('/same')]);
    await transport.sendPvUv([makePv('/same')]);
    await nextTask();

    expect(StubXHR.instances).toHaveLength(2);
    sentBodies().forEach((body) => {
      expect(body.data).toHaveLength(1);
      expect(body.data[0].to).toBe('/same');
    });
  });

  it('开启 enableBatch 时仍按一次请求发出数组，不做二次批量合并', async () => {
    const transport = makeTransport({ enableBatch: true, batchSize: 2, batchDelay: 2000 });

    await transport.sendPvUv([makePv('/a')]);
    await transport.sendPvUv([makePv('/b')]);
    await nextTask();

    expect(StubXHR.instances).toHaveLength(2);
    sentBodies().forEach((body) => {
      expect(body.batch).toBeUndefined();
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  it('beforeDataReport 返回 false 时丢弃本次上报', async () => {
    const transport = makeTransport({ beforeDataReport: () => false });

    await transport.sendPvUv([makePv('/a')]);
    await nextTask();

    expect(StubXHR.instances).toHaveLength(0);
  });

  it('beforeDataReport 抛错时丢弃本次上报且不抛出（避免自激采集）', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const transport = makeTransport({
      beforeDataReport: () => {
        throw new Error('hook boom');
      },
    });

    await expect(transport.sendPvUv([makePv('/a')])).resolves.toBeUndefined();
    await nextTask();

    expect(StubXHR.instances).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('beforeDataReport 可以改写上报报文', async () => {
    const transport = makeTransport({
      beforeDataReport: (data: any) => ({
        ...data,
        data: data.data.map((item: ReportDataPvUv) => ({ ...item, title: '改写后的标题' })),
      }),
    });

    await transport.sendPvUv([makePv('/a')]);
    await nextTask();

    expect(sentBodies()[0].data[0].title).toBe('改写后的标题');
  });

  it('configReportUrl 可以改写上报地址', async () => {
    const transport = makeTransport({
      configReportUrl: (_data: any, dsn: string) => `${dsn}/v2`,
    });

    await transport.sendPvUv([makePv('/a')]);
    await nextTask();

    expect(StubXHR.instances[0].url).toBe(`${TRACK_DSN}/v2`);
  });

  it('configReportUrl 返回空字符串时不上报', async () => {
    const transport = makeTransport({ configReportUrl: () => '' });

    await transport.sendPvUv([makePv('/a')]);
    await nextTask();

    expect(StubXHR.instances).toHaveLength(0);
  });

  it('breadcrumb / record 使用快照，之后新增的埋点不会污染本次报文', async () => {
    breadcrumb.push({
      type: BreadCrumbTypes.CUSTOMER,
      data: { message: 'first' } as any,
      level: Severity.Info,
    });
    const transport = makeTransport();

    const pending = transport.sendPvUv([makePv('/a')]);
    breadcrumb.push({
      type: BreadCrumbTypes.CUSTOMER,
      data: { message: 'second' } as any,
      level: Severity.Info,
    });
    await pending;
    await nextTask();

    const body = sentBodies()[0];
    expect(body.breadcrumb).toHaveLength(1);
    expect(body.breadcrumb[0].data.message).toBe('first');
  });
});

/**
 * 页面销毁 / 关闭 / 崩溃兜底：
 * - 强制 sendBeacon，避免 XHR 被浏览器中断；
 * - 忽略队列并发上限，调用当次同步发出；
 * - 不能污染 isUnloading，否则后续正常上报也会一直走 beacon。
 */
describe('PV/UV 页面卸载兜底（sendPvUvOnUnload）', () => {
  let beacon: BeaconMock;

  beforeEach(() => {
    beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
  });

  afterEach(() => {
    delete (window.navigator as any).sendBeacon;
  });

  it('强制走 sendBeacon，并在同一 tick 内同步发出', async () => {
    const transport = makeTransport();

    transport.sendPvUvOnUnload([makePv('/close'), makePv('/close', StaticTypes.UV)]);

    // 没有等待队列的微任务调度就已经发了
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe(TRACK_DSN);
    // 不应该再走 XHR
    expect(StubXHR.instances).toHaveLength(0);

    const body = (await beaconBodies(beacon))[0];
    expect(body.data).toHaveLength(2);
    expect(body.data[0].type).toBe(StaticTypes.PV);
    expect(body.data[1].type).toBe(StaticTypes.UV);
    expect(body.authInfo.trackKey).toBe('track-key');
  });

  it('sendBeacon 不可用时回退 XHR，数据仍然发出去', () => {
    setSendBeacon(undefined);
    const transport = makeTransport();

    transport.sendPvUvOnUnload([makePv('/fallback')]);

    expect(beacon).not.toHaveBeenCalled();
    expect(StubXHR.instances).toHaveLength(1);
    expect(JSON.parse(StubXHR.instances[0].body).data[0].to).toBe('/fallback');
  });

  it('sendBeacon 返回 false 时回退 XHR', () => {
    beacon.mockReturnValue(false);
    const transport = makeTransport();

    transport.sendPvUvOnUnload([makePv('/beacon-false')]);

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(StubXHR.instances).toHaveLength(1);
  });

  it('没有数据 / 没配置 trackDsn 时静默跳过，不打印日志', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const transport = makeTransport();

    transport.sendPvUvOnUnload([]);
    expect(beacon).not.toHaveBeenCalled();

    const noDsn = new TransportData();
    noDsn.sendPvUvOnUnload([makePv('/no-dsn')]);

    expect(beacon).not.toHaveBeenCalled();
    expect(StubXHR.instances).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('开启 enableBatch 时仍然直接发一整条数组，不进入批量缓冲', async () => {
    const transport = makeTransport({ enableBatch: true, batchSize: 1, batchDelay: 60_000 });

    transport.sendPvUvOnUnload([makePv('/a'), makePv('/b')]);

    expect(beacon).toHaveBeenCalledTimes(1);
    const body = (await beaconBodies(beacon))[0];
    expect(body.batch).toBeUndefined();
    expect(body.data).toHaveLength(2);
  });

  it('beforeDataReport 同步改写报文后立即发送', async () => {
    const transport = makeTransport({
      beforeDataReport: (data: any) => ({
        ...data,
        data: data.data.map((item: ReportDataPvUv) => ({ ...item, title: '卸载时改写' })),
      }),
    });

    transport.sendPvUvOnUnload([makePv('/a')]);

    expect(beacon).toHaveBeenCalledTimes(1);
    const body = (await beaconBodies(beacon))[0];
    expect(body.data[0].title).toBe('卸载时改写');
  });

  it('beforeDataReport 返回 false 时不发送', () => {
    const transport = makeTransport({ beforeDataReport: () => false });

    transport.sendPvUvOnUnload([makePv('/a')]);

    expect(beacon).not.toHaveBeenCalled();
    expect(StubXHR.instances).toHaveLength(0);
  });

  it('beforeDataReport 是异步函数时，在微任务里尽力补发（不阻塞 pagehide）', async () => {
    const transport = makeTransport({
      beforeDataReport: async (data: any) => ({
        ...data,
        data: data.data.map((item: ReportDataPvUv) => ({ ...item, title: '异步改写' })),
      }),
    });

    transport.sendPvUvOnUnload([makePv('/a')]);
    expect(beacon).not.toHaveBeenCalled();

    await nextTask();

    expect(beacon).toHaveBeenCalledTimes(1);
    const body = (await beaconBodies(beacon))[0];
    expect(body.data[0].title).toBe('异步改写');
  });

  it('beforeDataReport 抛错时丢弃本次上报且不向外抛', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const transport = makeTransport({
      beforeDataReport: () => {
        throw new Error('hook boom');
      },
    });

    expect(() => transport.sendPvUvOnUnload([makePv('/a')])).not.toThrow();

    expect(beacon).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('configReportUrl 可以改写卸载上报地址，返回空值时不上报', () => {
    const transport = makeTransport({
      configReportUrl: (_data: any, dsn: string) => `${dsn}/unload`,
    });

    transport.sendPvUvOnUnload([makePv('/a')]);
    expect(beacon.mock.calls[0][0]).toBe(`${TRACK_DSN}/unload`);

    beacon.mockClear();
    const dropTransport = makeTransport({ configReportUrl: () => '' });
    dropTransport.sendPvUvOnUnload([makePv('/b')]);
    expect(beacon).not.toHaveBeenCalled();
    expect(StubXHR.instances).toHaveLength(0);
  });

  it('卸载上报不会污染 isUnloading：后续普通 PV 仍然走 XHR', async () => {
    const transport = makeTransport();

    transport.sendPvUvOnUnload([makePv('/unload')]);
    expect(beacon).toHaveBeenCalledTimes(1);

    await transport.sendPvUv([makePv('/normal')]);
    await nextTask();

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(StubXHR.instances).toHaveLength(1);
    expect(JSON.parse(StubXHR.instances[0].body).data[0].to).toBe('/normal');
  });
});
