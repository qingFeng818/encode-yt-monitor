/**
 * ============================================================================
 * 存储层类型契约（events / error_groups / alert_* 的 TS 侧定义）
 * ============================================================================
 *
 * 命名约定：
 * - TS 用 camelCase，SQLite 列用 snake_case，映射在 sqliteStore.ts 的 SQL 与 row 转换里完成；
 * - 时间统一用 **毫秒级 Unix 时间戳**（number）。SQL 里做日期分组时用
 *   `created_at / 1000` 配合 `unixepoch`（见 sqliteStore.listPvDaily），不要直接当秒用。
 *
 * 三方关系：本文件只定义「数据长什么样 + Store 接口行为」，不含实现；
 * SqliteStore / JsonStore 都必须满足同一份接口，业务代码（routes / core）只依赖接口。
 */

/** 事件类别：错误明细、PV 明细、UV 明细统一进 events 表（用 kind 区分，见 schema.sql 的设计说明） */
export type EventKind = 'error' | 'pv' | 'uv';

/** 身份来源：有 token 用 token，无 token 用 IP+UA 派生匿名访客 id */
export type IdentityKind = 'token' | 'anonymous';

/**
 * events 表的一行（字段与 schema.sql 一一对应，JSON 降级存储用同一份结构）。
 *
 * 可空性语义：`xxx | null` 表示「该字段对这类事件不适用」或「客户端没传」，
 * 与 SQL 的 NULL 完全对应（写入时不要用 undefined，两个驱动对 undefined 的处理不一致）。
 */
export interface EventRow {
  /** 幂等键：由 (kind|groupKey|visitor|tracker|clientTime|message|count|route) 哈希生成，
   *  唯一索引冲突时整条忽略（SDK 重试 / 批量重发 / beacon 双发都只会入库一次） */
  eventUid: string;
  /** 事件类别；决定哪些字段有意义（error 才有 stack/groupKey，pv 才有 count） */
  kind: EventKind;
  /** 错误类型：JAVASCRIPT_ERROR / RESOURCE_ERROR / HTTP_ERROR …；pv/uv 恒为 null */
  errorType: string | null;
  /** 错误级别（error / warn / info），由 SDK 传入，仅作参考不过滤 */
  level: string | null;
  /** 错误信息（已截断 2000 字符）；同时是幂等键与指纹的输入 */
  message: string | null;
  /** Error.name 或页面名（已截断 256） */
  name: string | null;
  /** 错误堆栈（JSON 帧数组字符串，已截断 8000 字符），只用于展示与定位，不参与聚合 */
  stack: string | null;
  /** SDK 侧 createErrorId 计算的数字指纹；客户端没算就是 null */
  errorId: number | null;
  /** 聚合键（错误才有）：'err_<errorId>' 或 'fp_<sha1>'，error_groups 以它唯一 */
  groupKey: string | null;
  /** 页面 / 请求完整 URL（截断 1024） */
  url: string | null;
  /** 来源路由（SPA 路由跳转的 from） */
  routeFrom: string | null;
  /** 目标路由（SPA 路由跳转的 to；PV 统计优先用它，其次用 url） */
  routeTo: string | null;
  /** 页面标题（截断 256） */
  title: string | null;
  /** PV 聚合次数：SDK 侧可能把多次 PV 合并成一条上报，所以 PV 总数要用 SUM(count) 而不是 COUNT(*) */
  count: number;
  /** 是否 UV 事件（1 = kind 为 uv）：冗余字段，方便 SQL 里快速筛 UV */
  isUv: number;
  /** 接口错误的 HTTP 方法（截断 16） */
  httpMethod: string | null;
  /** 接口错误的 HTTP 状态码 */
  httpStatus: number | null;
  /** 接口 / 资源耗时（ms），由 SDK 传入 */
  elapsedTime: number | null;
  /** 组件名（Vue/React 组件级错误定位用） */
  componentName: string | null;
  /** 业务自定义标签（截断 256），可用于按业务线筛选 */
  customTag: string | null;
  /** 访客 id：'u_…'（带 token 按账号）或 'v_…'（匿名按 IP+UA）——UV / 影响用户数的唯一 key */
  visitorId: string;
  /** 身份来源；非法 token 会以 'anonymous' 落库（不会虚增登录用户数） */
  identityKind: IdentityKind;
  /** token 里的 sub 原文（不做哈希，便于与业务库对齐）；匿名时为 null */
  userId: string | null;
  /** token 唯一 id，用于追溯「同一张 token 的所有上报」 */
  tokenJti: string | null;
  /** IP 的 sha256 前 16 位（加盐），不可逆；不存明文 IP */
  ipHash: string | null;
  /** 脱敏网段（1.2.x.x / xxxx:xxxx:xxxx:xxxx::/64）；ANONYMIZE_IP=0 时为完整 IP */
  ipPrefix: string | null;
  /** User-Agent（截断 512） */
  ua: string | null;
  /** SDK authInfo.trackerId，可当会话 id 用（同一页面生命周期内稳定） */
  trackerId: string | null;
  /** SDK 名称 / 版本，用于区分「哪个端、哪个版本」的问题 */
  sdkName: string | null;
  sdkVersion: string | null;
  /** 接入 key（authInfo.apikey 或 trackKey），多应用共库时用于隔离 */
  appKey: string | null;
  /** 客户端上报的时间戳（ms）；可能因客户端时钟不准而偏大偏小，统计请用 createdAt */
  clientTime: number | null;
  /** 服务端接收时间（ms）——**所有统计与保留策略都以它为准** */
  createdAt: number;
  /** 原始条目 JSON（截断 4000 字符），排查用；不参与任何统计 */
  payload: string | null;
}

