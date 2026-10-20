import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TransportData, breadcrumb, clearErrorIdCache } from 'encode-yt-monitor-core';
import { ErrorTypes } from 'encode-yt-monitor-shared';
import type { BatchTransportDataType, FinalReportType } from 'encode-yt-monitor-types';

/**
 * 上报链路集成测试（合并上报 / 并发限制 / 页面隐藏与卸载）。
 *
 * 与 batchReport.test.ts 的区别：这里不再只验证「报文长什么样」，
 * 而是把 TransportData -> 批量缓冲 -> Queue -> XHR / sendBeacon / Image
 * 整条链路串起来，验证：
 * 1. 合并上报的顺序、条数、逐条身份信息、去重与钩子过滤；
 * 2. 合并后仍然受 queueOptions.maxConcurrent 限制（不会因为合并而无限并发）；
 * 3. 失败 / 同步抛错 / 超时也会释放并发槽位，不会把队列卡死；
 * 4. 页面隐藏（visibilitychange）只 flush 不降级，卸载（pagehide/beforeunload）
 *    改走 sendBeacon，并在 pageshow / 取消卸载后恢复 XHR；
 * 5. useImgUpload 与批量上报互斥（GET 图片请求无法合并）。
 */

const TRACK_DSN = 'https://track.example.com/api/track';
const ERROR_DSN = 'https://error.example.com/api/error';

class StubXHR {
  static instances: StubXHR[] = [];
  /** true: 请求立即结束；false: 由用例手动 finish()，用于观察并发 */
  static autoFinish = true;
  /** true: 下一次 send 同步抛错（模拟 URL 非法等场景） */
  static throwOnSend = false;

  method = '';
  url = '';
  body: any = undefined;
  withCredentials = false;
  timeout = 0;
  status = 0;
  requestHeaders: Array<[string, string]> = [];
  listeners: Record<string, Array<() => void>> = {};
  finished = false;

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
    if (StubXHR.throwOnSend) {
      StubXHR.throwOnSend = false;
      throw new Error('send failed (sync)');
    }
    this.body = body;
    if (StubXHR.autoFinish) this.finish(200);
  }

  finish(status = 200): void {
    if (this.finished) return;
    this.finished = true;
    this.status = status;
    (this.listeners['loadend'] || []).slice(0).forEach((fn) => fn());
  }
}

const originalXHR = (globalThis as any).XMLHttpRequest;
const originalImage = (globalThis as any).Image;
const originalBeaconDescriptor = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon');

const transports: TransportData[] = [];
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let trackSeq = 0;
let errorSeq = 0;

const track = (trackId?: string): FinalReportType =>
  ({
    actionType: 'click',
    trackId: trackId || `track-${++trackSeq}`,
    url: 'https://a.example.com/',
    level: 'info',
    trackTime: Date.now(),
  }) as unknown as FinalReportType;

const jsError = (message?: string): FinalReportType =>
  ({
    type: ErrorTypes.JAVASCRIPT_ERROR,
    name: 'TypeError',
    message: message || `pipeline-error-${++errorSeq}`,
    url: 'https://a.example.com/',
    level: 'error',
  }) as unknown as FinalReportType;

function makeTransport(options: Record<string, unknown> = {}, bindHidden = false): TransportData {
  const transport = new TransportData();
  transport.bindOptions({
    dsn: ERROR_DSN,
    apikey: 'test-apikey',
    trackDsn: TRACK_DSN,
    trackKey: 'test-track-key',
    enableBatch: true,
    batchSize: 10,
    batchDelay: 60_000,
    ...options,
  } as any);
  if (bindHidden) transport.bindBatchFlushOnHidden();
  transports.push(transport);
  return transport;
}

const payloads = (): any[] => StubXHR.instances.map((xhr) => JSON.parse(xhr.body));

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
};

const setSendBeacon = (impl?: (url: string, data: any) => boolean) => {
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    writable: true,
    value: impl,
  });
};

const dispatch = (target: EventTarget, type: string) => {
  target.dispatchEvent(new Event(type));
};

/** jsdom 的 Blob 没有 text()，用 FileReader 读取 sendBeacon 的请求体 */
const readBlob = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });

