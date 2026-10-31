import { resolve } from 'path';

/**
 * ============================================================================
 * 采集服务配置模块（静态路径表 + 路由表 + 运行时参数）
 * ============================================================================
 *
 * 本模块只做两件事，不含任何业务逻辑：
 *   1. 声明「静态资源目录」与「HTTP 路由常量」，供 index.ts / routes / tools / tests 共享，
 *      避免同一个字符串在多个文件里各写一遍导致改一处漏一处；
 *   2. 把全部可调参数收口到 loadConfig()，其它模块只依赖 CollectorConfig 这个普通对象，
 *      不直接读 process.env（好处：单测可以 new 一个 config 传进去，不必污染环境变量）。
 *
 * 配置优先级：环境变量 > 下面 loadConfig() 里的默认值。每个字段都标注了对应的环境变量名。
 *
 * 两个使用约定：
 * - loadConfig() 只在进程启动时调用一次（index.ts 顶层），运行期参数不再变化；
 *   需要「运行中调整」的东西（例如预警阈值）走数据库 + POST /api/alerts/rules，不走环境变量。
 * - 默认值都是「本机 demo 开箱即跑」的保守值（TOKEN_SECRET / VISITOR_SALT 是公开默认值），
 *   生产部署必须用环境变量覆盖，否则任何人都能伪造 token。
 */

/** 采集服务监听端口；与 examples 里前端页面的 dsn / trackDsn 保持一致，别随便改 */
export const port = 2021;

/** 相对于本文件所在目录（examples/server）解析路径，保证从任意 cwd 启动都能找到静态资源 */
const resolveDirname = (target: string) => resolve(__dirname, target);
const JsFilePath = resolveDirname('../JS');
const VueFilePath = resolveDirname('../Vue');
const ReactFilePath = resolveDirname('../React');
const Vue3FilePath = resolveDirname('../Vue3');
const WebPerformancePath = resolveDirname('../WebPerformance');
const webFilePath = resolve('./packages/web/dist');
const wxFilePath = resolve('./packages/wx-mini/dist');
const webPerfFilePath = resolve('./packages/web-performance/dist');
const browserFilePath = resolve('./packages/browser/dist');

/**
 * 静态资源挂载表：key = 访问前缀，value = 磁盘目录。
 *
 * index.ts 会遍历它逐个 app.use(prefix, express.static(dir))，因此：
 * - 前两个（/JS、/Vue…）指向 examples 下的手写 demo 页面，用来验证 SDK 的各种上报场景；
 * - 后四个（/webDist、/wxDist…）指向 packages 各子包的 dist 目录，即 SDK 打完包后的产物，
 *   方便在同一个服务里对照「源码 demo」和「npm 包产物」的行为差异。
 * 目录不存在不会报错（express.static 只是 404），所以没构建产物也能启动。
 */
export const FilePaths = {
  '/JS': JsFilePath,
  '/Vue': VueFilePath,
  '/React': ReactFilePath,
  '/Vue3': Vue3FilePath,
  '/WebPerformance': WebPerformancePath,
  '/webDist': webFilePath,
  '/wxDist': wxFilePath,
  '/wpDist': webPerfFilePath,
  '/browserDist': browserFilePath,
};

/**
 * 路由表：全服务的 URL 契约。改动这里等于改 API，需同步 README 与测试。
 *
 * 分组说明：
 * - 采集入口（对外，SDK 会打）：
 *     errorsUpload / pvUpload 是 SDK 默认 dsn、trackDsn 指向的老地址，必须保留；
 *     collectError / collectPv 是新增的语义化别名，两者走同一套 handler，行为完全一致；
 *     errorsUploadGif 是「图片上报」专用的 .gif 后缀，用于 useImgUpload 模式。
 * - 查询接口（对内，demo 控制台 / 本地排查）：overview、errorGroups、pvStats；
 *   在 TOKEN_STRICT=1 时这三个 + 预警接口都要求合法 token。
 * - 预警管理：rules（读写）、alertLogs（读告警历史）、alertTest（手动发一条验证 webhook）。
 * - 运维：health（存活 + 存储驱动 + 队列水位，给探针用）、metrics（Prometheus 文本格式）。
 *
 * 注意：图片上报只对「错误」开放（/errors/upload.gif）。PV 没有图片上报模式，
 * 因为 PV 通常由 track 主动调用，不需要用 img 兜底。
 */
export const ServerUrls = {
  normalGet: '/normal',
  exceptionGet: '/exception',
  normalPost: '/normal/post',
  exceptionPost: '/exception/post',
  errorsUpload: '/errors/upload',
  /** 图片上报（useImgUpload）专用后缀：返回 1x1 gif */
  errorsUploadGif: '/errors/upload.gif',
  pvUpload: '/pv/upload',
  // 采集别名，方便新接入方使用统一前缀
  collectError: '/api/collect/error',
  collectPv: '/api/collect/pv',
  // 查询 / 运维接口
  overview: '/api/stats/overview',
  errorGroups: '/api/stats/errors',
  /** 单个错误分组的最近明细样本（展开行堆栈用；:groupKey 由前端 encodeURIComponent） */
  errorSamples: '/api/stats/errors/:groupKey/samples',
  pvStats: '/api/stats/pv',
  alertRules: '/api/alerts/rules',
  alertLogs: '/api/alerts',
  alertTest: '/api/alerts/test',
  health: '/healthz',
  metrics: '/metrics',
};