/**
 * 一条错误聚合结果（error_groups 的一行 + 本次写入是否新建标记）。
 *
 * 两个统计口径的差异（很容易混淆，务必分清）：
 * - totalCount   ：该分组累计的**错误条数**（每次上报 +1，不考虑用户去重）；
 * - affectedUsers：该分组累计的**不同访客数**（error_group_users 的行数）。
 *
 * firstSeen / lastSeen 是「首次/最近一次出现」的服务端时间（ms），
 * 用于 /api/stats/errors 的时间窗过滤与展示，不参与预警判定（预警用内存窗口）。
 */
export interface GroupStat {
  /** 聚合键：'err_<errorId>' 或 'fp_<sha1>'，对应 error_groups.group_key */
  groupKey: string;
  errorType: string | null;
  name: string | null;
  message: string | null;
  /** 代表性 URL（该分组第一条错误的 url），用于「去哪复现」 */
  sampleUrl: string | null;
  totalCount: number;
  affectedUsers: number;
  firstSeen: number;
  lastSeen: number;
  /** 本次写入是否新建了该分组（预警 new_group 规则使用） */
  isNew: boolean;
}

/**
 * 一条错误明细样本（错误列表展开行「最近堆栈」的数据源）。
 *
 * 只返回排查定位需要的字段，不返回 visitor/ip 等敏感身份信息。
 * stack 是 **JSON 帧数组字符串**（见 db/stack.ts）；旧数据会从 payload.stack 回填。
 */
export interface ErrorSample {
  /** 错误类型（JAVASCRIPT_ERROR / VUE_ERROR …） */
  errorType: string | null;
  name: string | null;
  message: string | null;
  /** 结构化堆栈的 JSON 字符串；没有堆栈时为 null */
  stack: string | null;
  /** 上报时页面 URL */
  url: string | null;
  /** 上报时的 User-Agent（截断 512） */
  ua: string | null;
  sdkVersion: string | null;
  /** 服务端接收时间（ms），用于按时间倒序展示 */
  createdAt: number;
}

/**
 * 一次 writeEvents 的结果。
 *
 * 语义要点：
 * - inserted + duplicated 应该等于「本批去重前的有效行数」；
 *   event_uid 已存在 → duplicated，不会抛错、也不会更新任何计数；
 * - groups 只包含**本批确实写入了错误明细**的分组（PV 不会产生分组），
 *   且每组的 totalCount/affectedUsers 是「累加后的最新值」而不是本批增量；
 * - isNew=true 只会出现在「本批第一次创建该分组」的那一次结果里（同批后续事件不会覆盖成 false）。
 */
export interface WriteResult {
  /** 真正入库的明细条数 */
  inserted: number;
  /** 被 event_uid 判重丢弃的条数 */
  duplicated: number;
  /** 本批次涉及的分组（含累加后的最新计数） */
  groups: GroupStat[];
}

/** 概览指标（/api/stats/overview 的主体，时间段由调用方的 since 决定） */
export interface OverviewRow {
  /** 错误条数（COUNT(1)，即上报条数，不受 count 字段影响） */
  errors: number;
  /** 页面浏览量（SUM(count)，SDK 侧可能合并上报） */
  pv: number;
  /** 独立访客数（COUNT(DISTINCT visitor_id)，pv+uv 一起算） */
  uv: number;
  /** 与 uv 相同，保留两个名字是为了兼容不同前端取值的习惯 */
  visitors: number;
  /** 错误率 = errors / pv（pv 为 0 时返回 0，不做除零） */
  errorRate: number;
}

