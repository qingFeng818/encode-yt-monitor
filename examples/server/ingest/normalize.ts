import { createHash } from 'crypto';
import { EventKind, EventRow } from '../db/types';
import { stackToText } from '../db/stack';
import { Identity } from '../core/identity';

/**
 * ============================================================================
 * 报文归一化：SDK 报文 → events 表的行
 * ============================================================================
 *
 * 这一层是「协议适配层」：把 SDK 的 TransportDataType / BatchTransportDataType
 * 拍平成一行行 EventRow，并顺便算好幂等键（eventUid）与聚合键（groupKey）。
 *
 * 兼容的三种形态（顺序即判断顺序）：
 * 1. 单条：{ authInfo, data: {...}, breadcrumb, record, deviceInfo }
 * 2. 单条 + 数组 data：{ authInfo, data: [{...PV...}, {...UV...}] }（PV 聚合上报）
 * 3. 批量：{ authInfo, batch: true, count, data: [单条报文, 单条报文] }（每项各自带 authInfo/data）
 * 另外兜底：直接 POST 一个数组（当作「多个单条报文」处理）。
 *
 * 设计原则：
 * - **只做形状转换，不做业务校验**：字段缺失就写 null，字段类型不对就丢弃该字段，
 *   绝不因为「某个字段奇怪」把整条错误丢掉（错误数据比没有数据更糟）；
 * - 所有字符串都截断（见下方 MAX_* 常量），防止一条畸形报文把库撑爆；
 * - eventUid 的输入里**刻意不含 stack**：同一错误在不同环境 stack 略有差异（行列号、
 *   匿名函数命名），带上 stack 会让幂等失效，导致重复入库；
 * - 采样只对 PV/UV 生效，错误永不采样。
 */

/**
 * 归一化选项。
 *
 * - identity：由 identity.ts 解析好的身份（visitorId / userId / ipHash / ua …），
 *   归一化阶段不再碰请求头，保证「同一请求的所有行共享同一身份」；
 * - endpoint：决定「没有 type 字段时」把数据当错误还是当 PV（/pv/upload → pv，其余 → error）；
 * - pvSampleRate：0~1，只对 pv/uv 生效；
 * - now：服务端接收时间，可注入（单测用它断言 createdAt）。
 */
export interface NormalizeOptions {
  identity: Identity;
  /** 请求打在哪个入口上：/errors/upload 还是 /pv/upload */
  endpoint: 'error' | 'pv';
  /** PV 采样率 0~1，仅对 pv/uv 生效 */
  pvSampleRate: number;
  /** 服务端接收时间 */
  now?: number;
}

/**
 * 归一化结果（也是采集接口响应里 data 字段的来源之一）。
 *
 * 三个计数的关系：
 *   rawCount = events.length + sampled +（被判定为结构不合法而跳过的条数）
 * 采集接口会把这些数字原样返回，方便接入方一眼看出「服务端到底收了多少、丢了多少」。
 */
export interface NormalizeResult {
  events: EventRow[];
  /** 报文里携带的原始条目数（含被采样、被丢弃的） */
  rawCount: number;
  /** 采样丢弃的条数 */
  sampled: number;
  /** 结构不合法被跳过的条数（data 为空 / data 不是对象 / 整个 payload 不是对象等） */
  invalid: number;
}

/**
 * 字段截断上限（按「典型最坏情况」定，不是随便取的）：
 * - message 2000：太长会撑爆错误聚合表的展示，也会让 groupKey 哈希输入过大；
 * - stack 8000：保留完整调用栈，单条 8KB 足够覆盖绝大多数场景；
 * - url 1024：浏览器 URL 长度上限约 2KB，1KB 能保留关键 query；
 * - 短文本 256：name/title/componentName/customTag 这类标签字段；
 * - payload 4000：原始 JSON 只用于排查，超过 4KB 的内容（通常是 breadcrumb）价值递减。
 * 截断时追加「…」，让阅读者知道被截过（而不是误以为原文就这么长）。
 */
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;
const MAX_URL = 1024;
const MAX_TEXT = 256;
const MAX_PAYLOAD = 4000;

/** 截断到 max 个字符（超长时保留前 max 个 + 省略号）；null 直接透传，不变成空串 */
function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 只接受 string/number/boolean，其它类型（对象/数组/undefined）一律当「没传」返回 null */
function toText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** 宽松取整：数字直接截断小数，数字字符串（"12"）也接受；其它返回 null（不瞎猜） */
function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/** 短哈希（默认 16 位 hex = 64bit），用于本地错误指纹 */
function sha1Hex(input: string, length = 16): string {
  return createHash('sha1').update(input).digest('hex').slice(0, length);
}

/** 长哈希（默认 32 位 hex = 128bit），用于幂等键 eventUid */
function sha256Hex(input: string, length = 32): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}

