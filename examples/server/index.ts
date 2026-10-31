/**
 * ============================================================================
 * 采集服务入口：把「配置 → 存储 → 身份 → 限流 → 写队列 → 预警 → 路由」装配起来
 * ============================================================================
 *
 * 一次上报请求的完整链路（按实际执行顺序）：
 *
 *   SDK 上报
 *     │
 *     ├─ CORS 中间件            ↓ 跨域预检直接 204
 *     ├─ body 解析              ↓ json / text / urlencoded 三种形态
 *     ├─ identityMiddleware     ↓ 解析 token（可无）→ 得到 visitorId / userId / ipHash
 *     ├─ RateLimiter.take()     ↓ 按 visitorId 令牌桶限流，超限 429
 *     ├─ normalizePayload()     ↓ SDK 报文 → EventRow[]（含幂等键 eventUid、错误指纹 groupKey）
 *     ├─ WriteQueue.push()      ↓ 入内存队列（同步返回，不阻塞响应）
 *     │    └─ 每 flushIntervalMs 或攒够 maxBatch → 一个事务批量落库
 *     │         └─ onFlushed → AlertService.observe() → AlertEngine 滑动窗口累加
 *     └─ 立即返回 200 { received, accepted, dropped, sampled, invalid, ... }
 *
 * 另一条独立链路是预警：AlertService 定时（默认 5s）评估一次窗口 → 命中阈值 → 落 alert_log + webhook 推送。
 *
 * 启动顺序很重要：store.init() → queue.start() → alerts.start() → server.listen()。
 * 退出顺序相反：alerts.stop() → queue.stop()（会把剩余数据 flush 掉）→ server.close() → store.close()。
 */
import express from 'express';
import http from 'http';
import opn from 'open';
import { port, FilePaths, ServerUrls, loadConfig } from './config';
import { createStore } from './db/store';
import { identityMiddleware } from './core/identity';
import { RateLimiter } from './core/rateLimit';
import { WriteQueue } from './core/writeQueue';
import { AlertService } from './core/alertService';
import { registerCollectRoutes } from './routes/collect';
import { registerStatsRoutes } from './routes/stats';

// ---------------------------------------------------------------------------
// 依赖装配（手写依赖注入，没有框架，方便阅读与替换）
// ---------------------------------------------------------------------------

/** 配置：全进程只读一份 */
const config = loadConfig();
/** 存储：SQLite 优先，加载不到 node:sqlite 时自动降级 JSON 文件（见 db/store.ts） */
const store = createStore(config);
/** 限流：按 visitorId 的令牌桶，capacity = 每分钟允许条数 */
const limiter = new RateLimiter(config.rateLimitPerMinute);
/** 预警服务：内部持有 AlertEngine（统计） + Notifier（推送） */
const alerts = new AlertService(store, config);

// 写队列：请求只负责入队，落库由队列批量完成，同时把结果喂给预警引擎
// onFlushed 的时机 = 「数据真的进库了」，所以预警统计不会把「入队但还没落库」的数据算进去
const queue = new WriteQueue({
  store,
  flushIntervalMs: config.flushIntervalMs,
  maxBatch: config.maxBatch,
  maxQueueSize: config.maxQueueSize,
  onFlushed: (rows, result) => alerts.observe(rows, result.groups),
});

const app = express();
/**
 * 信任代理：部署在 nginx / SLB / Vercel 后面时，req.socket.remoteAddress 是代理的 IP，
 * 必须允许 Express 从 X-Forwarded-For 取真实客户端 IP（core/visitor.ts 也是按这个顺序取的）。
 * 注意：直接暴露公网时任何人都能伪造 XFF，此时应改成具体的代理网段白名单。
 */
app.set('trust proxy', true);

