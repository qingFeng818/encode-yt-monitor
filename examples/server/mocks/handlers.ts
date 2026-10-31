import { rest } from 'msw';

/**
 * ============================================================================
 * MSW 请求 mock（仅供 SDK 单测使用，不参与 examples/server 的真实服务）
 * ============================================================================
 *
 * 用途：在 vitest / jest 里拦截 SDK 发出的上报请求，避免真的打到网络。
 * 与本目录外的采集服务是**两套东西**：
 * - 这里只返回「看起来成功」的响应体，不落库、不做幂等；
 * - 真实链路（限流 / 归一化 / 写队列 / 预警）请看 routes/ 与 core/。
 *
 * 注意：路径是相对路径（'/error/upload'），由 msw 按「同源」规则匹配，
 * 因此单测里 SDK 的 dsn 需要配成相对路径或与测试的 baseUrl 一致。
 */
export const handlers = [
  // 错误上报：只返回 message，SDK 侧只关心 HTTP 200
  rest.post('/error/upload', (req, res, ctx) => {
    return res(
      ctx.json({
        message: '上传成功',
      }),
    );
  }),
  // 正常接口（200）：用于验证 SDK 不会把成功请求误判为接口异常
  rest.get('/normal', (req, res, ctx) => {
    return res(
      ctx.json({
        code: 200,
        message: '这是正常接口',
      }),
    );
  }),
];