beforeEach(() => {
  StubXHR.instances = [];
  StubXHR.autoFinish = true;
  StubXHR.throwOnSend = false;
  (globalThis as any).XMLHttpRequest = StubXHR;
  (window as any).XMLHttpRequest = StubXHR;
  breadcrumb.clear();
  clearErrorIdCache();
  // 默认让 jsdom 支持 sendBeacon，具体用例可覆盖
  setSendBeacon(vi.fn().mockReturnValue(true));
});

afterEach(() => {
  // 清掉残留缓冲 / 定时器，避免上一个用例的 TransportData 影响下一个用例
  transports.forEach((transport) => {
    transport.flushBatches();
    transport.queue.clear();
  });
  transports.length = 0;
  (globalThis as any).XMLHttpRequest = originalXHR;
  (window as any).XMLHttpRequest = originalXHR;
  if (originalImage === undefined) {
    delete (globalThis as any).Image;
  } else {
    (globalThis as any).Image = originalImage;
  }
  if (originalBeaconDescriptor) {
    Object.defineProperty(navigator, 'sendBeacon', originalBeaconDescriptor);
  } else {
    delete (navigator as any).sendBeacon;
  }
  delete (document as any).visibilityState;
  vi.useRealTimers();
});

describe('合并上报（batch）链路', () => {
  it('攒够 batchSize 时一个请求上报整批，顺序 / 条数 / 逐条身份信息完整', async () => {
    const transport = makeTransport({ batchSize: 3 });
    await transport.send(track('a'));
    await transport.send(track('b'));
    await transport.send(track('c'));
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    const payload = payloads()[0] as BatchTransportDataType;
    expect(payload.batch).toBe(true);
    expect(payload.count).toBe(3);
    expect(payload.authInfo.trackKey).toBe('test-track-key');
    // 顺序必须与入队一致，服务端才能按顺序还原用户行为
    expect(payload.data.map((item) => (item.data as any).trackId)).toEqual(['a', 'b', 'c']);
    // 每个元素都是完整单条报文，服务端可以逐条入库
    payload.data.forEach((item) => {
      expect(item.authInfo.trackKey).toBe('test-track-key');
      expect(Array.isArray(item.breadcrumb)).toBe(true);
    });
  });

  it('批量缓冲内部仍然按错误指纹去重：重复错误只占一条', async () => {
    const transport = makeTransport();
    const duplicated = jsError('same-message');
    await transport.send(duplicated);
    await transport.send(duplicated);
    await transport.send(jsError('another-message'));

    transport.flushBatches();
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    const payload = payloads()[0] as BatchTransportDataType;
    expect(payload.count).toBe(2);
    expect(payload.data.map((item) => (item.data as any).message).sort()).toEqual([
      'another-message',
      'same-message',
    ]);
  });

  it('beforeDataReport 对每一条子报文生效，变换结果不会被批量流程覆盖', async () => {
    const hook = vi.fn((data: any) => ({
      ...data,
      data: { ...data.data, transformed: true },
    }));
    const transport = makeTransport({ batchSize: 2, beforeDataReport: hook });

    await transport.send(track('a'));
    await transport.send(track('b'));
    await nextTask();

    expect(hook).toHaveBeenCalledTimes(2);
    // 钩子拿到的是完整单条报文（含 authInfo），而不是最终批量报文
    expect(hook.mock.calls[0][0].authInfo.trackKey).toBe('test-track-key');
    const payload = payloads()[0] as BatchTransportDataType;
    expect(payload.data.map((item) => (item.data as any).transformed)).toEqual([true, true]);
  });

  it('beforeDataReport 返回 null 的条目被剔除，其余条目仍能合并上报', async () => {
    const transport = makeTransport({
      batchSize: 3,
      beforeDataReport: (data: any) => (data.data.trackId === 'drop' ? null : { ...data }),
    });

    await transport.send(track('a'));
    await transport.send(track('drop'));
    await transport.send(track('b'));
    transport.flushBatches();
    await nextTask();

    const payload = payloads()[0] as BatchTransportDataType;
    expect(payload.count).toBe(2);
    expect(payload.data.map((item) => (item.data as any).trackId)).toEqual(['a', 'b']);
  });

  it('只攒到 1 条时退化为单条协议（不出现 batch / count 字段）', async () => {
    const transport = makeTransport();
    await transport.send(track('lonely'));
    transport.flushBatches();
    await nextTask();

    const payload = payloads()[0];
    expect(payload.batch).toBeUndefined();
    expect(payload.count).toBeUndefined();
    expect(payload.data.trackId).toBe('lonely');
  });

  it('batchDelay 到点自动发送，发送后定时器被清理，不会重复上报', async () => {
    vi.useFakeTimers();
    const transport = makeTransport({ batchDelay: 2000 });
    await transport.send(track('a'));
    await transport.send(track('b'));
    expect(StubXHR.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1999);
    expect(StubXHR.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(StubXHR.instances).toHaveLength(1);
    expect((payloads()[0] as BatchTransportDataType).count).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(StubXHR.instances).toHaveLength(1);
  });
});

describe('上报队列并发限制（真实 XHR 链路）', () => {
  beforeEach(() => {
    StubXHR.autoFinish = false;
  });

  it('合并后的批次仍然受 maxConcurrent 限制：一次只发一个批次', async () => {
    const transport = makeTransport({ batchSize: 2, queueOptions: { maxConcurrent: 1 } });

    await transport.send(track('a'));
    await transport.send(track('b')); // 第一批
    await transport.send(track('c'));
    await transport.send(track('d')); // 第二批
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    expect(transport.queue.getInFlightCount()).toBe(1);
    expect(transport.queue.getPendingCount()).toBe(1);

    StubXHR.instances[0].finish();
    await nextTask();

    expect(StubXHR.instances).toHaveLength(2);
    expect(payloads().map((p) => p.count)).toEqual([2, 2]);
    expect(transport.queue.getPendingCount()).toBe(0);
  });

  it('maxConcurrent=2 时同时在飞的请求不超过 2 个，完成后自动补位', async () => {
    const transport = makeTransport({
      enableBatch: false,
      queueOptions: { maxConcurrent: 2 },
    });

    for (let i = 0; i < 5; i++) await transport.send(track(`t${i}`));
    await nextTask();

    expect(StubXHR.instances).toHaveLength(2);
    expect(transport.queue.getInFlightCount()).toBe(2);
    expect(transport.queue.getPendingCount()).toBe(3);

    StubXHR.instances[0].finish();
    await nextTask();

    expect(StubXHR.instances).toHaveLength(3);
    expect(transport.queue.getInFlightCount()).toBe(2);
    expect(transport.queue.getPendingCount()).toBe(2);
  });

  it('maxConcurrent=0 表示不限制，所有请求立即发出', async () => {
    const transport = makeTransport({
      enableBatch: false,
      queueOptions: { maxConcurrent: 0 },
    });

    for (let i = 0; i < 5; i++) await transport.send(track(`t${i}`));
    await nextTask();

    expect(StubXHR.instances).toHaveLength(5);
    expect(transport.queue.getInFlightCount()).toBe(5);
    expect(transport.queue.getPendingCount()).toBe(0);
  });

  it('xhr.send 抛错时释放槽位并回调 onError，后续请求继续', async () => {
    const onError = vi.fn();
    const transport = makeTransport({
      enableBatch: false,
      queueOptions: { maxConcurrent: 1, onError },
    });

    StubXHR.throwOnSend = true;
    await transport.send(track('bad'));
    await nextTask();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(transport.queue.getInFlightCount()).toBe(0);

    // 失败的那次也已经 new 了 XHR，清掉后再断言成功请求
    StubXHR.instances = [];
    await transport.send(track('good'));
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    expect(JSON.parse(StubXHR.instances[0].body).data.trackId).toBe('good');
  });

  it('网络失败（status=0）同样触发 loadend 并释放槽位', async () => {
    const transport = makeTransport({
      enableBatch: false,
      queueOptions: { maxConcurrent: 1 },
    });

    await transport.send(track('a'));
    await transport.send(track('b'));
    await nextTask();
    expect(StubXHR.instances).toHaveLength(1);

    StubXHR.instances[0].finish(0);
    await nextTask();

    expect(StubXHR.instances).toHaveLength(2);
    expect(transport.queue.getInFlightCount()).toBe(1);
  });

  it('每个上报请求都设置超时与凭证，避免挂死请求长期占用槽位', async () => {
    const configReportXhr = vi.fn((xhr: any) => {
      xhr.setRequestHeader('X-Demo', '1');
    });
    const transport = makeTransport({ enableBatch: false, configReportXhr });

    await transport.send(track('a'));
    await nextTask();

    const xhr = StubXHR.instances[0];
    expect(configReportXhr).toHaveBeenCalledTimes(1);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.timeout).toBe(10_000);
    expect(xhr.requestHeaders).toEqual(
      expect.arrayContaining([
        ['Content-Type', 'application/json;charset=UTF-8'],
        ['X-Demo', '1'],
      ]),
    );
  });
});