/**
 * 极简 CORS：demo 里 Vue / React 可能跑在 8080、5173 等别的端口，
 * 采集接口必须允许跨域，否则浏览器会直接拦掉上报。
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowAll = config.corsOrigins.includes('*');
  if (origin) {
    // 配了 '*' 就「原样回写请求方 origin」而不是回写 '*'：
    // 因为下面带了 allow-credentials，浏览器规范禁止 credentials + '*' 组合
    res.setHeader('access-control-allow-origin', allowAll ? origin : config.corsOrigins.join(','));
    // 同一 URL 因 Origin 不同响应头不同，必须告诉缓存层按 Origin 分桶
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-credentials', 'true');
  }
  // Authorization 必须放行，否则带 token 的跨域上报会被浏览器预检拦掉
  res.setHeader('access-control-allow-headers', 'Content-Type, Authorization');
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
  if (req.method === 'OPTIONS') {
    // 预检请求不需要（也不应该）进入业务链路，直接结束
    res.status(204).end();
    return;
  }
  next();
});

// 三种 body 形态都要能解析：JSON（XHR）、纯文本（网关改写过）、表单（老客户端）
// 三者互不冲突：express 会按 Content-Type 选择对应的解析器，匹配不上就保持 undefined。
// 1mb 上限是防「超大报文打爆内存」，与 normalize 里的字段截断（message 2000 字符等）是两道防线。
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: ['text/plain'], limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// 身份识别：所有请求都过一遍，有 token 解析 token，没 token 用 IP+UA 生成访客 id
// 放在这里（而不是只挂在采集路由上）是因为查询/预警接口在 TOKEN_STRICT 下也要校验身份，
// 同时它会给每个响应写上 X-Visitor-Id / X-Identity-Kind，排查时很有用。
app.use(identityMiddleware(config));

// 采集 + 查询接口
// 顺序无关：两组路由的路径前缀不重叠（/errors、/pv、/api/collect vs /api/stats、/api/alerts、/healthz、/metrics）
registerCollectRoutes(app, { config, queue, limiter });
registerStatsRoutes(app, { config, store, queue, alerts });

/**
 * demo 静态页面：/JS/index.html、/Vue/index.html … 每个目录里都是一个可直接操作 SDK 的页面。
 * 挂在路由注册之后，是为了避免静态中间件把 /api/* 之类的请求当成文件去找（虽然找不到也会 next()）。
 */
const url = `http://localhost:${port}/JS/index.html`;
Object.entries(FilePaths).forEach(([path, resolvePath]) => {
  app.use(path, express.static(resolvePath));
});

/**
 * 下面是给 SDK demo 用的「假业务接口」，不属于采集链路：
 * /normal 返回 200、/exception 返回 500，用来验证 SDK 的接口异常捕获（errorType=HTTP_ERROR）
 * 与路由跳转上报；返回体里写中文是为了在页面上一眼看出命中了哪个分支。
 */
app.get(ServerUrls.normalGet, (req, res) => {
  res.send('get 正常请求响应体');
});

app.get(ServerUrls.exceptionGet, (req, res) => {
  res.status(500).send('get 异常响应体!!!');
});

app.post(ServerUrls.normalPost, (req, res) => {
  res.send('post 正常请求响应体');
});

app.post(ServerUrls.exceptionPost, (req, res) => {
  res.status(500).send('post 异常响应体!!!');
});

/** 接口索引：不知道有哪些接口时先看这里，包含当前生效的存储驱动与数据文件位置 */
app.get('/api', (req, res) => {
  res.json({
    code: 0,
    message: 'ok',
    data: {
      collect: [
        ServerUrls.errorsUpload,
        ServerUrls.pvUpload,
        ServerUrls.collectError,
        ServerUrls.collectPv,
      ],
      stats: [ServerUrls.overview, ServerUrls.errorGroups, ServerUrls.errorSamples, ServerUrls.pvStats],
      alerts: [ServerUrls.alertRules, ServerUrls.alertLogs, ServerUrls.alertTest],
      ops: [ServerUrls.health, ServerUrls.metrics],
      storage: { driver: store.driver, location: store.location },
    },
  });
});

/**
 * /api 下未匹配到的路径统一返回 JSON，避免前端 fetch('/api/xxx') 拿到 express 默认的 HTML 错误页
 * 而在 res.json() 处抛 "Unexpected token < in JSON" 这种难以定位的错。
 * 注意：这个兜底必须放在所有 /api/* 路由之后、静态资源之后（静态资源不会命中 /api 前缀）。
 */
