import { createHash } from 'crypto';

/**
 * ============================================================================
 * IP 归一化 / 脱敏 / 访客 id 派生
 * ============================================================================
 *
 * 本模块是「匿名身份」的唯一来源，被 identity.ts 调用；不依赖 express，纯函数，方便单测。
 *
 * 隐私原则：**明文 IP 不落库**。
 * - ipHash   ：sha256(ip + salt) 前 16 位，仅用于「同一 IP 多次上报」的相关性分析，不可逆；
 * - ipPrefix ：脱敏网段（IPv4 前两段 / IPv6 前四组），用于地域、机房、网段级排查；
 * - visitorId：无 token 时用 (ip + ua + salt) 派生，同一出口 IP + 同一浏览器 = 同一访客。
 *
 * 三条必须知道的语义边界：
 * 1. 同一 NAT 出口（公司/校园网）下的多个用户，ip 相同、UA 相同 → 会被算成同一个访客（UV 偏小）；
 *    想要更准就叠加 SDK 的 authInfo.trackerId 或让网关注入设备号。
 * 2. salt 一变，visitorId 全变（历史数据无法再关联），多实例部署必须共用同一个 salt。
 * 3. UA 会随浏览器大版本升级而变（Chrome 120→121），会导致「老访客变成新访客」，
 *    这是基于 (ip+ua) 方案的固有缺陷，属于可接受的取舍。
 */

/** 极简 IPv4 判定（只用于「脱敏 / 去端口」这类轻量场景，不做严格校验） */
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * 取 sha256 十六进制的前 length 位。
 * 截断是为了让 id 短一些（存储 / 日志友好），16 位 hex = 64 bit，碰撞概率在「亿级 IP」量级仍然可忽略。
 */
function sha256Hex(input: string, length = 16): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/**
 * 从请求里取「真实客户端 IP」。
 *
 * 取值顺序（trustProxy=true 时）：
 *   1. X-Forwarded-For 的第一跳（最靠近客户端的那段）—— 后面几跳是各级代理
 *   2. X-Real-IP（nginx 常用）
 *   3. socket.remoteAddress（直连时就是客户端 IP）
 *
 * 安全提示：XFF 是客户端可伪造的头部。这里 trustProxy 默认 true 是为了本地 demo 方便
 * （SDK 页面可能在 5173 端口，经 vite 代理转发）；公网直连时必须把 trustProxy 设为 false，
 * 或只在反向代理后面接受该头，否则攻击者可以伪造成任意 IP 骗取「新访客」身份绕过限流。
 *
 * @returns 归一化后的 IP；取不到时返回空串（而不是 'unknown'，让上层决定如何兜底）
 */
export function getClientIp(input: {
  headers?: Record<string, unknown>;
  socketAddress?: string | null;
  trustProxy?: boolean;
}): string {
  const headers = input.headers || {};
  // 注意默认值是 true（只有显式传 false 才忽略转发头）
  const trustProxy = input.trustProxy !== false;

  if (trustProxy) {
    const forwarded = headers['x-forwarded-for'];
    // express 一般给字符串；个别场景（数组头）取第一个
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof forwardedValue === 'string' && forwardedValue.length > 0) {
      // 取第一跳（最靠近客户端），后面的都是代理链路
      // 形如 "1.2.3.4, 10.0.0.1, 10.0.0.2"
      const first = forwardedValue.split(',')[0].trim();
      if (first) return normalizeIp(first);
    }
    const realIp = headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.length > 0) return normalizeIp(realIp);
  }

  return normalizeIp(input.socketAddress || '');
}

/**
 * 归一化 IP：去掉 IPv6-mapped 前缀与端口，统一小写。
 *
 * 处理的三种常见形态（不归一化会导致同一客户端被算成不同访客）：
 *   "[::1]:1234"        → "::1"      （IPv6 带端口，Node 的 remoteAddress 格式）
 *   "1.2.3.4:5678"      → "1.2.3.4"  （IPv4 带端口）
 *   "::ffff:1.2.3.4"    → "1.2.3.4"  （双栈监听时 IPv4 被映射成 IPv6）
 * 大小写统一为小写，因为 IPv6 地址大小写不敏感（等价写法必须得到同一个 hash）。
 */
export function normalizeIp(raw: string): string {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[')) {
    // [::1]:1234
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  } else if (IPV4_RE.test(ip.split(':')[0]) && ip.split(':').length === 2) {
    // 1.2.3.4:5678
    ip = ip.split(':')[0];
  }
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  return ip.toLowerCase();
}

/**
 * IP 脱敏：IPv4 保留前两段（1.2.x.x），IPv6 保留前四组（xxxx:xxxx:xxxx:xxxx::/64）。
 *
 * 语义说明：
 * - 保留「两段 / 64 位」是为了还能做「城市级 / 单个 /64 网段」的聚类分析，
 *   同时无法定位到具体个人；
 * - 拿不到 IP 时返回 'unknown'（而不是空串），让数据里能明确看出「没取到」；
 * - IPv6 用 "::/64" 后缀表示这是一个网段而不是完整地址，避免被误当成可解析的 IP。
 */
export function maskIp(ip: string): string {
  if (!ip) return 'unknown';
  if (IPV4_RE.test(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.x.x`;
  }
  const groups = ip.split(':').filter((item) => item.length > 0);
  return `${groups.slice(0, 4).join(':') || 'unknown'}::/64`;
}

/**
 * IP 哈希（不可逆），用于关联分析而不泄露明文。
 *
 * 为什么要加 salt：不加盐的 sha256(ip) 可以被「全量 IPv4 空间彩虹表」秒解，
 * 加盐后攻击者必须同时拿到 salt 才能反查，salt 只存在于服务端配置里。
 * 前缀 'ip_' 让 id 在日志里一眼能看出类型（与 visitor 的 'v_' / 'u_' 对应）。
 */
export function hashIp(ip: string, salt: string): string {
  return ip ? `ip_${sha256Hex(`${ip}|${salt}`)}` : '';
}

/**
 * 无 token 时生成稳定访客 id（'v_' 前缀 + 20 位 hex）。
 *
 * 输入：ip + userAgent + salt —— 同一个出口 IP、同一个浏览器，每次请求都能得到相同 id，
 * 因此不需要 set-cookie，也不需要在客户端存任何东西（图片上报 / sendBeacon 场景很关键）。
 * 空 ip / 空 ua 会被替换成 'unknown'，保证「都没有」时也能得到一个稳定 id（而不是抛错）。
 */
export function createVisitorId(ip: string, userAgent: string, salt: string): string {
  return `v_${sha256Hex(`${ip || 'unknown'}|${userAgent || 'unknown'}|${salt}`, 20)}`;
}

/**
 * 有 token 时用用户身份派生访客 id（'u_' 前缀）。
 *
 * 语义差异（这是统计准确性的关键）：
 * - 'v_' 按「网络 + 浏览器」算，同一用户换设备/换网络就是新访客；
 * - 'u_' 按「账号」算，同一账号跨设备、跨网络都是同一个用户，
 *   所以「同一个错误影响了多少用户」在带 token 时才是真正的「用户数」。
 * 没有 sub 的合法 token 会回落到 createVisitorId（见 identity.ts）。
 */
export function createUserVisitorId(userId: string, salt: string): string {
  return `u_${sha256Hex(`${userId}|${salt}`, 20)}`;
}
