import { Request, Response, Router } from 'express';
import { CollectorConfig, ServerUrls } from '../config';
import { AlertService } from '../core/alertService';
import { WriteQueue } from '../core/writeQueue';
import { AlertRuleRow, Store } from '../db/types';

/**
 * ============================================================================
 * 查询 / 运维接口（只读为主，唯一的写操作是「保存预警规则」）
 * ============================================================================
 *
 * 接口清单（? 后面是 query 参数与取值范围）：
 *
 *   GET  /api/stats/overview   ?windowHours=1~720（默认 24）
 *        → { windowHours, errors, pv, uv, visitors, errorRate, queue }
 *   GET  /api/stats/errors     ?limit=1~200（20）&windowHours=1~720（24）
 *        → GroupStat[]（按累计次数降序）
 *   GET  /api/stats/errors/:groupKey/samples ?limit=1~20（5）
 *        → ErrorSample[]（最近的错误明细，含 stack，用于定位错误位置）
 *   GET  /api/stats/pv         ?days=1~90（7）&limit=1~100（10）
 *        → { daily: [{day,pv,uv}], topRoutes: [{route,pv,uv}] }
 *   GET  /api/alerts/rules     → AlertRuleRow[]（含停用规则）
 *   POST /api/alerts/rules     body: name/scope/metric/threshold/windowMs/cooldownMs/enabled/channels
 *        → 保存后返回全部规则（同名覆盖；随后 engine.reload() 让新阈值立刻生效）
 *   GET  /api/alerts           ?limit=1~200（20）→ AlertLogEntry[]（时间倒序）
 *   POST /api/alerts/test      ?rule=<规则名>（可省略）
 *        → { message, result: { delivered, error } }，用于验证 webhook 配置
 *   GET  /healthz              → 存活 + 存储驱动 + 队列水位 + 保留天数 + webhook 状态
 *   GET  /metrics              → Prometheus 文本格式（text/plain; version=0.0.4）
 *
 * 鉴权：这些接口在 TOKEN_STRICT=1 时由 identityMiddleware 统一要求合法 token（401），
 * 路由内部不再做权限判断 —— 保持「鉴权集中在一处」。
 *
 * 响应格式统一为 { code, message, data }：code=0 表示成功，便于前端统一拦截器处理。
 */

export interface StatsDeps {
  config: CollectorConfig;
  store: Store;
  /** 用于把「队列水位/丢弃数」一起暴露给运维 */
  queue: WriteQueue;
  /** 用于手动测试推送 + 规则热更新（engine.reload） */
  alerts: AlertService;
}

/**
 * 读取一个「有范围约束」的数字参数。
 *
 * 语义：缺失 / 非数字 → fallback；超出范围 → **夹到边界**（而不是报错或忽略），
 * 这样 ?limit=999999 不会把库拖垮（最多 200 条），?windowHours=-5 也不会变成未来时间。
 */
function readNumber(
  req: Request,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = req.query[name];
  const value = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** 把「多少小时前」换算成毫秒时间戳下界（所有查询的 since 参数都是这个格式） */
function hoursAgo(hours: number): number {
  return Date.now() - hours * 60 * 60 * 1000;
}

/**
 * 归一化 channels 参数为 JSON 数组字符串（存库格式）。
 *
 * 支持三种写法（便于 curl 手测）：
 * - 数组               → 直接 JSON.stringify
 * - JSON 字符串        → 解析后校验是数组再序列化
 * - "console,webhook"  → 逗号分隔，逐项 trim（老习惯写法）
 * 任何解析失败都回落到 '["console"]'，保证存进库里的始终是合法 JSON。
 */
function parseChannels(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => String(item)));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch (error) {
      // 允许 "console,webhook" 这种写法
      return JSON.stringify(
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      );
    }
  }
  return '["console"]';
}

/**
 * 注册查询 / 运维路由。
 *
 * 依赖注入（deps）而不是直接 import 单例：便于单测用内存 store 构造；
 * 所有 handler 都是同步的（除 /api/alerts/test 需要 await 推送），
 * 因为 node:sqlite / JsonStore 的读接口都是同步的。
 */
