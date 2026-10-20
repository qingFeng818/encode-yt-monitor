import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TransportData } from 'encode-yt-monitor-core';
import type { BatchTransportDataType, FinalReportType } from 'encode-yt-monitor-types';

/**
 * 批量上报（enableBatch）集成测试。
 *
 * 关注点：
 * 1. 开关默认关闭时行为与改造前完全一致（一条数据一个请求）；
 * 2. 开启后「同一个 dsn 的多条完整报文」合并成一个请求，报文形如
 *    { authInfo, batch: true, count, data: [单条报文, ...] }；
 * 3. 两种触发时机：攒够 batchSize 立即发 / 到 batchDelay 定时发；
 * 4. 只攒到 1 条时退化为原协议，服务端可以灰度接入。
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
    // 模拟真实 XHR：请求结束后触发 loadend，队列据此释放并发槽位
    (this.listeners['loadend'] || []).forEach((fn) => fn());
  }
}

const originalXHR = (globalThis as any).XMLHttpRequest;

/** 等待宏任务：队列本身是微任务 flush，这里一并把微任务队列清空 */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let errorSeq = 0;

const track = (trackId: string): FinalReportType =>
  ({
    actionType: 'click',
    trackId,
    url: 'https://a.example.com/',
    level: 'info',
    trackTime: Date.now(),
  }) as unknown as FinalReportType;

/** 注意：createErrorId 会按指纹去重，这里给每条错误唯一的 message */
const jsError = (): FinalReportType =>
  ({
    type: 'javascriptError',
    name: 'TypeError',
    message: `batch-error-${++errorSeq}-${Date.now()}`,
    url: 'https://a.example.com/',
    level: 'error',
  }) as unknown as FinalReportType;

const sentBodies = (): any[] => StubXHR.instances.map((xhr) => JSON.parse(xhr.body));

function makeTransport(options: Record<string, unknown> = {}): TransportData {
  const transport = new TransportData();
  transport.bindOptions({
    trackDsn: TRACK_DSN,
    trackKey: 'track-key',
    enableBatch: true,
    batchSize: 10,
    batchDelay: 2000,
    ...options,
  });
  return transport;
}

beforeEach(() => {
  StubXHR.instances = [];
  (globalThis as any).XMLHttpRequest = StubXHR;
  (window as any).XMLHttpRequest = StubXHR;
});

afterEach(() => {
  (globalThis as any).XMLHttpRequest = originalXHR;
  (window as any).XMLHttpRequest = originalXHR;
  vi.useRealTimers();
});

