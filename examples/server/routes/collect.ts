import { Request, Response, Router } from 'express';
import { CollectorConfig, ServerUrls } from '../config';
import { getIdentity } from '../core/identity';
import { RateLimiter } from '../core/rateLimit';
import { WriteQueue } from '../core/writeQueue';
import { normalizePayload } from '../ingest/normalize';

/**
 * ============================================================================
 * 采集路由：SDK 上报的唯一入口
 * ============================================================================
 *
 * 处理链（与 index.ts 的中间件顺序配合）：
 *   CORS → body 解析 → identityMiddleware → 本文件的 handler
 *   handler 内部：限流 → 解析报文 → 归一化 → 入队 → 立刻响应
 *
 * HTTP 状态码的约定（很关键，SDK 会按状态码决定是否重试）：
 *   200 —— 正常接收；也用于「服务端主动丢弃/采样」的情况（见下方说明）
 *   400 —— 报文本身无法解析（空 body / 不是合法 JSON / 结构完全不像 SDK 报文）
 *   401 —— 仅当 TOKEN_STRICT=1 且 token 非法（由 identityMiddleware 返回，不在这里）
 *   429 —— 该访客触发限流（SDK 应退避重试，通常已经被 SDK 丢掉，不会无限重发）
 *   500 —— 仅在 handler 自身抛异常时（由 index.ts 的兜底错误中间件返回）
 *
 * 为什么「丢弃 / 采样」也返回 200：
 * 这不是失败，而是服务端的主动决策（队列满、按比例采样）。若返回 4xx/5xx，
 * SDK 会把它当失败并重试 → 越重试越堆积 → 越堆积越丢，形成雪崩。
 * 真实结果通过响应体里的 accepted / dropped / sampled 字段告诉接入方。
 */

export interface CollectDeps {
  /** 只读配置（采样率等） */
  config: CollectorConfig;
  /** 写队列（真正落库的地方） */
  queue: WriteQueue;
  /** 按访客维度的令牌桶 */
  limiter: RateLimiter;
}

/** 1x1 透明 GIF：兼容 SDK 的 useImgUpload（img.src 上报），避免浏览器报图片加载失败 */
const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * 提取上报报文，兼容三种承载方式（按此顺序尝试，先到先得）：
 * 1. application/json（XHR / fetch / sendBeacon）：body 已被 express.json 解析成对象，
 *    且必须**非空对象**才算命中（空对象通常意味着客户端什么都没发）
 * 2. text/plain（部分网关或老客户端会把 JSON 当字符串发）：自己 JSON.parse 一次
 * 3. GET ?data=<encodeURIComponent(JSON)>（图片上报，带不了 body）：
 *    先 decodeURIComponent 再 parse（query 里的 %7B… 需要解码）
 *
 * @returns { payload } 解析成功；{ error } 解析失败（错误文案会直接返回给客户端，便于联调）
 */
function parsePayload(req: Request): { payload?: unknown; error?: string } {
  const body = req.body;
  if (body && typeof body === 'object' && Object.keys(body as object).length > 0) {
    return { payload: body };
  }
  if (typeof body === 'string' && body.trim().length > 0) {
    try {
      return { payload: JSON.parse(body) };
    } catch (error) {
      return { error: '报文不是合法 JSON' };
    }
  }
  const data = req.query.data;
  if (typeof data === 'string' && data.trim().length > 0) {
    try {
      return { payload: JSON.parse(decodeURIComponent(data)) };
    } catch (error) {
      return { error: 'query.data 不是合法 JSON' };
    }
  }
  return { error: '报文为空' };
}

/**
 * 判断这次请求是不是「图片上报」，需要返回 1x1 gif。
 *
 * 两个条件任一命中即认为是图片上报：
 * - GET + query.data：SDK 的 useImgUpload 就是拼 `?data=...` 挂到 img.src 上；
 * - Accept 里包含 image/：浏览器加载图片时 Accept 会带上 image/*。
 * 为什么要判断：img.src 的响应体如果是 JSON，浏览器会当图片加载失败（控制台噪音 +
 * 触发 onerror，进而可能被 SDK 当成「资源错误」再上报一次，形成循环）。
 */
function wantsImage(req: Request): boolean {
  if (req.method !== 'GET') return false;
  if (typeof req.query.data === 'string') return true;
  const accept = String(req.headers.accept || '');
  return accept.includes('image/');
}