/**
 * 允许跨域访问的来源；demo 里 Vue/React 可能跑在别的端口。
 * 默认 '*' 表示「带上请求方 origin 原样回写」（见 index.ts 的 CORS 中间件），
 * 生产建议用 CORS_ORIGINS=https://a.example.com,https://b.example.com 收敛。
 */
const DEFAULT_CORS_ORIGINS = ['*'];

/**
 * 以下 5 个 readXxx 是「环境变量 → 强类型」的转换层，共同约定：
 * - 变量不存在 / 为空串 → 用 fallback，不抛错（缺配置不应该让 demo 起不来）；
 * - 变量存在但值非法（NaN、非数字）→ 同样回到 fallback，避免把一个坏值带进业务逻辑；
 * - 全部在启动期执行一次，运行期没有 IO 开销。
 */

/** 读字符串：去空白后为空视为未配置 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** 读整数（十进制）：用于毫秒数、条数、天数等；非法值回退默认 */
function readInt(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

/** 读浮点数（0~1 的采样率等）；非法值回退默认 */
function readFloat(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 读布尔："1 / true / yes / on"（不区分大小写）= true，其它任何值 = false。
 * 注意这里不是「非法值回退默认」：写了 ANONYMIZE_IP=0 就是明确关掉，不会被 fallback 覆盖。
 */
function readBool(name: string, fallback: boolean): boolean {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** 读逗号分隔列表（CORS 来源等）：逐项 trim 并丢掉空项，避免 "a,,b" 产生空字符串 */
function readList(name: string, fallback: string[]): string[] {
  const raw = readEnv(name);
  if (raw === undefined) return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * webhook 报文格式：
 * - raw：本项目自定义结构（带 rule/value/threshold/groupKey/firedAt），适合自建告警网关；
 * - feishu / dingtalk / wecom：直接对接三家 IM 的群机器人，字段必须符合各家规定（见 notifier.ts）。
 * 三家机器人都有「关键词校验 / 每分钟 20 条」之类的限制，生产建议单独建一个告警群，
 * 否则限流会导致 delivered=0 且只在 alert_log.error 里留痕。
 */
export type WebhookFormat = 'raw' | 'feishu' | 'dingtalk' | 'wecom';

/**
 * 全量运行时配置。字段按用途分组，每个字段都标注了环境变量名与「取值含义」。
 *
 * 这个接口是各模块唯一的配置输入（依赖注入），因此：
 * - 单测可以手工构造（tests/server/collect.test.ts 就是这么做的）；
 * - 新增配置必须在这里声明 + 在 loadConfig() 里给默认值，避免出现「隐式读 process.env」。
 */
export interface CollectorConfig {
  /** 数据目录，存放 sqlite / json 文件（默认 examples/server/.data，已 gitignore） */
  dataDir: string;
  /** sqlite 文件路径（MONITOR_DB_FILE，默认 <dataDir>/monitor.sqlite） */
  dbFile: string;
  /** 是否强制使用 json 存储（MONITOR_FORCE_JSON=1；默认自动探测：能加载 node:sqlite 就用 sqlite） */
  forceJsonStore: boolean;

  /**
   * 访客 id 哈希盐（VISITOR_SALT）。
   * 语义：换盐 == 换一套 visitor_id，历史数据与之后的数据无法再关联；
   * 多实例部署必须用同一个盐，否则同一个匿名访客在不同实例上会被算成两个人。
   */
  visitorSalt: string;
  /** 是否对 IP 做脱敏（ANONYMIZE_IP，默认 true）：true 只存 hash + 前两段网段，false 存完整 IP */
  anonymizeIp: boolean;

  /** JWT 校验密钥（TOKEN_SECRET）；示例默认值是公开的，生产必须覆盖 */
  tokenSecret: string;
  /** 可选：校验 iss（TOKEN_ISSUER）；配置了才校验，且仅在 token 自带 iss 时生效 */
  tokenIssuer: string | undefined;
  /**
   * 严格模式（TOKEN_STRICT=1，默认 false）。
   * false：token 非法 → 降级匿名访客，采集照收（数据优先）；
   * true ：采集接口遇到「非法 token」直接 401，查询/预警接口遇到「没有或非法 token」也 401。
   */
  tokenStrict: boolean;
  /** 允许的签名算法，固定 HS256，暴露出来只做显式声明（verifyToken 内部会再校验一次 alg） */
  tokenAlgorithms: string[];

  /** 写队列参数（见 core/writeQueue.ts）：攒批间隔、单批上限、内存队列上限 */
  /** 攒批时间（FLUSH_INTERVAL_MS，默认 200ms）：到点即使没攒够 maxBatch 也落库 */
  flushIntervalMs: number;
  /** 单次事务最多写多少条（MAX_BATCH，默认 200） */
  maxBatch: number;
  /** 内存队列上限（MAX_QUEUE_SIZE，默认 5000）：超了直接丢弃并计入 dropped，保护进程不 OOM */
  maxQueueSize: number;

  /** 每个访客每分钟最多上报多少条（RATE_LIMIT_PER_MINUTE，默认 600；0 表示不限流） */
  rateLimitPerMinute: number;

  /**
   * PV 采样率 0~1（PV_SAMPLE_RATE，默认 1 = 全采）。
   * 只对 kind=pv / uv 生效：错误数据永不采样，否则「错误数」会失真。
   */
  pvSampleRate: number;

  /** 明细数据保留天数（RETENTION_DAYS，默认 7；<=0 表示不清理） */
  retentionDays: number;
  /** 清理任务执行间隔（PURGE_INTERVAL_MS，默认 1 小时） */
  purgeIntervalMs: number;

  /** 预警：webhook 地址（ALERT_WEBHOOK_URL），为空则只打印到控制台 */
  alertWebhookUrl: string | undefined;
  /** 预警：webhook 报文格式（ALERT_WEBHOOK_FORMAT，默认 raw） */
  alertWebhookFormat: WebhookFormat;
  /** 预警：单次推送超时（ALERT_WEBHOOK_TIMEOUT_MS，默认 3000ms），超时算失败并重试一次 */
  alertWebhookTimeoutMs: number;
  /** 预警评估间隔（ALERT_EVALUATE_INTERVAL_MS，默认 5000ms）；写库回调只累加窗口，判定由这个定时器驱动 */
  alertEvaluateIntervalMs: number;

  /** 允许跨域来源（CORS_ORIGINS，逗号分隔，默认 ['*']） */
  corsOrigins: string[];
}

/**
 * 从环境变量装配配置对象。整个进程只调用一次（index.ts 顶层、tools/mint-token.ts）。
 *
 * 环境变量速查（左 = 变量名，右 = 默认值）：
 *   MONITOR_DB_FILE            <dataDir>/monitor.sqlite
 *   MONITOR_FORCE_JSON         0
 *   VISITOR_SALT               encode-yt-monitor-demo-salt
 *   ANONYMIZE_IP               1
 *   TOKEN_SECRET               encode-yt-monitor-demo-secret
 *   TOKEN_ISSUER               （空 = 不校验 iss）
 *   TOKEN_STRICT               0
 *   FLUSH_INTERVAL_MS          200
 *   MAX_BATCH                  200
 *   MAX_QUEUE_SIZE             5000
 *   RATE_LIMIT_PER_MINUTE      600
 *   PV_SAMPLE_RATE             1
 *   RETENTION_DAYS             7
 *   PURGE_INTERVAL_MS          3600000
 *   ALERT_WEBHOOK_URL          （空 = 不推送三方）
 *   ALERT_WEBHOOK_FORMAT       raw
 *   ALERT_WEBHOOK_TIMEOUT_MS   3000
 *   ALERT_EVALUATE_INTERVAL_MS 5000
 *   CORS_ORIGINS               *
 */
export function loadConfig(): CollectorConfig {
  const dataDir = resolveDirname('.data');
  return {
    dataDir,
    dbFile: readEnv('MONITOR_DB_FILE') || resolve(dataDir, 'monitor.sqlite'),
    forceJsonStore: readBool('MONITOR_FORCE_JSON', false),

    visitorSalt: readEnv('VISITOR_SALT') || 'encode-yt-monitor-demo-salt',
    anonymizeIp: readBool('ANONYMIZE_IP', true),

    tokenSecret: readEnv('TOKEN_SECRET') || 'encode-yt-monitor-demo-secret',
    tokenIssuer: readEnv('TOKEN_ISSUER'),
    tokenStrict: readBool('TOKEN_STRICT', false),
    tokenAlgorithms: ['HS256'],

    flushIntervalMs: readInt('FLUSH_INTERVAL_MS', 200),
    maxBatch: readInt('MAX_BATCH', 200),
    maxQueueSize: readInt('MAX_QUEUE_SIZE', 5000),

    rateLimitPerMinute: readInt('RATE_LIMIT_PER_MINUTE', 600),

    pvSampleRate: readFloat('PV_SAMPLE_RATE', 1),

    retentionDays: readInt('RETENTION_DAYS', 7),
    purgeIntervalMs: readInt('PURGE_INTERVAL_MS', 60 * 60 * 1000),

    alertWebhookUrl: readEnv('ALERT_WEBHOOK_URL'),
    alertWebhookFormat: (readEnv('ALERT_WEBHOOK_FORMAT') || 'raw') as WebhookFormat,
    alertWebhookTimeoutMs: readInt('ALERT_WEBHOOK_TIMEOUT_MS', 3000),
    alertEvaluateIntervalMs: readInt('ALERT_EVALUATE_INTERVAL_MS', 5000),

    corsOrigins: readList('CORS_ORIGINS', DEFAULT_CORS_ORIGINS),
  };
}