describe('页面隐藏 / 卸载时的兜底上报', () => {
  it('pagehide 时批量缓冲改走 sendBeacon：只发一个请求且报文完整', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
    const transport = makeTransport({ batchSize: 10 }, true);

    await transport.send(track('a'));
    await transport.send(track('b'));
    await transport.send(track('c'));
    expect(StubXHR.instances).toHaveLength(0);

    dispatch(window, 'pagehide');

    expect(StubXHR.instances).toHaveLength(0);
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0];
    expect(url).toBe(TRACK_DSN);
    const body = JSON.parse(await readBlob(blob));
    expect(body.batch).toBe(true);
    expect(body.count).toBe(3);
    expect(body.data.map((item: any) => item.data.trackId)).toEqual(['a', 'b', 'c']);
    expect(transport.queue.getPendingCount()).toBe(0);
  });

  it('beforeunload 与 pagehide 行为一致（sendBeacon）', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
    const transport = makeTransport({ batchSize: 10 }, true);

    await transport.send(jsError('unload-error'));
    dispatch(window, 'beforeunload');

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(StubXHR.instances).toHaveLength(0);
    const body = JSON.parse(await readBlob(beacon.mock.calls[0][1]));
    expect(body.data.message).toBe('unload-error');
  });

  it('卸载时队列中排队的数据也会被同步清空（忽略并发上限）', async () => {
    StubXHR.autoFinish = false;
    const beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
    const transport = makeTransport(
      { enableBatch: false, queueOptions: { maxConcurrent: 1 } },
      true,
    );

    await transport.send(track('a'));
    await transport.send(track('b'));
    await transport.send(track('c'));
    await nextTask();

    // 第一条已经走 XHR 在飞，后两条还在队列里
    expect(StubXHR.instances).toHaveLength(1);
    expect(transport.queue.getPendingCount()).toBe(2);

    dispatch(window, 'pagehide');

    // 队列被同步清空：两条 pending 全部改走 beacon，在飞的那条不受影响
    expect(transport.queue.getPendingCount()).toBe(0);
    expect(beacon).toHaveBeenCalledTimes(2);
    expect(StubXHR.instances).toHaveLength(1);
  });

  it('visibilitychange=hidden 只 flush 不降级：仍受并发上限约束', async () => {
    StubXHR.autoFinish = false;
    const beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
    const transport = makeTransport({ queueOptions: { maxConcurrent: 1 } }, true);

    await transport.send(jsError('hidden-error-1'));
    await transport.send(jsError('hidden-error-2'));
    await transport.send(track('a'));
    await transport.send(track('b'));

    setVisibility('hidden');
    dispatch(document, 'visibilitychange');
    await nextTask();

    // 两个 dsn 分组各产生一个批次，但并发上限为 1
    expect(StubXHR.instances).toHaveLength(1);
    expect(transport.queue.getPendingCount()).toBe(1);
    expect(beacon).not.toHaveBeenCalled();

    StubXHR.instances[0].finish();
    await nextTask();

    expect(StubXHR.instances).toHaveLength(2);
    expect(transport.queue.getPendingCount()).toBe(0);
    // 隐藏不是卸载：不能走 beacon
    expect(beacon).not.toHaveBeenCalled();
  });

  it('visibilitychange=visible 不触发 flush', async () => {
    const transport = makeTransport({ batchSize: 10 }, true);
    await transport.send(track('a'));

    setVisibility('visible');
    dispatch(document, 'visibilitychange');
    await nextTask();

    expect(StubXHR.instances).toHaveLength(0);
    expect(transport.queue.getPendingCount()).toBe(0);
  });

  it('sendBeacon 返回 false 时回退 XHR，数据不丢', async () => {
    const beacon = vi.fn().mockReturnValue(false);
    setSendBeacon(beacon);
    const transport = makeTransport({ enableBatch: false }, true);

    // 卸载中发送：先尝试 beacon，失败后同一次请求内回退 XHR
    dispatch(window, 'pagehide');
    await transport.send(track('a'));
    await nextTask();

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(StubXHR.instances).toHaveLength(1);
    expect(JSON.parse(StubXHR.instances[0].body).data.trackId).toBe('a');
  });

  it('sendBeacon 抛错时回退 XHR', async () => {
    const beacon = vi.fn(() => {
      throw new Error('beacon boom');
    });
    setSendBeacon(beacon);
    const transport = makeTransport({ enableBatch: false }, true);

    dispatch(window, 'pagehide');
    await transport.send(track('a'));
    await nextTask();

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(StubXHR.instances).toHaveLength(1);
    expect(JSON.parse(StubXHR.instances[0].body).data.trackId).toBe('a');
  });

  it('环境不支持 sendBeacon 时回退 XHR', async () => {
    setSendBeacon(undefined);
    const transport = makeTransport({ enableBatch: false }, true);

    dispatch(window, 'pagehide');
    await transport.send(track('a'));
    await nextTask();

    expect(StubXHR.instances).toHaveLength(1);
    expect(StubXHR.instances[0].url).toBe(TRACK_DSN);
  });

  it('pageshow（bfcache 恢复）后重新走 XHR，不再使用 sendBeacon', async () => {
    StubXHR.autoFinish = false;
    const beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
    const transport = makeTransport({ enableBatch: false }, true);

    dispatch(window, 'pagehide');
    dispatch(window, 'pageshow');

    await transport.send(track('after-pageshow'));
    await nextTask();

    expect(beacon).not.toHaveBeenCalled();
    expect(StubXHR.instances).toHaveLength(1);
    expect(JSON.parse(StubXHR.instances[0].body).data.trackId).toBe('after-pageshow');
  });

  it('beforeunload 被取消后（宏任务）恢复 XHR', async () => {
    StubXHR.autoFinish = false;
    const beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
    const transport = makeTransport({ enableBatch: false }, true);

    dispatch(window, 'beforeunload');
    // 用户在「离开此页面？」弹窗选择留下，下个宏任务恢复 XHR
    await nextTask();

    await transport.send(track('stay-on-page'));
    await nextTask();

    expect(beacon).not.toHaveBeenCalled();
    expect(StubXHR.instances).toHaveLength(1);
  });

  it('重复调用 bindBatchFlushOnHidden 不会重复注册监听 / 重复上报', async () => {
    const beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
    const transport = makeTransport({ batchSize: 10 }, true);
    transport.bindBatchFlushOnHidden();
    transport.bindBatchFlushOnHidden();

    await transport.send(track('a'));
    dispatch(window, 'pagehide');

    expect(beacon).toHaveBeenCalledTimes(1);
  });

  it('useImgUpload 与批量上报互斥：每条数据独立走 Image GET', async () => {
    const images: string[] = [];
    class StubImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        images.push(value);
        // 图片请求完成后释放队列槽位
        Promise.resolve().then(() => this.onload && this.onload());
      }
    }
    (globalThis as any).Image = StubImage;

    const beacon = vi.fn().mockReturnValue(true);
    setSendBeacon(beacon);
    const transport = makeTransport({ useImgUpload: true }, true);

    await transport.send(track('a'));
    await transport.send(track('b'));
    await transport.send(track('c'));
    await nextTask();

    expect(images).toHaveLength(3);
    images.forEach((src) => {
      expect(src.startsWith(TRACK_DSN)).toBe(true);
      expect(src).toContain('data=');
    });
    expect(StubXHR.instances).toHaveLength(0);
    expect(beacon).not.toHaveBeenCalled();
    expect(transport.queue.getInFlightCount()).toBe(0);
  });
});