/** PV/UV 按天聚合的一行；day 是服务器时区的 'YYYY-MM-DD' 字符串（由 SQLite strftime 生成） */
export interface PvDailyRow {
  day: string;
  pv: number;
  uv: number;
}

/** PV 按路由聚合的一行；route 取 route_to → url → '(unknown)' 的优先级 */
export interface PvRouteRow {
  route: string;
  pv: number;
  uv: number;
}

/**
 * 预警作用域：
 * - 'global'     ：全部错误一起算
 * - 'error_type' ：按错误类型分组算（scopeValue 为空则「每种类型各算一次」）
 * - 'group'      ：按错误指纹分组算（scopeValue 为空则「每个分组各算一次」，最常用）
 */
export type AlertScope = 'global' | 'error_type' | 'group';

/**
 * 预警指标：
 * - 'count'     ：窗口内错误条数
 * - 'users'     ：窗口内不同访客数
 * - 'new_group' ：窗口内新增错误分组数
 */
export type AlertMetric = 'count' | 'users' | 'new_group';

/**
 * 预警规则（alert_rules 的一行）。
 *
 * 字段间的约束（路由层做校验，这里只声明语义）：
 * - name 唯一，saveAlertRule 按 name UPSERT（改名等于新增一条规则）；
 * - scope='error_type'/'group' 时 scopeValue 才有意义，为空表示「对该维度的每个 key 各判一次」；
 * - windowMs 最短 1000（1 秒），cooldownMs 可以 0（表示不冷却，慎用）；
 * - enabled=0 的规则不会进入 AlertEngine（reload 时被过滤掉）。
 */
export interface AlertRuleRow {
  id: number;
  name: string;
  scope: AlertScope;
  /** error_type 的具体值（如 JAVASCRIPT_ERROR）或 group 的 group_key；可空 */
  scopeValue: string | null;
  metric: AlertMetric;
  /** 触发阈值（>= 就报） */
  threshold: number;
  /** 统计窗口长度（ms） */
  windowMs: number;
  /** 冷却时间（ms）：同一规则+分组在这段时间内只报一次 */
  cooldownMs: number;
  /** 1 = 启用，0 = 停用 */
  enabled: number;
  /** JSON 数组字符串，如 '["console","webhook"]'；实际推送渠道由 Notifier 决定（console 恒定打印） */
  channels: string;
}

/**
 * 预警触发记录（alert_log 的一行，不含自增 id）。
 *
 * 用途：回答「什么时候因为什么报过警、到底发出去没有」。
 * delivered=0 + error 有值 → 推送失败；payload 里是完整文案，可直接复制重发。
 */
export interface AlertLogRow {
  /** 规则 id；规则已被删除时为 null（历史记录仍保留） */
  ruleId: number | null;
  /** 规则名（人工测试会有「手动测试:」前缀） */
  ruleName: string;
  groupKey: string | null;
  metric: string;
  value: number;
  threshold: number;
  windowMs: number;
  channels: string;
  /** 完整文案（与推送到 webhook 的正文一致） */
  payload: string;
  /** 1 = 已送达（含「只打控制台」的情况），0 = webhook 推送失败 */
  delivered: number;
  /** 失败原因（HTTP 状态码 / 超时 / 网络错误），成功为 null */
  error: string | null;
  createdAt: number;
}

export interface AlertLogEntry extends AlertLogRow {
  id: number;
}

/**
 * 存储适配层接口（SqliteStore / JsonStore 的共同契约）。
 *
 * 之所以抽接口：demo 环境可能没有 node:sqlite（需要 --experimental-sqlite），
 * 此时自动降级到 JSON 文件存储，业务代码（采集 / 查询 / 预警）完全不用改。
 * 生产环境想换 MySQL / ClickHouse / Kafka + 消费端，也只需要再实现这个接口。
 *
 * 实现者必须满足的约束（两个驱动都遵守，新增实现时照做）：
 * 1. writeEvents 是**同步**的，并且整批要么全成功要么抛异常（不能部分提交后静默返回）；
 * 2. writeEvents 必须幂等：同一 eventUid 重复写入只算 duplicated，不重复累加计数；
 * 3. writeEvents 必须同时维护 error_groups / error_group_users，并返回本批分组的
 *    **累加后最新值** + isNew 标记（预警的 new_group 指标依赖它）；
 * 4. 所有 listXxx / overview 方法的 since 参数都是「毫秒时间戳下界（含）」，返回结构必须一致
 *    （例如 listErrorGroups 不暴露内部自增 id，isNew 恒为 false）；
 * 5. purgeBefore 只删明细/聚合/告警日志，不删预警规则；返回删除行数用于日志。
 */