/**
 * 错误指纹（聚合键 groupKey 的来源）。
 *
 * 优先用 SDK 算好的 errorId：SDK 侧 createErrorId 已经对 url/stack 做过归一化
 *（去掉可变部分），聚合质量比服务端兜底更好；前缀 'err_' 便于区分来源。
 *
 * 兜底规则：type|name|message|route 的 sha1 前 16 位，前缀 'fp_'。
 * 为什么不含 stack：stack 里有行列号，任何一行代码变动都会让「同一个 bug」变成新分组。
 * 代价：不同 bug 若「类型+名称+信息+路由」完全相同会被合并 —— 属于有意的取舍。
 */
export function fingerprintOf(item: Record<string, unknown>): string {
  const errorId = toInt(item.errorId);
  if (errorId !== null && errorId > 0) return `err_${errorId}`;
  const type = toText(item.type) || 'UNKNOWN';
  const name = toText(item.name) || '';
  const message = toText(item.message) || '';
  const route = toText(item.to) || toText(item.url) || '';
  return `fp_${sha1Hex(`${type}|${name}|${message}|${route}`)}`;
}

/**
 * 由明细内容生成幂等键：重复上报 / 批量重发 / beacon + xhr 双发都只会入库一次。
 *
 * 输入字段的选取原则：**稳定 + 足以区分两次真实上报**
 * - kind/groupKey/visitorId：区分「谁、什么错误/页面」；
 * - trackerId/clientTime（客户端上报时间，ms）：区分「同一个访客的两次不同上报」；
 * - message/count/route：兜底，避免「trackerId+clientTime 恰好相同」时误判为重复。
 * 不含 stack/ua/payload：这些字段在重发时可能被 SDK 重新序列化而出现细微差异。
 *
 * ⚠️ 副作用（必须知道）：如果 SDK 连续两次上报「内容完全一致且 clientTime 也相同」，
 * 第二条会被判为重复而丢弃。SDK 的 clientTime 精度到毫秒，正常情况下不会撞。
 */
function buildEventUid(input: {
  kind: EventKind;
  groupKey: string | null;
  identity: Identity;
  trackerId: string | null;
  clientTime: number | null;
  message: string | null;
  count: number;
  route: string | null;
}): string {
  return sha256Hex(
    [
      input.kind,
      input.groupKey || '',
      input.identity.visitorId,
      input.trackerId || '',
      input.clientTime ?? '',
      input.message || '',
      input.count,
      input.route || '',
    ].join('|'),
  );
}

/**
 * 判定这条数据属于哪类事件。
 *
 * 规则：显式 type 优先（'PV' / 'UV' 大小写不敏感），
 * 否则按入口兜底：/pv/upload 上来的都当 pv，其它入口当 error。
 * 这样即使 SDK 版本较老、没带 type，也能落到正确的类别里。
 */
function resolveKind(item: Record<string, unknown>, endpoint: 'error' | 'pv'): EventKind {
  const type = (toText(item.type) || '').toUpperCase();
  if (type === 'PV') return 'pv';
  if (type === 'UV') return 'uv';
  return endpoint === 'pv' ? 'pv' : 'error';
}

/**
 * 把一条业务条目（item）+ 它所在报文的 authInfo，组装成一行 EventRow。
 *
 * 字段映射要点：
 * - kind 由 resolveKind 决定，groupKey 只对 error 计算（PV 不参与错误聚合）；
 * - authInfo 来自**外层 envelope**（批量报文里每个子报文各自带自己的 authInfo）；
 * - count 至少为 1：PV 聚合上报时 SDK 会带 count，错误条目没有 count 就补 1；
 * - response/request 只在 HTTP 类错误里存在，缺失时用空对象兜底，避免取值抛错；
 * - payload 存的是「整条 item 的 JSON」，排查时能看到 SDK 发来的全部细节；
 * - 身份字段全部来自 options.identity，不读取报文里的任何「自称身份」字段
 *   （否则客户端可以伪造成别的用户，污染 UV / 影响用户数）。
 */
