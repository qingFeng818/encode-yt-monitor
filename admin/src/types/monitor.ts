/**
 * ============================================================================
 * 采集服务响应类型（与 examples/server/db/types.ts 对齐）
 * ============================================================================
 *
 * 这里只声明管理后台用到的字段，注释保留服务端口径说明，
 * 避免「前端以为 errors 是去重后的分组数、实际是上报条数」这类误读。
 */

/** 写队列统计（/api/stats/overview 的 queue 字段） */
export interface QueueStats {
  /** push 进来的总条数（含随后被丢弃的） */
  received: number;
  /** 真正进入内存队列的条数 */
  accepted: number;
  /** 因队列已满被丢弃的条数 */
  dropped: number;
  /** 真正写入存储的条数 */
  persisted: number;
  /** 被幂等键拦下的重复条数 */
  duplicated: number;
  /** 成功提交的事务批次数 */
  batches: number;
  /** 写库失败的批次数 */
  failures: number;
  /** 当前待落库条数（瞬时值） */
  depth: number;
  /** 最近一次成功 flush 的时间戳，0 表示还没写过 */
  lastFlushAt: number;
  /** 最近一次写库错误信息，成功不会清空 */
  lastError: string | null;
}

/**
 * 概览指标（GET /api/stats/overview?windowHours=1~720）
 *
 * 口径提醒：
 * - errors 是错误「上报条数」，不是分组数；
 * - pv 是 SUM(count)（SDK 可能把多次 PV 合并成一条上报）；
 * - uv / visitors 是窗口内 PV/UV 事件里的不同 visitorId 数；
 * - errorRate = errors / pv，是比值（1.4 表示 140%，可能大于 1；pv=0 时为 0）。
 */
export interface OverviewData {
  windowHours: number;
  errors: number;
  pv: number;
  uv: number;
  visitors: number;
  errorRate: number;
  queue: QueueStats;
}

/** 错误分组（GET /api/stats/errors），按累计次数降序 */
export interface ErrorGroup {
  /** 聚合键：'err_<errorId>' 或 'fp_<sha1>' */
  groupKey: string;
  errorType: string | null;
  name: string | null;
  message: string | null;
  /** 该分组第一条错误的 URL，用于复现 */
  sampleUrl: string | null;
  /** 累计错误条数 */
  totalCount: number;
  /** 累计影响的不同访客数 */
  affectedUsers: number;
  /** 首次出现时间（ms） */
  firstSeen: number;
  /** 最近出现时间（ms） */
  lastSeen: number;
  /** 本次写入是否新建分组 */
  isNew: boolean;
}

/**
 * 错误明细样本（GET /api/stats/errors/:groupKey/samples）。
 *
 * stack 是 SDK 上报的结构化帧数组的 JSON 字符串（见 utils/stack.ts），
 * 也可能出现旧数据 / 手工上报的原始堆栈字符串；两者都要能解析。
 */
export interface ErrorSample {
  errorType: string | null;
  name: string | null;
  message: string | null;
  stack: string | null;
  /** 上报时页面 URL */
  url: string | null;
  ua: string | null;
  sdkVersion: string | null;
  /** 服务端接收时间（ms） */
  createdAt: number;
}

/** PV/UV 日趋势（GET /api/stats/pv 的 daily） */
export interface PvDaily {
  /** 服务器时区的 'YYYY-MM-DD' */
  day: string;
  pv: number;
  uv: number;
}

/** PV 路由排行（GET /api/stats/pv 的 topRoutes，最近 24h） */
export interface PvRoute {
  route: string;
  pv: number;
  uv: number;
}

export interface PvStatsData {
  daily: PvDaily[];
  topRoutes: PvRoute[];
}

/** 前端根据错误分组聚合出的「错误类型」维度 */
export interface ErrorTypeStat {
  type: string;
  count: number;
  /** 各分组 affectedUsers 相加（跨分组可能重复，按「影响人次」理解） */
  users: number;
  /** 该类型下的错误分组数 */
  groups: number;
}