export interface Store {
  /** 实际生效的驱动（/healthz 与 /api 会展示，便于确认是否发生了降级） */
  readonly driver: 'sqlite' | 'json';
  /** 数据文件位置，仅用于日志 / 健康检查 */
  readonly location: string;
  /** 建库建表 + 内置预警规则初始化（幂等：重复调用不会重复建表/重复插规则） */
  init(): void;

  /**
   * 批量写入明细并维护错误聚合，返回本批聚合信息。
   * 同步执行、整批一个事务；event_uid 冲突的行计入 duplicated 并跳过（不会覆盖旧数据）。
   */
  writeEvents(rows: EventRow[]): WriteResult;

  /** 最近的错误分组（lastSeen >= since），按 totalCount 降序 + lastSeen 降序，取前 limit 个 */
  listErrorGroups(limit: number, since: number): GroupStat[];

  /**
   * 某个错误分组的最近明细样本（按 createdAt 倒序）。
   *
   * 用于错误列表展开行展示堆栈；stack 为 null 时会尝试从 payload.stack 回填
   * （兼容修复前入库的历史数据）。分组不存在 / 明细已过保留期时返回空数组。
   */
  listErrorSamples(groupKey: string, limit: number): ErrorSample[];

  /** 最近 days 天的 PV/UV 日趋势（按日期升序；pv 用 SUM(count)，uv 用 DISTINCT visitor_id） */
  listPvDaily(days: number): PvDailyRow[];

  /** 最近 since 之后的 PV 路由排行（按 pv 降序取前 limit；只统计 kind='pv'） */
  listPvRoute(limit: number, since: number): PvRouteRow[];

  /** 概览指标（since 之后的错误数 / PV / UV / 错误率） */
  overview(since: number): OverviewRow;

  /**
   * 全部预警规则（按 id 升序，含 enabled=0 的）。
   * 只读快照：返回副本，修改它不会影响存储（改规则必须走 saveAlertRule）。
   */
  listAlertRules(): AlertRuleRow[];

  /** 新增或按 name 覆盖预警规则（name 唯一约束；传 id 时忽略 id，以 name 为准） */
  saveAlertRule(rule: Omit<AlertRuleRow, 'id'> & { id?: number }): void;

  /** 追加一条预警触发记录（alert_log） */
  logAlert(entry: AlertLogRow): void;

  /** 最近的预警记录（按 id 降序取前 limit，即时间倒序） */
  listAlerts(limit: number): AlertLogEntry[];

  /** 删除 created_at < ts 的明细与聚合，返回删除行数（保留策略的唯一入口） */
  purgeBefore(ts: number): number;

  /** 关闭底层资源（SQLite 关闭连接；JSON 存储做最后一次落盘）；必须可重复调用不抛错 */
  close(): void;
}

/**
 * 内置的默认预警规则，可用 /api/alerts/rules 追加或覆盖。
 *
 * 四条规则覆盖三种典型场景（阈值是「demo 量级」的经验值，生产请按流量调大）：
 * 1. 错误总量-1分钟（50 条）：整体雪崩的第一道警报；
 * 2. JS错误-1分钟（20 条）：按错误类型收窄，定位到具体 SDK 能力；
 * 3. 单错误影响用户-5分钟（10 人）：scope=group + metric=users，「一个错误影响了多少用户」；
 * 4. 新错误首次出现（1 个）：metric=new_group，只打控制台（避免刚上线时刷屏 webhook）。
 */
export const DEFAULT_ALERT_RULES: Array<Omit<AlertRuleRow, 'id'>> = [
  {
    name: '错误总量-1分钟',
    scope: 'global',
    scopeValue: null,
    metric: 'count',
    threshold: 50,
    windowMs: 60 * 1000,
    cooldownMs: 5 * 60 * 1000,
    enabled: 1,
    channels: '["console","webhook"]',
  },
  {
    name: 'JS错误-1分钟',
    scope: 'error_type',
    scopeValue: 'JAVASCRIPT_ERROR',
    metric: 'count',
    threshold: 20,
    windowMs: 60 * 1000,
    cooldownMs: 5 * 60 * 1000,
    enabled: 1,
    channels: '["console","webhook"]',
  },
  {
    name: '单错误影响用户-5分钟',
    scope: 'group',
    scopeValue: null,
    metric: 'users',
    threshold: 10,
    windowMs: 5 * 60 * 1000,
    cooldownMs: 10 * 60 * 1000,
    enabled: 1,
    channels: '["console","webhook"]',
  },
  {
    name: '新错误首次出现',
    scope: 'global',
    scopeValue: null,
    metric: 'new_group',
    threshold: 1,
    windowMs: 60 * 1000,
    cooldownMs: 10 * 60 * 1000,
    enabled: 1,
    channels: '["console"]',
  },
];