describe('批量上报开关（enableBatch）', () => {
  it('默认关闭：一条数据一个请求，报文保持原协议', async () => {
    const transport = new TransportData();
    transport.bindOptions({ trackDsn: TRACK_DSN, trackKey: 'track-key' });

    await transport.send(track('a'));
    await transport.send(track('b'));
    await nextTask();

    expect(StubXHR.instances).toHaveLength(2);
    sentBodies().forEach((body) => {
      expect(body.batch).toBeUndefined();
      expect(body.data.trackId).toBeTypeOf('string');
    });
  });

  it('开启后同一 dsn 的多条数据合并成一个请求', async () => {
    const transport = makeTransport();

    await transport.send(track('a'));
    await transport.send(track('b'));
    await transport.send(track('c'));

    // 未到 batchSize，也没到 batchDelay，此时不应该有请求
    expect(StubXHR.instances).toHaveLength(0);

    transport.flushBatches();
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    const body = sentBodies()[0] as BatchTransportDataType;
    expect(body.batch).toBe(true);
    expect(body.count).toBe(3);
    expect(body.data.map((item) => (item.data as any).trackId)).toEqual(['a', 'b', 'c']);
    // 每个元素仍然是完整单条报文，服务端可以逐条入库
    body.data.forEach((item) => {
      expect(item.authInfo).toBeDefined();
      expect(item.deviceInfo).toBeDefined();
    });
  });

  it('攒够 batchSize 立即发送，不等 batchDelay', async () => {
    const transport = makeTransport({ batchSize: 2, batchDelay: 60_000 });

    await transport.send(track('a'));
    await transport.send(track('b'));
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    const body = sentBodies()[0] as BatchTransportDataType;
    expect(body.batch).toBe(true);
    expect(body.count).toBe(2);
  });

  it('未攒够 batchSize 时，batchDelay 到点自动发送', async () => {
    vi.useFakeTimers();
    const transport = makeTransport({ batchSize: 10, batchDelay: 1000 });

    await transport.send(track('a'));
    await transport.send(track('b'));
    expect(StubXHR.instances).toHaveLength(0);

    vi.advanceTimersByTime(999);
    await Promise.resolve();
    expect(StubXHR.instances).toHaveLength(0);

    vi.advanceTimersByTime(1);
    await Promise.resolve();

    expect(StubXHR.instances).toHaveLength(1);
    expect((sentBodies()[0] as BatchTransportDataType).count).toBe(2);
  });

  it('按 dsn 分组：错误与埋点不会合并到同一个请求', async () => {
    const transport = makeTransport({
      dsn: ERROR_DSN,
      apikey: `apikey-${Date.now()}`,
      batchSize: 10,
    });

    await transport.send(track('t1'));
    await transport.send(track('t2'));
    await transport.send(jsError());
    await transport.send(jsError());

    transport.flushBatches();
    await nextTask();

    expect(StubXHR.instances).toHaveLength(2);
    const urls = StubXHR.instances.map((xhr) => xhr.url).sort();
    expect(urls).toEqual([ERROR_DSN, TRACK_DSN]);
    sentBodies().forEach((body) => {
      expect(body.batch).toBe(true);
      expect(body.count).toBe(2);
    });
  });

  it('只攒到一条时退化为原协议，服务端可灰度接入', async () => {
    const transport = makeTransport();

    await transport.send(track('only'));
    transport.flushBatches();
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    const body = sentBodies()[0];
    expect(body.batch).toBeUndefined();
    expect(body.count).toBeUndefined();
    expect(body.data.trackId).toBe('only');
  });

  it('手动 flush 后定时器不会再重复发送同一批数据', async () => {
    vi.useFakeTimers();
    const transport = makeTransport({ batchSize: 10, batchDelay: 1000 });

    await transport.send(track('a'));
    await transport.send(track('b'));
    transport.flushBatches();
    await Promise.resolve();
    expect(StubXHR.instances).toHaveLength(1);

    vi.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(StubXHR.instances).toHaveLength(1);
  });

  it('pagehide 时同步 flush 并改用 sendBeacon，避免卸载丢数据', async () => {
    vi.useFakeTimers();
    const transport = makeTransport({ batchSize: 10, batchDelay: 60_000 });
    transport.bindBatchFlushOnHidden();

    const originalBeacon = (window.navigator as any).sendBeacon;
    const originalBlob = (globalThis as any).Blob;
    const beacon = vi.fn((_url: string, _payload: any) => true);
    (window.navigator as any).sendBeacon = beacon;
    // jsdom 的 Blob 没有 text()，这里用最小桩把 body 原样留出来
    (globalThis as any).Blob = class {
      constructor(
        public parts: any[],
        public options: any,
      ) {}
    };

    try {
      await transport.send(track('a'));
      await transport.send(track('b'));
      expect(StubXHR.instances).toHaveLength(0);

      window.dispatchEvent(new Event('pagehide'));

      // 同步发出：不依赖队列的微任务，也不再走 XHR
      expect(StubXHR.instances).toHaveLength(0);
      expect(beacon).toHaveBeenCalledTimes(1);
      const [url, payload] = beacon.mock.calls[0];
      expect(url).toBe(TRACK_DSN);
      expect(JSON.parse((payload as any).parts[0])).toMatchObject({ batch: true, count: 2 });
    } finally {
      (window.navigator as any).sendBeacon = originalBeacon;
      (globalThis as any).Blob = originalBlob;
    }
  });

  it('配置项可通过 bindOptions 生效，类型不符时忽略', () => {
    const transport = new TransportData();

    transport.bindOptions({ enableBatch: true, batchSize: 20, batchDelay: 500 });
    expect(transport.enableBatch).toBe(true);
    expect(transport.batchSize).toBe(20);
    expect(transport.batchDelay).toBe(500);

    // 类型不合法：保持原值
    transport.bindOptions({ enableBatch: 'yes' as any, batchSize: '20' as any });
    expect(transport.enableBatch).toBe(true);
    expect(transport.batchSize).toBe(20);
  });
});
