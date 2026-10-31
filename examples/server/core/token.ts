import { createHmac, timingSafeEqual } from 'crypto';

/**
 * ============================================================================
 * 极简 JWT（HS256）签发 / 校验
 * ============================================================================
 *
 * 为什么手写而不是引三方库：
 * - demo 想保持零额外依赖（离线环境装不了 jsonwebtoken）；
 * - 只支持 HS256，正好覆盖「内部服务签发 token 给前端上报」的场景；
 * - 如果生产要用 RS256 / JWKS，可以替换这个文件，对外接口（signToken / verifyToken /
 *   extractToken）保持不变，identity.ts 不用改。
 *
 * token 结构（三段 base64url，用 . 分隔）：
 *
 *   header.payload.signature
 *   header    = { "alg":"HS256", "typ":"JWT" }
 *   payload   = { sub, jti, iss, aud, iat, nbf, exp, ...自定义字段 }
 *   signature = HMAC-SHA256(base64url(header) + "." + base64url(payload), secret)
 *
 * 本文件只做「密码学层面」的事，不做业务决策：
 * 校验失败返回 { ok:false, reason }，由调用方（identity.ts）决定是 401 还是降级匿名。
 * 这种分层让「采集接口绝不丢数据」和「管理接口必须鉴权」两种策略可以共存。
 */

export interface TokenClaims {
  /** 用户唯一标识，落到 events.user_id */
  sub?: string;
  /** token 唯一 id，便于吊销 / 追溯 */
  jti?: string;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  nbf?: number;
  /** 过期时间（秒） */
  exp?: number;
  [key: string]: unknown;
}

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'not-active' | 'bad-issuer' };

// base64url（RFC 4648 §5）：把 +/ 换成 -_，并去掉尾部 =，好处是可以直接放进 URL / query
// 图片上报（img.src）只能通过 query 传 token，用标准 base64 会因 +/= 被转义或截断
function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8');
}

/** HMAC-SHA256 签名；用同一份 secret 对 header.payload 原文签名（不是对解码后的对象） */
function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * 签发 HS256 token。
 *
 * @param claims     业务声明，至少给 sub（用户 id）；scope 之类的自定义字段会被原样带上
 * @param secret     HMAC 密钥，必须与校验方一致（生产环境用 TOKEN_SECRET）
 * @param ttlSeconds 有效期，默认 2 小时；从「当前时间」开始算
 *
 * 两个容易踩的语义点：
 * 1. 默认值 (iat / exp / jti) 写在 ...claims 之前，所以调用方显式传 iat/exp 会覆盖默认值
 *    —— 这是有意为之：签发离线测试 token 时可以指定任意有效期；
 * 2. jti 只用于「追溯 / 吊销凭证」，服务端并不校验它（无状态 JWT 的常规取舍）；
 *    需要强制吊销就得在服务端维护 jti 黑名单，本 demo 不做。
 */
export function signToken(
  claims: TokenClaims,
  secret: string,
  ttlSeconds = 2 * 60 * 60,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenClaims = {
    iat: now,
    exp: now + ttlSeconds,
    jti: claims.jti || `jti_${Math.random().toString(36).slice(2, 10)}`,
    ...claims,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

/**
 * 校验 HS256 token。
 *
 * 校验顺序（先廉价后昂贵，且先验签再读 claims，避免把伪造的 payload 用于业务判断）：
 *   1. 结构：必须是 3 段，header 必须能解出 JSON 且 alg === 'HS256'
 *      （拒绝 alg=none / RS256 等，防「算法混淆」攻击）
 *   2. 签名：用 timingSafeEqual 比较，长度不同直接判失败
 *      （timingSafeEqual 要求两个 Buffer 等长，否则会抛异常）
 *   3. 时间：exp（过期）、nbf（未生效）；均为秒级时间戳，缺省视为不限制
 *   4. 签发方：配置了 issuer 且 token 自带 iss 时才比较（token 没写 iss 视为通过）
 *
 * @returns ok=true + claims；ok=false + reason ∈
 *          'malformed' | 'bad-signature' | 'expired' | 'not-active' | 'bad-issuer'
 *          —— reason 会被写进响应（严格模式）或日志（降级模式），便于排查「为什么没认出来」。
 * @param options.now 可注入的当前时间（单测用它模拟过期，不用真的等 2 小时）
 */
export function verifyToken(
  token: string,
  secret: string,
  options: { issuer?: string; now?: number } = {},
): VerifyResult {
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };

  const [header, body, signature] = parts;
  let parsedHeader: { alg?: string };
  let claims: TokenClaims;
  try {
    parsedHeader = JSON.parse(base64UrlDecode(header));
    claims = JSON.parse(base64UrlDecode(body));
  } catch (error) {
    // base64 或 JSON 解析失败，都归为「结构不合法」
    return { ok: false, reason: 'malformed' };
  }
  if (!parsedHeader || parsedHeader.alg !== 'HS256') return { ok: false, reason: 'malformed' };

  const expected = sign(`${header}.${body}`, secret);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  if (
    // 先比长度：timingSafeEqual 对不等长输入会抛错，同时长度不等本身就不可能是合法签名
    expectedBuffer.length !== actualBuffer.length ||
    // 定长比较，避免通过响应时间差做逐字节爆破
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return { ok: false, reason: 'bad-signature' };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  // exp 用 >= 判断：正好到期的这一秒就算过期（与 jwt 规范的 "now >= exp 即失效" 一致）
  if (typeof claims.exp === 'number' && now >= claims.exp) return { ok: false, reason: 'expired' };
  if (typeof claims.nbf === 'number' && now < claims.nbf) return { ok: false, reason: 'not-active' };
  if (options.issuer && claims.iss && claims.iss !== options.issuer) {
    return { ok: false, reason: 'bad-issuer' };
  }
  return { ok: true, claims };
}

/**
 * 从请求里取 token（只负责「找」，不负责「验」）。
 *
 * 三个来源，优先级从高到低：
 * 1. Authorization: Bearer xxx（XHR / fetch 推荐，不落 URL / 日志）
 * 2. 查询参数 ?token=（图片上报 img.src 带不了 header，只能走 query）
 * 3. 报文体里的 token 字段（老客户端兼容）
 *
 * 语义细节：
 * - 正则带 i 标志且允许前后空白，兼容 "bearer  xxx"、"Bearer\txxx"；
 * - 只接受 "Bearer <token>"，其它 scheme（Basic/Digest）一律忽略，避免把别的凭证当 JWT 验；
 * - 空串一律视为「没传」，交给调用方走匿名分支，而不是当作「非法 token」。
 */
export function extractToken(input: {
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}): string | undefined {
  const headers = input.headers || {};
  // Node 会把 header 名统一小写，但单测里可能直接构造 headers 对象，所以两种都查一下
  const authorization = headers.authorization || headers.Authorization;
  if (typeof authorization === 'string') {
    const matched = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (matched) return matched[1].trim();
  }
  const query = input.query || {};
  if (typeof query.token === 'string' && query.token) return query.token;
  const body = input.body as { token?: unknown } | undefined;
  if (body && typeof body === 'object' && typeof body.token === 'string' && body.token) {
    return body.token;
  }
  return undefined;
}