export function registerStatsRoutes(router: Router, deps: StatsDeps): void {
  const { store, queue, alerts, config } = deps;

  /**
   * 概览：错误数 / PV / UV / 错误率 + 队列水位。
   * 一次请求能看到「业务指标 + 服务端健康」两类信息，是 demo 首页轮询的主接口。
   */
  router.get(ServerUrls.overview, (req: Request, res: Response) => {
    const windowHours = readNumber(req, 'windowHours', 24, 1, 24 * 30);
    const since = hoursAgo(windowHours);
    res.json({
      code: 0,
      message: 'ok',
      data: {
        windowHours,
        ...store.overview(since),
        queue: queue.getStats(),
      },
    });
  });

  /**
   * 错误分组列表：只返回 lastSeen 在窗口内的分组（默认 24h），按累计次数降序。
   * 用 windowHours 而不是「全部历史」，是因为错误看板的关注点在「最近还在发生什么」。
   */
  router.get(ServerUrls.errorGroups, (req: Request, res: Response) => {
    const limit = readNumber(req, 'limit', 20, 1, 200);
    const windowHours = readNumber(req, 'windowHours', 24, 1, 24 * 30);
    res.json({
      code: 0,
      message: 'ok',
      data: store.listErrorGroups(limit, hoursAgo(windowHours)),
    });
  });

  /**
   * 单个错误分组的最近明细样本：展开行展示堆栈、定位错误位置。
   *
   * 只返回 stack / message / url / ua / sdkVersion / createdAt，不暴露访客身份；
   * 明细受 RETENTION_DAYS 限制，过期后会返回空数组（分组本身仍保留在聚合表里）。
   */
  router.get(ServerUrls.errorSamples, (req: Request, res: Response) => {
    // 去空格后再判空：/errors//samples 这种空段本身不会匹配到路由，
    // 但 groupKey=%20 会走到这里，直接查库只会白跑一次 SQL。
    const groupKey = typeof req.params.groupKey === 'string' ? req.params.groupKey.trim() : '';
    if (!groupKey) {
      res.status(400).json({ code: 400, message: 'groupKey 不能为空', data: null });
      return;
    }
    const limit = readNumber(req, 'limit', 5, 1, 20);
    res.json({
      code: 0,
      message: 'ok',
      data: store.listErrorSamples(groupKey, limit),
    });
  });

  /**
   * PV/UV 统计：日趋势（days 天）+ 路由排行（最近 24h 的前 limit 个）。
   * 两者窗口不同是刻意的：趋势看长期，排行看当下热点。
   */
  router.get(ServerUrls.pvStats, (req: Request, res: Response) => {
    const days = readNumber(req, 'days', 7, 1, 90);
    const limit = readNumber(req, 'limit', 10, 1, 100);
    res.json({
      code: 0,
      message: 'ok',
      data: {
        daily: store.listPvDaily(days),
        topRoutes: store.listPvRoute(limit, hoursAgo(24)),
      },
    });
  });

  /** 读取全部预警规则（含 enabled=0 的，前端据此展示开关状态） */
  router.get(ServerUrls.alertRules, (req: Request, res: Response) => {
    res.json({ code: 0, message: 'ok', data: store.listAlertRules() });
  });

  /**
   * 新增 / 覆盖预警规则（按 name 唯一）。
   *
   * 校验与兜底（都是「尽量接受」的策略，避免一次笔误让规则失效）：
   * - name、metric 是必填且必须合法，否则 400（这两个错了规则就没意义）；
   * - scope 不在白名单就回落 'global'；
   * - threshold 最小 1；windowMs 最小 1000；cooldownMs 最小 0（0 = 不冷却）；
   * - enabled 传 0/false 才是停用，其它任何值都算启用；
   * - channels 支持数组 / JSON 字符串 / 逗号分隔。
   * 保存后必须 engine.reload()，否则新阈值要等进程重启才生效（引擎持有规则快照）。
   */
  router.post(ServerUrls.alertRules, (req: Request, res: Response) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name : '';
    const metric = body.metric;
    if (!name || (metric !== 'count' && metric !== 'users' && metric !== 'new_group')) {
      res.status(400).json({ code: 400, message: 'name / metric 不合法', data: null });
      return;
    }
    const rule: Omit<AlertRuleRow, 'id'> & { id?: number } = {
      id: typeof body.id === 'number' ? body.id : undefined,
      name,
      scope:
        body.scope === 'error_type' || body.scope === 'group'
          ? (body.scope as AlertRuleRow['scope'])
          : 'global',
      scopeValue: typeof body.scopeValue === 'string' ? body.scopeValue : null,
      metric,
      threshold: Math.max(1, Number(body.threshold) || 1),
      windowMs: Math.max(1000, Number(body.windowMs) || 60 * 1000),
      cooldownMs: Math.max(0, Number(body.cooldownMs) || 5 * 60 * 1000),
      enabled: body.enabled === 0 || body.enabled === false ? 0 : 1,
      channels: parseChannels(body.channels),
    };
    store.saveAlertRule(rule);
    alerts.engine.reload();
    res.json({ code: 0, message: 'saved', data: store.listAlertRules() });
  });

  /** 预警触发历史（含推送结果），时间倒序，用于「刚才到底报没报、发出去没有」 */
  router.get(ServerUrls.alertLogs, (req: Request, res: Response) => {
    const limit = readNumber(req, 'limit', 20, 1, 200);
    res.json({ code: 0, message: 'ok', data: store.listAlerts(limit) });
  });

  /**
   * 手动测试推送：验证 ALERT_WEBHOOK_URL / 格式是否配置正确。
   *
   * 与真实告警的区别：不经过 AlertEngine（不占冷却、不影响窗口统计），
   * 但**会写一条 alert_log**（ruleName 带「手动测试:」前缀），便于事后对照。
   * 注意：webhook 是外部 IO，最坏耗时 ≈ 2 × 超时（默认 6s），调用方需要容忍慢响应。
   */
  router.post(ServerUrls.alertTest, async (req: Request, res: Response) => {
    const ruleName = typeof req.query.rule === 'string' ? req.query.rule : undefined;
    const result = await alerts.fireTest(ruleName);
    res.json({ code: 0, message: 'ok', data: result });
  });

  /**
   * 健康检查（给 k8s 探针 / 人工排查用）。
   *
   * 只要进程还能响应就返回 200 + ok:true（不检查磁盘/DB 连通性）——
   * 因为「存储降级」在 demo 里是可接受的运行状态（JSON 也能用），
   * 真正需要告警的是「进程挂了」，那种情况探针自然拿不到响应。
   * driver/location 让调用方一眼看出「是不是悄悄降级成 JSON 了」。
   */
  router.get(ServerUrls.health, (req: Request, res: Response) => {
    res.json({
      code: 0,
      message: 'ok',
      data: {
        ok: true,
        driver: store.driver,
        location: store.location,
        uptimeSeconds: Math.round(process.uptime()),
        queue: queue.getStats(),
        retentionDays: config.retentionDays,
        alertWebhook: alerts.notifier.hasWebhook ? config.alertWebhookFormat : 'disabled',
      },
    });
  });

  /**
   * Prometheus 指标（文本格式 0.0.4，直接 GET 即可被 scrape）。
   *
   * 指标语义（都是「自进程启动以来」的累计值，除 gauge 外）：
   * - monitor_events_received_total   ：进入队列的条数
   * - monitor_events_persisted_total  ：真正入库的条数
   * - monitor_events_duplicated_total ：被幂等键拦下的重复条数
   * - monitor_events_dropped_total    ：队列满被丢弃的条数（>0 需要扩容）
   * - monitor_write_failures_total    ：写库失败的批次数
   * - monitor_queue_depth             ：当前待落库条数（gauge，反映实时压力）
   * - monitor_alerts_total            ：告警记录条数（注意：受 listAlerts 的 limit 截断，
   *                                     最多统计到 1000 条，属于近似值）
   * - monitor_up                      ：进程存活（恒为 1，进程挂了就抓不到，等于 0）
   *
   * 没有用 prom-client：demo 只想暴露少数几个指标，手写文本格式更简单、零依赖。
   */
  router.get(ServerUrls.metrics, (req: Request, res: Response) => {
    const stats = queue.getStats();
    const lines = [
      '# HELP monitor_events_received_total 收到的明细条数',
      '# TYPE monitor_events_received_total counter',
      `monitor_events_received_total ${stats.received}`,
      '# HELP monitor_events_persisted_total 成功入库的明细条数',
      '# TYPE monitor_events_persisted_total counter',
      `monitor_events_persisted_total ${stats.persisted}`,
      '# HELP monitor_events_duplicated_total 幂等去重丢弃的条数',
      '# TYPE monitor_events_duplicated_total counter',
      `monitor_events_duplicated_total ${stats.duplicated}`,
      '# HELP monitor_events_dropped_total 队列满被丢弃的条数',
      '# TYPE monitor_events_dropped_total counter',
      `monitor_events_dropped_total ${stats.dropped}`,
      '# HELP monitor_write_failures_total 写库失败批次数',
      '# TYPE monitor_write_failures_total counter',
      `monitor_write_failures_total ${stats.failures}`,
      '# HELP monitor_queue_depth 当前待落库条数',
      '# TYPE monitor_queue_depth gauge',
      `monitor_queue_depth ${stats.depth}`,
      '# HELP monitor_alerts_total 预警触发次数',
      '# TYPE monitor_alerts_total counter',
      `monitor_alerts_total ${store.listAlerts(1000).length}`,
      '# HELP monitor_up 进程存活',
      '# TYPE monitor_up gauge',
      'monitor_up 1',
    ];
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });
}
