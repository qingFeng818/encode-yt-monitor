import { describe, it, expect } from 'vitest';
import { SpanStatus, fromHttpStatus, fromHttpStatusText } from 'encode-yt-monitor-utils';

/**
 * 这两个函数决定上报 message 的可读性：
 * - fromHttpStatus 输出机器可读的 SpanStatus，外部消费方按枚举匹配，枚举值改动等于破坏兼容；
 * - fromHttpStatusText 输出中文描述，是值班同学定位问题的第一手信息。
 *
 * 之前没有任何直接用例（只有一个「message 包含某段文案」的间接断言），
 * 400~504 之外的兜底分支（418 / 599 / 302 / 999）完全没人覆盖。
 */

describe('fromHttpStatus（HTTP 状态码 -> SpanStatus）', () => {
  it.each([
    { code: 200, expected: SpanStatus.Ok },
    { code: 204, expected: SpanStatus.Ok },
    { code: 301, expected: SpanStatus.Ok },
    { code: 400, expected: SpanStatus.InvalidArgument },
    { code: 401, expected: SpanStatus.Unauthenticated },
    { code: 403, expected: SpanStatus.PermissionDenied },
    { code: 404, expected: SpanStatus.NotFound },
    { code: 409, expected: SpanStatus.AlreadyExists },
    { code: 413, expected: SpanStatus.FailedPrecondition },
    { code: 429, expected: SpanStatus.ResourceExhausted },
    { code: 418, expected: SpanStatus.InvalidArgument },
    { code: 500, expected: SpanStatus.InternalError },
    { code: 501, expected: SpanStatus.Unimplemented },
    { code: 503, expected: SpanStatus.Unavailable },
    { code: 504, expected: SpanStatus.DeadlineExceeded },
  ])('$code -> $expected', ({ code, expected }) => {
    expect(fromHttpStatus(code)).toBe(expected);
  });

  it('4xx 里没有列举的状态码统一落到 InvalidArgument', () => {
    expect(fromHttpStatus(402)).toBe(SpanStatus.InvalidArgument);
    expect(fromHttpStatus(499)).toBe(SpanStatus.InvalidArgument);
  });

  it('5xx 里没有列举的状态码统一落到 InternalError', () => {
    expect(fromHttpStatus(502)).toBe(SpanStatus.InternalError);
    expect(fromHttpStatus(599)).toBe(SpanStatus.InternalError);
  });

  it('>= 600 属于非标准状态码，返回 UnknownError', () => {
    expect(fromHttpStatus(600)).toBe(SpanStatus.UnknownError);
    expect(fromHttpStatus(1000)).toBe(SpanStatus.UnknownError);
  });

  it('status = 0（网络层失败）会命中 < 400 分支返回 Ok，调用方必须先排除 0', () => {
    // 记录现有契约：httpTransform 对 status === 0 单独判定「跨域 / 超时」，不会走到这里；
    // 如果哪天有人把 0 直接丢进来，message 会变成 'ok'，这条用例能把这种回归暴露出来。
    expect(fromHttpStatus(0)).toBe(SpanStatus.Ok);
  });
});

describe('fromHttpStatusText（HTTP 状态码 -> 中文描述）', () => {
  it.each([
    { code: 400, expected: '请求参数错误' },
    { code: 401, expected: '未授权或登录态失效' },
    { code: 403, expected: '无访问权限' },
    { code: 404, expected: '请求的资源不存在' },
    { code: 405, expected: '请求方法不被允许' },
    { code: 408, expected: '请求超时' },
    { code: 409, expected: '资源冲突' },
    { code: 413, expected: '请求体过大' },
    { code: 429, expected: '请求过于频繁' },
    { code: 500, expected: '服务端内部错误' },
    { code: 501, expected: '服务未实现' },
    { code: 502, expected: '网关错误' },
    { code: 503, expected: '服务不可用' },
    { code: 504, expected: '网关超时' },
  ])('$code -> $expected', ({ code, expected }) => {
    expect(fromHttpStatusText(code)).toBe(expected);
  });

  it.each([
    { code: 418, expected: '客户端请求异常' },
    { code: 599, expected: '服务端异常' },
    { code: 302, expected: '请求成功' },
    { code: 999, expected: '未知状态码' },
    { code: 0, expected: '未知状态码' },
  ])('兜底文案：$code -> $expected', ({ code, expected }) => {
    expect(fromHttpStatusText(code)).toBe(expected);
  });
});
