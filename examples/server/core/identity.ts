import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CollectorConfig } from '../config';
import { IdentityKind } from '../db/types';
import { extractToken, TokenClaims, verifyToken } from './token';
import {
  createUserVisitorId,
  createVisitorId,
  getClientIp,
  hashIp,
  maskIp,
  normalizeIp,
} from './visitor';

/**
 * ============================================================================
 * 身份识别中间件：把「请求」翻译成「这次上报是谁」
 * ============================================================================
 *
 * 职责边界：
 * - 只做识别（解析 token、取 IP、派生 visitorId），不做授权决策的最终执行；
 * - 真正的「要不要 401」在 identityMiddleware 里按 config.tokenStrict + 路径决定；
 * - 识别结果挂到 req.identity，下游（collect / stats / normalize）只读，不重新解析。
 *
 * 判定矩阵（token 来源见 core/token.ts 的 extractToken）：
 *
 *   token 情况            strict=0（默认）                     strict=1
 *   ─────────────────────────────────────────────────────────────────────────
 *   没有 token            匿名访客；采集照收；查询照常           采集照收；/api/stats*、/api/alerts* → 401
 *   有且合法              identityKind='token'，userId=sub     同左（全部放行）
 *   有但非法              降级匿名 + 告警日志；采集照收           401（采集与查询都拒绝）
 *
 * 为什么默认「非法 token 也降级匿名而不是拒绝」：
 * 前端 token 过期是常态（2 小时有效），如果因为 token 过期就丢掉用户真实的错误上报，
 * 排查线上问题时最需要的数据反而没了。数据完整性优先，鉴权失败只做标注
 * （响应头 x-identity-kind=anonymous + 日志），由业务侧自行决策。
 */

export type TokenStatus = 'none' | 'valid' | 'invalid';

/**
 * 一次请求的身份上下文：有 token 用 token，没有就用 IP+UA 派生匿名访客。
 *
 * 字段语义：
 * - visitorId    ：写入 events.visitor_id，是 UV / 影响用户数 / 限流的唯一 key；
 *                  有 sub 时为 'u_…'（按账号），否则 'v_…'（按 网络+UA）；
 * - identityKind ：写入 events.identity_kind，统计时可以按「登录/匿名」拆开看；
 * - userId       ：只是 token 里的 sub 原文，不做任何加工（方便与业务库对齐）；
 * - tokenJti     ：token 唯一 id，排障时可用它反查「同一张 token 的所有上报」；
 * - tokenStatus / tokenReason：识别过程的诊断信息，不落库（避免把失败原因写进明细）；
 * - ip / ipHash / ipPrefix：ip 仅在本进程内用于派生 id，落库只写后两个（隐私要求）；
 * - ua           ：已截断到 512 字符，防止超长 UA 把行撑大。
 */
export interface Identity {
  visitorId: string;
  identityKind: IdentityKind;
  userId: string | null;
  tokenJti: string | null;
  tokenStatus: TokenStatus;
  tokenReason?: string;
  claims?: TokenClaims;
  ip: string;
  ipHash: string;
  ipPrefix: string;
  ua: string;
}

/** 挂到 req 上的键名，避免和其他中间件冲突（用常量而不是字符串字面量，防止拼写错误） */
export const IDENTITY_KEY = 'identity';

/**
 * 纯函数版身份解析（不依赖 express Response，方便单测直接调用）。
 *
 * 执行步骤：
 *   1. 取 UA（截断 512）与 IP（XFF → X-Real-IP → socket，见 visitor.ts）
 *   2. 立刻算出 ipHash / ipPrefix —— 明文 ip 只在函数内部流转，不会进入 Identity.ip 之外的落库路径
 *   3. 找 token：没有 → 匿名分支（tokenStatus='none'）
 *   4. 有 token 就验签：失败 → 匿名分支（tokenStatus='invalid' + reason，用于日志/401 文案）
 *   5. 验签通过：有 sub 用 'u_' 派生、没 sub 退回 'v_' 派生，identityKind 恒为 'token'
 *
 * 注意：非法 token 也返回 identityKind='anonymous'，因为这条数据最终会以匿名身份落库，
 * 不能因为「带了 token 但过期」就在库里写成 identity_kind='token'（会让登录用户统计虚高）。
 */
