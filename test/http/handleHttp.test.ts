import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HandleEvents } from '../../packages/browser/src/handleEvents';
import { breadcrumb, transportData } from 'encode-yt-monitor-core';
import {
  BreadCrumbCategory,
  BreadCrumbTypes,
  ErrorTypes,
  HttpTypes,
} from 'encode-yt-monitor-shared';
import { Severity, SpanStatus, getLocationHref } from 'encode-yt-monitor-utils';
import type { MonitorHttp } from 'encode-yt-monitor-types';

function buildHttp(partial: Partial<MonitorHttp>): MonitorHttp {
  return {
    type: HttpTypes.XHR,
    method: 'GET',
    url: 'https://api.example.com/user/list?page=1',
    status: 200,
    reqData: '',
    responseText: '',
    elapsedTime: 50,
    time: Date.now(),
    traceId: 'trace-123',
    ...partial,
  };
}

/** 提取第 n 次 send 上报的 payload */
function payloadOf(spy: ReturnType<typeof vi.spyOn>, n = 0): any {
  return spy.mock.calls[n][0];
}

/** 提取第 n 次 breadcrumb.push 的数据 */
function pushedOf(spy: ReturnType<typeof vi.spyOn>, n = 0): any {
  return spy.mock.calls[n][0];
}