/**
 * 采集入口。
 *
 * 处理顺序：身份识别（中间件已做）→ 限流 → 报文解析 → 归一化 → 入队 → 立即响应。
 * 之所以「入队即返回 200」：上报接口必须快（SDK 在 unload/beacon 场景下没有时间等），
 * 落库交给写队列批量完成；需要强一致的调试场景可以带 ?sync=1 强制同步落库。
 *
 * @param endpoint 'error' → /errors/upload 系列；'pv' → /pv/upload 系列。
 *                 只影响「报文没有 type 字段时」的默认归类，以及是否应用 PV 采样率。
 */
function createHandler(deps: CollectDeps, endpoint: 'error' | 'pv') {
  return (req: Request, res: Response): void => {
    const identity = getIdentity(req);

    // 1) 限流：按访客维度。超限直接 429，不解析报文（省 CPU），也不入队（保护存储）
    if (!deps.limiter.take(identity.visitorId)) {
      res.status(429).json({ code: 429, message: '上报过于频繁，请稍后重试', data: null });
      return;
    }

    // 2) 解析报文：拿不到 payload 说明客户端压根没发有效数据 → 400（这类请求重试也没用）
    const parsed = parsePayload(req);
    if (!parsed.payload) {
      res.status(400).json({ code: 400, message: parsed.error || '报文为空', data: null });
      return;
    }

    // 3) 归一化：结构转换 + 截断 + 幂等键 + 错误指纹；PV 入口才应用采样率
    const normalized = normalizePayload(parsed.payload, {
      identity,
      endpoint,
      pvSampleRate: endpoint === 'pv' ? deps.config.pvSampleRate : 1,
    });

    // 4) 「既没有产出事件，也没有识别出任何原始条目」= 报文结构完全不是 SDK 报文
    //    注意：如果 rawCount>0 但 events 为空（全部被采样），仍然算成功（返回 200）
    if (normalized.events.length === 0 && normalized.rawCount === 0) {
      res.status(400).json({ code: 400, message: '报文结构不合法', data: null });
      return;
    }

    // 5) 入队：push 内部可能因为队列满而部分丢弃，accepted/dropped 会如实返回
    const enqueued = deps.queue.push(normalized.events);
    // ?sync=1：调试用，强制同步落库（会明显变慢，但可以「上报完立刻查库能看到」）
    if (req.query.sync === '1' || req.query.sync === 'true') deps.queue.flush();

    const data = {
      /** 报文里的原始条目数 */
      received: normalized.rawCount,
      /** 真正进队列的条数 */
      accepted: enqueued.accepted,
      /** 因队列满被丢弃的条数（>0 说明存储跟不上，需要扩容或调大 MAX_QUEUE_SIZE） */
      dropped: enqueued.dropped,
      /** 被 PV 采样丢弃的条数（只对 pv/uv 可能 >0） */
      sampled: normalized.sampled,
      /** 结构不合法被跳过的条数 */
      invalid: normalized.invalid,
      /** 本次请求被识别成什么身份（与响应头 x-identity-kind 一致） */
      identityKind: identity.identityKind,
      visitorId: identity.visitorId,
      /** 当前队列水位，便于接入方判断服务端压力 */
      queueDepth: deps.queue.depth,
    };

    // 6) 图片上报：必须返回真正的 GIF 字节，否则浏览器会报加载失败
    if (wantsImage(req)) {
      res.status(200).type('image/gif').send(PIXEL_GIF);
      return;
    }
    // 失败也返回 200 的场景：HTTP 状态码不是 2xx 会让 SDK 走失败重试，
    // 这里「丢弃 / 采样」是服务端的主动决策，不应该让客户端反复重发。
    res.status(200).json({ code: 0, message: 'ok', data });
  };
}

/**
 * 注册采集路由。
 *
 * 每个路径都用 router.all（而不是 .post）：SDK 在不同场景下会用 GET（img）、
 * POST（xhr/beacon）、甚至 PUT（自定义 transport），全部交给同一个 handler 处理，
 * 具体的数据提取方式由 parsePayload 按内容决定。
 *
 * 路径别名的关系（必须保持行为完全一致，只是历史命名不同）：
 *   /errors/upload     ≈ /api/collect/error
 *   /pv/upload         ≈ /api/collect/pv
 *   /errors/upload.gif   仅错误，用于 img 上报（PV 没有 img 模式）
 */
export function registerCollectRoutes(router: Router, deps: CollectDeps): void {
  const errorHandler = createHandler(deps, 'error');
  const pvHandler = createHandler(deps, 'pv');

  // 老协议（SDK 默认 dsn / trackDsn 指向这两个地址）
  router.all(ServerUrls.errorsUpload, errorHandler);
  router.all(ServerUrls.errorsUploadGif, errorHandler);
  router.all(ServerUrls.pvUpload, pvHandler);
  // 新协议别名
  router.all(ServerUrls.collectError, errorHandler);
  router.all(ServerUrls.collectPv, pvHandler);
}