export function resolveIdentity(
  req: Pick<Request, 'headers' | 'query' | 'body' | 'socket'>,
  config: CollectorConfig,
): Identity {
  const ua = String(req.headers['user-agent'] || '').slice(0, 512);
  const ip = getClientIp({
    headers: req.headers as Record<string, unknown>,
    socketAddress: req.socket && req.socket.remoteAddress,
    trustProxy: true,
  });
  // 落库只保存 hash 与脱敏网段；anonymizeIp=false 时才保存完整（归一化后的）IP
  const ipHash = hashIp(ip, config.visitorSalt);
  const ipPrefix = config.anonymizeIp ? maskIp(ip) : normalizeIp(ip);

  const token = extractToken({
    headers: req.headers as Record<string, unknown>,
    query: req.query as Record<string, unknown>,
    body: req.body,
  });

  if (!token) {
    // 完全没带 token：正常的匿名上报，不是错误，不打日志
    return {
      visitorId: createVisitorId(ip, ua, config.visitorSalt),
      identityKind: 'anonymous',
      userId: null,
      tokenJti: null,
      tokenStatus: 'none',
      ip,
      ipHash,
      ipPrefix,
      ua,
    };
  }

  const verified = verifyToken(token, config.tokenSecret, { issuer: config.tokenIssuer });
  if (verified.ok === false) {
    // 带了但验不过：降级为匿名，同时把 reason 带出去（严格模式下会拼进 401 文案）
    return {
      visitorId: createVisitorId(ip, ua, config.visitorSalt),
      identityKind: 'anonymous',
      userId: null,
      tokenJti: null,
      tokenStatus: 'invalid',
      tokenReason: verified.reason,
      ip,
      ipHash,
      ipPrefix,
      ua,
    };
  }

  const claims = verified.claims;
  // sub 为空视为「没有用户身份」：仍然算 token 有效，但访客 id 回落到 IP+UA
  const userId = typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  return {
    visitorId: userId
      ? createUserVisitorId(userId, config.visitorSalt)
      : createVisitorId(ip, ua, config.visitorSalt),
    identityKind: 'token',
    userId,
    tokenJti: typeof claims.jti === 'string' ? claims.jti : null,
    tokenStatus: 'valid',
    claims,
    ip,
    ipHash,
    ipPrefix,
    ua,
  };
}

/**
 * 查询类接口（/api/stats*、/api/alerts*）在严格模式下必须有合法 token。
 *
 * 用 startsWith 而不是精确匹配：/api/stats/errors、/api/stats/pv 都要覆盖；
 * 采集接口（/api/collect/*、/errors/upload、/pv/upload）刻意不在名单里，
 * 保证「token 配错也照样收数据」，否则一次 token 事故会让监控整体瞎掉。
 */
function isProtectedPath(path: string): boolean {
  return path.startsWith('/api/stats') || path.startsWith('/api/alerts');
}

/**
 * 身份识别中间件。
 *
 * 策略：
 * - 采集接口（/errors/upload、/pv/upload、/api/collect/*）：token 可有可无，
 *   以「不丢数据」为第一优先，token 非法时降级为匿名并在响应头标注；
 * - 查询 / 预警管理接口：TOKEN_STRICT=1 时要求合法 token，否则 401。
 *
 * 副作用（每个响应都会带上，便于前端/测试自检）：
 *   x-visitor-id     ：本次请求算出来的访客 id（与落库一致）
 *   x-identity-kind  ：'token' | 'anonymous'，可以直接看出 token 有没有生效
 *
 * 注意 401 的两处来源，含义不同：
 *   1. token 非法 + strict=1 → 任何路径都 401，message 里带具体 reason；
 *   2. 没有 token（或非法）+ strict=1 + 受保护路径 → 401，message 是「缺少合法 token」。
 */
export function identityMiddleware(config: CollectorConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const identity = resolveIdentity(req, config);
    (req as Request & { identity: Identity })[IDENTITY_KEY] = identity;
    res.setHeader('x-visitor-id', identity.visitorId);
    res.setHeader('x-identity-kind', identity.identityKind);

    if (identity.tokenStatus === 'invalid') {
      // token 存在但校验失败：严格模式下拒绝，否则记下来继续采集
      if (config.tokenStrict) {
        res.status(401).json({
          code: 401,
          message: `token 校验失败：${identity.tokenReason}`,
          data: null,
        });
        return;
      }
      // 只在非严格模式下打日志：严格模式已经返回 401，不需要再刷一行
      console.warn(`[identity] token 校验失败（${identity.tokenReason}），已降级为匿名访客`);
    }

    // 没有 token 的情况：只有 TOKEN_STRICT=1 且是受保护路径才拦
    if (config.tokenStrict && identity.tokenStatus !== 'valid' && isProtectedPath(req.path)) {
      res.status(401).json({ code: 401, message: '缺少合法 token', data: null });
      return;
    }

    next();
  };
}

/**
 * 取当前请求的身份（中间件一定已执行）。
 *
 * 兜底逻辑只在「没挂中间件就直接调路由」时生效（例如单测里直接调用 handler）：
 * 此时用一份最小配置重新解析一次，保证不返回 undefined 把调用方搞崩。
 * 兜底配置的 tokenSecret 为空串 → 任何 token 都验不过 → 结果是匿名身份，这是安全的方向。
 */
export function getIdentity(req: Request): Identity {
  const identity = (req as Request & { identity?: Identity })[IDENTITY_KEY];
  if (identity) return identity;
  // 兜底：理论上不会走到，方便单测直接调路由
  return resolveIdentity(req, {
    visitorSalt: 'fallback',
    anonymizeIp: true,
    tokenSecret: '',
    tokenIssuer: undefined,
    tokenStrict: false,
    tokenAlgorithms: ['HS256'],
  } as CollectorConfig);
}