describe('HTTP 错误（XHR / fetch → HTTP_ERROR）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  describe('失败请求（应上报）', () => {
    it.each([
      { status: 500, label: '500 服务端错误' },
      { status: 400, label: '400 参数错误' },
      { status: 401, label: '401 未授权' },
      { status: 404, label: '404 不存在' },
    ])('XHR $label 应上报 HTTP_ERROR', ({ status }) => {
      HandleEvents.handleHttp(buildHttp({ status, type: HttpTypes.XHR }), BreadCrumbTypes.XHR);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = payloadOf(sendSpy);
      expect(payload.type).toBe(ErrorTypes.FETCH_ERROR);
      expect(payload.name).toBe('xhr--GET');
      expect(payload.response.status).toBe(status);
      expect(payload.request.method).toBe('GET');
      expect(payload.request.url).toContain('api.example.com');
      expect(typeof payload.elapsedTime).toBe('number');
      // 失败请求额外 push 一条 Error 级面包屑
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: BreadCrumbTypes.XHR, level: 'error' }),
      );
    });

    it('status 为 0 且耗时短应判定为跨域/域名不存在', () => {
      HandleEvents.handleHttp(
        buildHttp({ status: 0, elapsedTime: 10, responseText: '' }),
        BreadCrumbTypes.XHR,
      );
      const payload = payloadOf(sendSpy);
      expect(payload.response.status).toBe(0);
      expect(payload.message).toContain('跨域');
    });

    it('status 为 0 且耗时长应判定为超时', () => {
      HandleEvents.handleHttp(buildHttp({ status: 0, elapsedTime: 5000 }), BreadCrumbTypes.XHR);
      const payload = payloadOf(sendSpy);
      expect(payload.message).toContain('超时');
    });

    it('fetch 失败应上报且 name 前缀为 fetch--', () => {
      HandleEvents.handleHttp(
        buildHttp({ type: HttpTypes.FETCH, method: 'POST', status: 502 }),
        BreadCrumbTypes.FETCH,
      );
      const payload = payloadOf(sendSpy);
      expect(payload.type).toBe(ErrorTypes.FETCH_ERROR);
      expect(payload.name).toBe('fetch--POST');
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: BreadCrumbTypes.FETCH }),
      );
    });

    it('失败请求应携带请求体与响应体', () => {
      HandleEvents.handleHttp(
        buildHttp({
          status: 500,
          reqData: JSON.stringify({ id: 1 }),
          responseText: '{"error":"db down"}',
        }),
        BreadCrumbTypes.XHR,
      );
      const payload = payloadOf(sendSpy);
      expect(payload.request.data).toContain('id');
      expect(payload.response.data).toContain('db down');
    });

    it('status 为 0 时 message 仍会拼接归一化后的接口地址', () => {
      HandleEvents.handleHttp(
        buildHttp({
          status: 0,
          elapsedTime: 10,
          url: 'https://api.example.com/order/123?from=app',
        }),
        BreadCrumbTypes.XHR,
      );
      expect(payloadOf(sendSpy).message).toBe(
        'http请求失败，失败原因：跨域限制或域名不存在 https://api.example.com/order{param}',
      );
    });

    it.each([
      { status: 0, expected: '上报' },
      { status: 400, expected: '上报' },
      { status: 401, expected: '上报' },
      { status: 402, expected: '上报' },
      { status: 403, expected: '上报' },
      { status: 405, expected: '上报' },
      { status: 418, expected: '上报' },
      { status: 429, expected: '上报' },
      { status: 451, expected: '上报' },
      { status: 499, expected: '上报' },
      { status: 500, expected: '上报' },
      { status: 503, expected: '上报' },
      { status: 599, expected: '上报' },
      { status: 600, expected: '上报' },
      { status: 200, expected: '不上报' },
      { status: 204, expected: '不上报' },
      { status: 206, expected: '不上报' },
      { status: 299, expected: '不上报' },
      { status: 301, expected: '不上报' },
      { status: 302, expected: '不上报' },
      { status: 303, expected: '不上报' },
      { status: 304, expected: '不上报' },
      { status: 307, expected: '不上报' },
      { status: 308, expected: '不上报' },
      { status: 399, expected: '不上报' },
    ])('status $status 应$expected（isHttpFail 判定）', ({ status, expected }) => {
      HandleEvents.handleHttp(buildHttp({ status }), BreadCrumbTypes.XHR);
      if (expected === '上报') {
        expect(sendSpy).toHaveBeenCalledTimes(1);
      } else {
        expect(sendSpy).not.toHaveBeenCalled();
      }
    });

    it.each([
      { status: 400, span: SpanStatus.InvalidArgument },
      { status: 401, span: SpanStatus.Unauthenticated },
      { status: 403, span: SpanStatus.PermissionDenied },
      { status: 404, span: SpanStatus.NotFound },
      { status: 409, span: SpanStatus.AlreadyExists },
      { status: 413, span: SpanStatus.FailedPrecondition },
      { status: 429, span: SpanStatus.ResourceExhausted },
      { status: 500, span: SpanStatus.InternalError },
      { status: 501, span: SpanStatus.Unimplemented },
      { status: 502, span: SpanStatus.InternalError },
      { status: 503, span: SpanStatus.Unavailable },
      { status: 504, span: SpanStatus.DeadlineExceeded },
    ])('status $status 的 message 应为「$span + 归一化 url」', ({ status, span }) => {
      HandleEvents.handleHttp(buildHttp({ status }), BreadCrumbTypes.XHR);
      expect(payloadOf(sendSpy).message).toBe(`${span} https://api.example.com/user/list`);
    });

    it.each([
      {
        status: 418,
        span: SpanStatus.InvalidArgument,
        label: '4xx 未枚举状态落到 invalid_argument',
      },
      { status: 599, span: SpanStatus.InternalError, label: '5xx 未枚举状态落到 internal_error' },
      { status: 600, span: SpanStatus.UnknownError, label: '6xx 落到 unknown_error' },
    ])('$label', ({ status, span }) => {
      HandleEvents.handleHttp(buildHttp({ status }), BreadCrumbTypes.XHR);
      expect(payloadOf(sendSpy).message).toContain(span);
    });

    it('上报载荷等级固定为 low', () => {
      HandleEvents.handleHttp(buildHttp({ status: 500 }), BreadCrumbTypes.XHR);
      expect(payloadOf(sendSpy).level).toBe(Severity.Low);
    });

    it('响应体缺失时不抛错，但 response.data 不会兜底为空串（记录当前实现的不对称）', () => {
      expect(() =>
        HandleEvents.handleHttp(
          buildHttp({ status: 500, responseText: undefined }),
          BreadCrumbTypes.XHR,
        ),
      ).not.toThrow();
      const payload = payloadOf(sendSpy);
      // request.data 有 `|| ''` 兜底，response.data 直接透传
      expect(payload.request.data).toBe('');
      expect(payload.response.data).toBeUndefined();
    });
  });

  describe('成功请求（不上报，仅记面包屑）', () => {
    it.each([200, 204, 301, 302, 304])('status %s 不应触发 send', (status) => {
      HandleEvents.handleHttp(buildHttp({ status }), BreadCrumbTypes.XHR);

      expect(sendSpy).not.toHaveBeenCalled();
      // 仍应 push 一条 Info 级 HTTP 面包屑
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: BreadCrumbTypes.XHR, level: 'info' }),
      );
    });

    it('成功请求也会把请求体/响应体写入面包屑（XHR 未截断，记录当前行为）', () => {
      const bigBody = 'x'.repeat(5000);
      HandleEvents.handleHttp(
        buildHttp({ status: 200, reqData: '{"big":"payload"}', responseText: bigBody }),
        BreadCrumbTypes.XHR,
      );

      expect(sendSpy).not.toHaveBeenCalled();
      const pushed = pushedOf(pushSpy);
      expect(pushed.level).toBe(Severity.Info);
      expect(pushed.category).toBe(BreadCrumbCategory.HTTP);
      // 注意：成功请求的完整响应体也进入了面包屑（最多 10 条）→ 上报 payload 膨胀风险
      expect(pushed.data.response.data).toBe(bigBody);
      expect(pushed.data.request.data).toBe('{"big":"payload"}');
    });
  });

  describe('面包屑（breadcrumb）行为', () => {
    it('失败请求：Info(http) + Error(exception) 两条同名面包屑，数据一致', () => {
      HandleEvents.handleHttp(buildHttp({ status: 500, time: 111 }), BreadCrumbTypes.XHR);

      expect(pushSpy).toHaveBeenCalledTimes(2);
      const first = pushedOf(pushSpy, 0);
      const second = pushedOf(pushSpy, 1);

      expect(first).toMatchObject({
        type: BreadCrumbTypes.XHR,
        category: BreadCrumbCategory.HTTP,
        level: Severity.Info,
        time: 111,
      });
      expect(second).toMatchObject({
        type: BreadCrumbTypes.XHR,
        category: BreadCrumbCategory.EXCEPTION,
        level: Severity.Error,
        time: 111,
      });
      // 两条面包屑携带同一份 result 快照（结构相同，但是两次独立浅拷贝）
      expect(first.data).toEqual(second.data);
      expect(first.data).not.toBe(second.data);
    });

    it('成功请求：仅一条 Info(http) 面包屑', () => {
      HandleEvents.handleHttp(buildHttp({ status: 200 }), BreadCrumbTypes.XHR);
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(pushedOf(pushSpy)).toMatchObject({
        category: BreadCrumbCategory.HTTP,
        level: Severity.Info,
      });
    });

    it('type 入参决定面包屑类型，data.type 决定上报的 name / httpType', () => {
      HandleEvents.handleHttp(
        buildHttp({ type: HttpTypes.XHR, status: 500 }),
        BreadCrumbTypes.FETCH,
      );

      expect(pushedOf(pushSpy).type).toBe(BreadCrumbTypes.FETCH);
      expect(pushedOf(pushSpy).category).toBe(BreadCrumbCategory.HTTP);
      expect(payloadOf(sendSpy).name).toBe('xhr--GET');
      expect(payloadOf(sendSpy).request.httpType).toBe(HttpTypes.XHR);
    });
  });

  describe('上报载荷（ReportDataType）字段', () => {
    it('url 为页面地址，request.url 保留原始接口地址，message 使用归一化地址', () => {
      HandleEvents.handleHttp(
        buildHttp({ status: 500, url: 'https://api.example.com/order/123?page=1' }),
        BreadCrumbTypes.XHR,
      );
      const payload = payloadOf(sendSpy);
      expect(payload.url).toBe(getLocationHref());
      expect(payload.request.url).toBe('https://api.example.com/order/123?page=1');
      expect(payload.message).toBe('internal_error https://api.example.com/order{param}');
    });

    it('traceId / elapsedTime / time 应透传', () => {
      HandleEvents.handleHttp(
        buildHttp({ status: 500, traceId: 'trace-abc', elapsedTime: 123, time: 456 }),
        BreadCrumbTypes.XHR,
      );
      const payload = payloadOf(sendSpy);
      expect(payload.request.traceId).toBe('trace-abc');
      expect(payload.elapsedTime).toBe(123);
      expect(payload.time).toBe(456);
    });

    it('reqData 为非字符串（对象等）时原样透传，不做序列化或截断', () => {
      const formLike = { field: 'value' } as any;
      HandleEvents.handleHttp(buildHttp({ status: 500, reqData: formLike }), BreadCrumbTypes.XHR);
      expect(payloadOf(sendSpy).request.data).toBe(formLike);
    });
  });

  describe('边界与鲁棒性（记录当前实现）', () => {
    it('status 为 0 时按 elapsedTime 与阈值判定（<= 阈值算跨域）', () => {
      // crossOriginThreshold 默认 1000
      HandleEvents.handleHttp(buildHttp({ status: 0, elapsedTime: 1000 }), BreadCrumbTypes.XHR);
      expect(payloadOf(sendSpy, 0).message).toContain('跨域');

      HandleEvents.handleHttp(buildHttp({ status: 0, elapsedTime: 1001 }), BreadCrumbTypes.XHR);
      expect(payloadOf(sendSpy, 1).message).toContain('超时');

      HandleEvents.handleHttp(buildHttp({ status: 0, elapsedTime: 0 }), BreadCrumbTypes.XHR);
      expect(payloadOf(sendSpy, 2).message).toContain('跨域');
    });

    it('status 为 0 且 elapsedTime 缺失时会被判为超时', () => {
      HandleEvents.handleHttp(
        buildHttp({ status: 0, elapsedTime: undefined }),
        BreadCrumbTypes.XHR,
      );
      expect(payloadOf(sendSpy).message).toContain('超时');
    });

    it('status 为字符串 "0" 时行为不一致：既上报又被判成 ok', () => {
      // handleHttp 用 Number(status) 判定失败，httpTransform 用 status === 0 严格比较
      HandleEvents.handleHttp(buildHttp({ status: '0' as unknown as number }), BreadCrumbTypes.XHR);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(payloadOf(sendSpy).message).toBe(SpanStatus.Ok);
    });

    it('method 缺失时 name 会退化为 "xhr--undefined"', () => {
      HandleEvents.handleHttp(buildHttp({ status: 500, method: undefined }), BreadCrumbTypes.XHR);
      expect(payloadOf(sendSpy).name).toBe('xhr--undefined');
    });
  });
});