app.use('/api', (req, res) => {
  res
    .status(404)
    .json({ code: 404, message: `接口不存在：${req.method} ${req.originalUrl}`, data: null });
});

// 兜底错误处理：单个请求异常不能把进程带崩
// Express 通过「4 个参数」识别错误中间件；必须放在所有 route / middleware 之后。
app.use((error: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[server] 未捕获的请求异常：', error);
  if (res.headersSent) {
    // 响应已经开始发送（例如流式输出中途出错），只能交给 express 默认处理：断开连接
    next(error);
    return;
  }
  // 统一错误响应结构，前端/测试可以只看 code 字段
  res.status(500).json({ code: 500, message: '服务端异常', data: null });
});

/**
 * 过期数据清理（默认保留 7 天）。
 *
 * 语义约定：
 * - 只删「明细 events + 聚合 error_groups / error_group_users + alert_log」，
 *   不删预警规则（配置类数据）；
 * - 按 created_at（服务端接收时间）判断，而不是客户端上报时间，
 *   避免客户端时钟错乱导致刚写进来的数据立刻被清掉；
 * - RETENTION_DAYS<=0 时完全不建定时器（demo 想保留全量数据时用）；
 * - 定时器 unref()：不要让这个后台任务把进程留住（单测/脚本里 import 本文件也能正常退出）。
 */
let purgeTimer: ReturnType<typeof setInterval> | undefined;
if (config.retentionDays > 0) {
  purgeTimer = setInterval(() => {
    const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    try {
      const removed = store.purgeBefore(cutoff);
      if (removed > 0)
        console.log(`[purge] 清理 ${config.retentionDays} 天前数据，共 ${removed} 条`);
    } catch (error) {
      console.error('[purge] 清理失败：', error);
    }
  }, config.purgeIntervalMs);
  if (typeof purgeTimer.unref === 'function') purgeTimer.unref();
}

// 先启动后台任务，再开始接收流量：避免「请求进来了但队列还没跑起来」的窗口期
queue.start();
alerts.start();

const server = http.createServer(app);

server.listen(port, () => {
  console.log(`examples is available at: http://localhost:${port}`);
  console.log(`采集入口：${ServerUrls.errorsUpload} / ${ServerUrls.pvUpload}`);
  console.log(`数据看板：http://localhost:${port}${ServerUrls.overview}`);
  // 只有 demo 模式才自动开浏览器，避免 CI / 后台启动时打扰
  if (process.env.NODE_ENV === 'demo') opn(url);
});

/**
 * 优雅退出：先把队列里没落库的数据写完，再关库。
 * 不做这一步的话，容器滚动更新 / Ctrl+C 会丢掉最后一批上报。
 */
let shuttingDown = false;
/**
 * 幂等保护：SIGINT 之后容器编排可能又发 SIGTERM，第二次直接忽略，
 * 否则会对已经 flush 过的队列再关一次库。
 */
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] 收到 ${signal}，开始优雅退出…`);
  // 1) 停止预警：避免退出过程中还在推送 webhook
  alerts.stop();
  // 2) 停止清理任务
  if (purgeTimer) clearInterval(purgeTimer);
  // 3) 停止写队列并同步 flush：queue.stop() 内部会调用 flush()，把内存里的数据写完
  queue.stop();
  const stats = queue.getStats();
  console.log(`[server] 退出前落库：${stats.persisted} 条，丢弃：${stats.dropped} 条`);
  // 4) 停止接收新连接；已建立的连接处理完后回调里关库
  server.close(() => {
    store.close();
    console.log('[server] 已退出');
    process.exit(0);
  });
  // 兜底：5s 内没关完就强制退出（例如有长连接挂住 server.close 的回调）
  setTimeout(() => process.exit(0), 5000).unref();
}

// 容器里 `docker stop` 发 SIGTERM，本地 Ctrl+C 发 SIGINT，两者都要走同一套优雅退出
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