function buildEvent(
  item: Record<string, unknown>,
  envelope: Record<string, unknown>,
  options: NormalizeOptions,
): EventRow {
  const { identity } = options;
  const authInfo = (envelope.authInfo || {}) as Record<string, unknown>;
  const kind = resolveKind(item, options.endpoint);
  const receivedAt = options.now ?? Date.now();

  const message = truncate(toText(item.message), MAX_MESSAGE);
  const url = truncate(toText(item.url), MAX_URL);
  // 路由：to/from 是 SPA 跳转的「目标/来源」，PV 统计与指纹都用 to
  const routeTo = truncate(toText(item.to), MAX_TEXT);
  const routeFrom = truncate(toText(item.from), MAX_TEXT);
  // 只有错误才聚合：PV 的 groupKey 恒为 null（否则每个页面都会变成一个「错误分组」）
  const groupKey = kind === 'error' ? fingerprintOf(item) : null;
  const trackerId = toText(authInfo.trackerId);
  // count 至少 1：count=0 或负数都视为「一条」（否则 PV 统计会出现 0 或负增长）
  const count = Math.max(1, toInt(item.count) ?? 1);
  // 客户端时间用 item.time（SDK 上报时间），注意它可能不准，统计请用 createdAt
  const clientTime = toInt(item.time);
  const response = (item.response || {}) as Record<string, unknown>;
  const request = (item.request || {}) as Record<string, unknown>;

  return {
    eventUid: buildEventUid({
      kind,
      groupKey,
      identity,
      trackerId,
      clientTime,
      message,
      count,
      route: routeTo || url,
    }),
    kind,
    errorType: kind === 'error' ? toText(item.type) : null,
    level: toText(item.level),
    message,
    name: truncate(toText(item.name), MAX_TEXT),
    // stack 是结构化帧数组，不能走 toText（数组会被判为不可转换 → 落库 null）
    stack: stackToText(item.stack, MAX_STACK),
    errorId: kind === 'error' ? toInt(item.errorId) : null,
    groupKey,
    url,
    routeFrom,
    routeTo,
    title: truncate(toText(item.title), MAX_TEXT),
    count,
    isUv: kind === 'uv' ? 1 : 0,
    httpMethod: truncate(toText(request.method), 16),
    httpStatus: toInt(response.status),
    elapsedTime: toInt(item.elapsedTime),
    componentName: truncate(toText(item.componentName), MAX_TEXT),
    customTag: truncate(toText(item.customTag), MAX_TEXT),
    visitorId: identity.visitorId,
    identityKind: identity.identityKind,
    userId: identity.userId,
    tokenJti: identity.tokenJti,
    ipHash: identity.ipHash || null,
    ipPrefix: identity.ipPrefix || null,
    ua: identity.ua || null,
    trackerId,
    sdkName: toText(authInfo.sdkName),
    sdkVersion: toText(authInfo.sdkVersion),
    appKey: toText(authInfo.apikey) || toText(authInfo.trackKey),
    clientTime,
    createdAt: receivedAt,
    payload: truncate(JSON.stringify(item), MAX_PAYLOAD),
  };
}

/**
 * 从一条报文里取业务数据；data 可能是对象也可能是数组。
 *
 * - 数组（PV 聚合上报）：过滤掉非对象项（null / 字符串混在数组里时直接丢）；
 * - 对象（普通单条）：包成单元素数组，让上层循环逻辑统一；
 * - 其它（data 缺失 / 是字符串 / 是数字）：返回空数组，由调用方计入 invalid。
 */
function itemsOf(envelope: Record<string, unknown>): Record<string, unknown>[] {
  const data = envelope.data;
  if (Array.isArray(data)) {
    return data.filter((item) => item && typeof item === 'object') as Record<string, unknown>[];
  }
  if (data && typeof data === 'object') return [data as Record<string, unknown>];
  return [];
}

/**
 * 归一化入口：payload（已解析的 JSON）→ NormalizeResult。
 *
 * 算法分三步，逐步「展开」：
 *   1. 展开信封：数组 payload / 批量 payload（batch=true）/ 单个信封 → envelopes[]
 *   2. 展开条目：每个信封的 data → items[]（对象或数组）
 *   3. 逐条产出：判 kind → 采样（仅 pv/uv）→ buildEvent
 *
 * 计数语义（响应里会带出去，接入方据此判断是否有数据被丢弃）：
 * - rawCount：进入逐条循环的次数（= 信封里的条目总数）
 * - sampled ：被采样丢弃的条数（只可能来自 pv/uv）
 * - invalid ：信封/条目形状不对、直接跳过的次数
 *
 * 采样实现：`Math.random() > pvSampleRate` 就丢。采样率 1 时永远不丢（rand 不会 > 1）；
 * 采样率 0 时永远丢（rand 恒 > 0，除非恰好 0）—— 后者意味着「关掉 PV 采集」，
 * 是有效的运维手段（比如只想看错误）。
 */
export function normalizePayload(payload: unknown, options: NormalizeOptions): NormalizeResult {
  const result: NormalizeResult = { events: [], rawCount: 0, sampled: 0, invalid: 0 };
  if (!payload) {
    result.invalid += 1;
    return result;
  }

  const envelopes: Record<string, unknown>[] = [];
  const root = payload as Record<string, unknown>;

  if (Array.isArray(payload)) {
    // 兜底：直接 POST 一个数组
    for (const item of payload as unknown[]) {
      if (item && typeof item === 'object') envelopes.push(item as Record<string, unknown>);
      else result.invalid += 1;
    }
  } else if (typeof payload !== 'object') {
    result.invalid += 1;
    return result;
  } else if (root.batch === true && Array.isArray(root.data)) {
    // 批量报文：data 里每条都是完整单条报文，逐条入库
    for (const item of root.data) {
      if (item && typeof item === 'object') envelopes.push(item as Record<string, unknown>);
      else result.invalid += 1;
    }
  } else {
    envelopes.push(root);
  }

  for (const envelope of envelopes) {
    const items = itemsOf(envelope);
    if (items.length === 0) {
      result.invalid += 1;
      continue;
    }
    for (const item of items) {
      result.rawCount += 1;
      const kind = resolveKind(item, options.endpoint);
      // 采样只对 PV/UV 生效：错误数据一条都不能丢
      if (kind !== 'error' && options.pvSampleRate < 1) {
        if (Math.random() > options.pvSampleRate) {
          result.sampled += 1;
          continue;
        }
      }
      result.events.push(buildEvent(item, envelope, options));
    }
  }

  return result;
}
