import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  AlertLogEntry,
  AlertLogRow,
  AlertRuleRow,
  DEFAULT_ALERT_RULES,
  EventRow,
  ErrorSample,
  GroupStat,
  OverviewRow,
  PvDailyRow,
  PvRouteRow,
  Store,
  WriteResult,
} from './types';
import { stackFromPayload } from './stack';

/**
 * ============================================================================
 * SQLite 存储实现（基于内置 node:sqlite，零第三方依赖）
 * ============================================================================
 *
 * 为什么用 node:sqlite 而不是 better-sqlite3：
 * - 免安装原生模块（离线 / CI 环境不需要编译）；
 * - 同步 API，配合 WriteQueue 天然串行，不需要处理 async 事务；
 * - 代价：仍是实验特性（Node 22.5+ 需 --experimental-sqlite，22.13+/23+ 默认可用），
 *   因此 store.ts 里保留了「加载不到就降级 JSON」的分支。
 *
 * 文件结构：schema.sql 定义 5 张表（events / error_groups / error_group_users /
 * alert_rules / alert_log），本文件负责「读写 + 聚合维护」，SQL 里的每个决策都写在对应方法上。
 */

/** node:sqlite 是实验特性，且没有官方类型声明，这里按最小可用面自己声明 */
interface SqliteStatement {
  /** 执行写语句，返回受影响行数（用于判断 INSERT OR IGNORE 是否真的插入了） */
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  /** 取第一行（可能为 undefined） */
  get(...params: unknown[]): any;
  /** 取全部行 */
  all(...params: unknown[]): any[];
}

/** 同步数据库句柄；exec 用于多语句脚本（schema.sql）与事务控制 */
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { open?: boolean }) => SqliteDatabase;
}

/**
 * 加载 node:sqlite。
 *
 * - Node 22.5 ~ 22.12 需要 `--experimental-sqlite`；
 * - Node 22.13+ / 23+ 默认可用；
 * - 用同步 require（而不是 import）是为了能 try/catch：ESM 的动态 import 失败处理更啰嗦，
 *   且本文件在 CommonJS 编译目标下运行（tsconfig module=commonjs）。
 *
 * 加载失败返回 null，由 createStore 决定降级到 JSON 存储（这里不抛错）。
 */
export function loadSqlite(): SqliteModule | null {
  try {
    return require('node:sqlite') as SqliteModule;
  } catch (error) {
    return null;
  }
}

/**
 * events 表的插入列顺序（与 schema.sql 一一对应）。
 *
 * 集中成常量有两个好处：
 * 1. INSERT 语句的列表和占位符都从这里生成，列数永远不会写错；
 * 2. eventValues() 的返回顺序必须与它严格一致 —— 两者是「同一份契约的两端」，
 *    改一处必须改另一处（改列时建议直接加在末尾，避免顺序错位）。
 */
const EVENT_INSERT_COLUMNS = [
  'event_uid',
  'kind',
  'error_type',
  'level',
  'message',
  'name',
  'stack',
  'error_id',
  'group_key',
  'url',
  'route_from',
  'route_to',
  'title',
  'count',
  'is_uv',
  'http_method',
  'http_status',
  'elapsed_time',
  'component_name',
  'custom_tag',
  'visitor_id',
  'identity_kind',
  'user_id',
  'token_jti',
  'ip_hash',
  'ip_prefix',
  'ua',
  'tracker_id',
  'sdk_name',
  'sdk_version',
  'app_key',
  'client_time',
  'created_at',
  'payload',
];

/** 按 EVENT_INSERT_COLUMNS 的顺序把 EventRow 拍平成参数数组（undefined 一律用 null 占位） */
function eventValues(row: EventRow): unknown[] {
  return [
    row.eventUid,
    row.kind,
    row.errorType,
    row.level,
    row.message,
    row.name,
    row.stack,
    row.errorId,
    row.groupKey,
    row.url,
    row.routeFrom,
    row.routeTo,
    row.title,
    row.count,
    row.isUv,
    row.httpMethod,
    row.httpStatus,
    row.elapsedTime,
    row.componentName,
    row.customTag,
    row.visitorId,
    row.identityKind,
    row.userId,
    row.tokenJti,
    row.ipHash,
    row.ipPrefix,
    row.ua,
    row.trackerId,
    row.sdkName,
    row.sdkVersion,
    row.appKey,
    row.clientTime,
    row.createdAt,
    row.payload,
  ];
}

/**
 * 把 SQL 返回值安全转成 number。
 *
 * 两种需要转换的情况：
 * - node:sqlite 的 INTEGER 可能返回 bigint（超过 2^53 时），Number(bigint) 会丢精度，
 *   但我们的时间戳/计数远小于 2^53，转换是安全的；
 * - COUNT/SUM 在空结果集上返回 null，统一回落 fallback（默认 0），避免 NaN 传到前端。
 */
function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * SQLite 存储实现。
 *
 * 关键点：
 * 1. 写库全程同步（node:sqlite 是同步 API），由 WriteQueue 串行化，一个事务写一批，
 *    天然避免并发写锁冲突；
 * 2. 明细 INSERT OR IGNORE（event_uid 唯一）实现幂等，重复上报直接丢掉；
 * 3. 错误聚合用 UPSERT 累加，同时维护 error_group_users 做「不同用户数」的精确统计。
 */
export class SqliteStore implements Store {
  readonly driver = 'sqlite' as const;
  readonly location: string;
  private db: SqliteDatabase;
  /** SQL 文本 → 预编译语句；本文件的 SQL 全是常量，缓存不会无限增长（见 stmt()） */
  private stmtCache = new Map<string, SqliteStatement>();

  constructor(file: string) {
    const sqlite = loadSqlite();
    if (!sqlite) throw new Error('node:sqlite 不可用');
    this.location = file;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new sqlite.DatabaseSync(file);
    // WAL：读写并发更友好（本 demo 是单写多读），且崩溃后恢复更快
    this.db.exec('PRAGMA journal_mode = WAL;');
    // NORMAL：WAL 下不必每次都 fsync，性能提升明显；代价是「断电可能丢最后几条已提交事务」
    this.db.exec('PRAGMA synchronous = NORMAL;');
    // 打开外键约束（SQLite 默认关闭），保证 error_group_users 不会指向不存在的分组
    this.db.exec('PRAGMA foreign_keys = ON;');
    // 5s 内遇到锁就重试等待，避免瞬时并发直接抛 SQLITE_BUSY
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  /**
   * 建表 + 灌默认规则。
   *
   * - schema.sql 里全部是 CREATE TABLE/INDEX IF NOT EXISTS，重复执行安全；
   * - 用 db.exec 一次性执行整个脚本（node:sqlite 的 exec 支持多语句）；
   * - seedDefaultRules 只在 alert_rules 为空时写入，不会覆盖用户改过的阈值。
   */
  init(): void {
    const schemaPath = resolve(__dirname, 'schema.sql');
    this.db.exec(readFileSync(schemaPath, 'utf8'));
    this.seedDefaultRules();
  }

  /**
   * 预编译语句缓存：同一个 SQL 只 prepare 一次，后续复用。
   *
   * 这是批量写入性能的关键 —— 每批 200 条、每条 1 次 INSERT + 1 次 UPSERT + 4 次 SELECT，
   * 如果不缓存，每批要 prepare 上千次（prepare 的成本远高于执行）。
   * 缓存 key 就是 SQL 文本本身（本文件的 SQL 都是常量字符串，不会泄漏内存）。
   */
  private stmt(sql: string): SqliteStatement {
    let cached = this.stmtCache.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.stmtCache.set(sql, cached);
    }
    return cached;
  }

  /**
   * 首次初始化内置预警规则（仅在 alert_rules 为空时执行）。
   *
   * 语义：**不覆盖已有规则** —— 用户通过 /api/alerts/rules 调过的阈值必须保留，
   * 所以这里只判断「表是否为空」，而不是逐条 INSERT OR IGNORE。
   * 副作用：如果用户把所有规则都删了（本 demo 没有删除接口），下次启动会重新灌默认值。
   */
  private seedDefaultRules(): void {
    const row = this.stmt('SELECT COUNT(1) AS c FROM alert_rules').get();
    if (toNumber(row && row.c) > 0) return;
    for (const rule of DEFAULT_ALERT_RULES) {
      this.stmt(
        `INSERT OR IGNORE INTO alert_rules
          (name, scope, scope_value, metric, threshold, window_ms, cooldown_ms, enabled, channels)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        rule.name,
        rule.scope,
        rule.scopeValue,
        rule.metric,
        rule.threshold,
        rule.windowMs,
        rule.cooldownMs,
        rule.enabled,
        rule.channels,
      );
    }
  }

  /**
   * 批量写入（单事务 + 幂等 + 聚合维护），核心 SQL 语义：
   *
   * 1. INSERT OR IGNORE INTO events：靠 event_uid 唯一索引实现幂等；
   *    changes=0 → 说明这条之前写过，计 duplicated 并跳过（**不更新旧行**，保留首见信息）。
   * 2. INSERT INTO error_groups ... ON CONFLICT(group_key) DO UPDATE：
   *    首次出现时 total_count 从 1 开始（affected_users 先给 0，随后由去重逻辑 +1）；
   *    已存在时 total_count + 1、last_seen 前移，error_type/message 用 COALESCE 只在原来为空时补齐
   *    （即「保留第一次的样本」，避免后面的空值把有用信息覆盖掉）。
   * 3. prevCounts：写之前先查一次 total_count，用 -1 表示「写之前不存在」→ isNew 判定；
   *    每个 groupKey 只查一次（同批多条同一分组复用同一结果）。
   * 4. error_group_users：主键 (group_id, visitor_id)，INSERT OR IGNORE 的 changes=1
   *    代表「这个访客第一次触发该错误」→ affected_users + 1；否则只累加该访客的 hit_count。
   * 5. 整个循环在 BEGIN IMMEDIATE ... COMMIT 里：批量提交快、且失败时整体回滚（不会半截写入）。
   *
   * @returns groups 里每项都是「累加后的最新快照」，同一分组在本批只出现一次。
   */
  writeEvents(rows: EventRow[]): WriteResult {
    const result: WriteResult = { inserted: 0, duplicated: 0, groups: [] };
    if (!rows || rows.length === 0) return result;

    const insertEvent = this.stmt(
      `INSERT OR IGNORE INTO events (${EVENT_INSERT_COLUMNS.join(', ')})
       VALUES (${EVENT_INSERT_COLUMNS.map(() => '?').join(', ')})`,
    );
    const upsertGroup = this.stmt(
      `INSERT INTO error_groups
        (group_key, error_type, name, message, sample_url, total_count, affected_users, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)
       ON CONFLICT(group_key) DO UPDATE SET
         total_count = total_count + 1,
         last_seen   = excluded.last_seen,
         error_type  = COALESCE(error_groups.error_type, excluded.error_type),
         message     = COALESCE(error_groups.message, excluded.message)`,
    );
    const selectGroup = this.stmt(
      `SELECT id, group_key, error_type, name, message, sample_url, total_count, affected_users, first_seen, last_seen
         FROM error_groups WHERE group_key = ?`,
    );
    const selectPrevCount = this.stmt('SELECT total_count FROM error_groups WHERE group_key = ?');
    const insertGroupUser = this.stmt(
      `INSERT OR IGNORE INTO error_group_users (group_id, visitor_id, hit_count, first_seen, last_seen)
       VALUES (?, ?, 1, ?, ?)`,
    );
    const touchGroupUser = this.stmt(
      `UPDATE error_group_users SET hit_count = hit_count + 1, last_seen = ?
        WHERE group_id = ? AND visitor_id = ?`,
    );
    const incAffectedUsers = this.stmt(
      'UPDATE error_groups SET affected_users = affected_users + 1 WHERE id = ?',
    );

    const groupMap = new Map<string, GroupStat>();
    /** 分组在本批写入前的 total_count；-1 表示写入前不存在（即本批新建） */
    const prevCounts = new Map<string, number>();

    // BEGIN IMMEDIATE：立即拿写锁（而不是等到第一次写才升级锁），避免中途 SQLITE_BUSY
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of rows) {
        const runResult = insertEvent.run(...eventValues(row));
        if (toNumber(runResult.changes) === 0) {
          // 唯一索引冲突（event_uid 已存在）→ 幂等丢弃，聚合也不再累加
          result.duplicated += 1;
          continue;
        }
        result.inserted += 1;

        if (row.kind !== 'error' || !row.groupKey) continue;

        if (!prevCounts.has(row.groupKey)) {
          const prev = selectPrevCount.get(row.groupKey);
          prevCounts.set(row.groupKey, prev ? toNumber(prev.total_count) : -1);
        }

        upsertGroup.run(
          row.groupKey,
          row.errorType,
          row.name,
          row.message,
          row.url,
          row.createdAt,
          row.createdAt,
        );

        const group = selectGroup.get(row.groupKey);
        if (!group) continue;
        const groupId = toNumber(group.id);

        const insertedUser = insertGroupUser.run(
          groupId,
          row.visitorId,
          row.createdAt,
          row.createdAt,
        );
        if (toNumber(insertedUser.changes) === 1) {
          // 这个访客第一次触发该错误 → 影响用户数 +1
          incAffectedUsers.run(groupId);
        } else {
          // 老访客重复触发 → 只累加该访客的命中次数与最近时间
          touchGroupUser.run(row.createdAt, groupId, row.visitorId);
        }

        groupMap.set(row.groupKey, {
          groupKey: row.groupKey,
          errorType: group.error_type ?? null,
          name: group.name ?? null,
          message: group.message ?? null,
          sampleUrl: group.sample_url ?? null,
          totalCount: toNumber(group.total_count),
          affectedUsers: toNumber(group.affected_users),
          firstSeen: toNumber(group.first_seen),
          lastSeen: toNumber(group.last_seen),
          // prevCounts 里存 -1 表示「本批写之前这个分组还不存在」→ 本批就是它的首次出现
          isNew: (prevCounts.get(row.groupKey) ?? 0) === -1,
        });
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }

    result.groups = Array.from(groupMap.values());
    return result;
  }

  /**
   * 错误分组列表（/api/stats/errors）。
   *
   * - WHERE last_seen >= ?：只看「最近还在发生」的分组（since 由路由按 windowHours 算出）；
   * - ORDER BY total_count DESC, last_seen DESC：先按累计次数，再按新鲜度；
   * - 不 SELECT id：内部自增 id 不对外暴露（与 JsonStore 的返回保持一致）。
   */
  listErrorGroups(limit: number, since: number): GroupStat[] {
    const rows = this.stmt(
      `SELECT group_key, error_type, name, message, sample_url, total_count, affected_users, first_seen, last_seen
         FROM error_groups
        WHERE last_seen >= ?
        ORDER BY total_count DESC, last_seen DESC
        LIMIT ?`,
    ).all(since, limit);
    return rows.map((row) => ({
      groupKey: String(row.group_key),
      errorType: row.error_type ?? null,
      name: row.name ?? null,
      message: row.message ?? null,
      sampleUrl: row.sample_url ?? null,
      totalCount: toNumber(row.total_count),
      affectedUsers: toNumber(row.affected_users),
      firstSeen: toNumber(row.first_seen),
      lastSeen: toNumber(row.last_seen),
      isNew: false,
    }));
  }

  /**
   * 某个错误分组的最近明细样本（错误列表展开行「最近堆栈」）。
   *
   * - 只查 kind='error'，按 created_at 倒序取前 limit 条；
   * - stack 在修复前的旧数据里是 NULL，用 payload.stack 回填（payload 可能被截断，
   *   解析失败时返回 null，不影响其它字段）；
   * - 不返回 visitor_id / ip 等身份字段，避免详情接口扩大敏感信息暴露面。
   */
  listErrorSamples(groupKey: string, limit: number): ErrorSample[] {
    const rows = this.stmt(
      `SELECT error_type, name, message, stack, url, ua, sdk_version, created_at, payload
         FROM events
        WHERE kind = 'error' AND group_key = ?
        ORDER BY created_at DESC
        LIMIT ?`,
    ).all(groupKey, limit);

    return rows.map((row) => ({
      errorType: row.error_type ?? null,
      name: row.name ?? null,
      message: row.message ?? null,
      stack: row.stack ?? stackFromPayload(row.payload ?? null),
      url: row.url ?? null,
      ua: row.ua ?? null,
      sdkVersion: row.sdk_version ?? null,
      createdAt: toNumber(row.created_at),
    }));
  }

  /**
   * PV/UV 日趋势（两条 SQL 拼起来）。
   *
   * 为什么拆两条：
   * - PV 要 SUM(count)（一条上报可能代表多次浏览）；
   * - UV 要 COUNT(DISTINCT visitor_id) 且必须把 kind='uv' 也算进来（SDK 可能只报 UV 不报 PV）；
   * 两条 SQL 再按 day 合并，避免在 SQL 里写复杂的条件聚合（SQLite 上没有 FILTER 子句的通用写法）。
   *
   * 日期口径：strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') —— created_at 是毫秒，
   * 要先除以 1000 转成秒；输出是 UTC 日期（与 JsonStore 的 toISOString 口径一致）。
   */
  listPvDaily(days: number): PvDailyRow[] {
    const since = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
    const pvRows = this.stmt(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, SUM(count) AS pv
         FROM events WHERE kind = 'pv' AND created_at >= ?
        GROUP BY day ORDER BY day ASC`,
    ).all(since);
    const uvRows = this.stmt(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              COUNT(DISTINCT visitor_id) AS uv
         FROM events WHERE kind IN ('pv', 'uv') AND created_at >= ?
        GROUP BY day ORDER BY day ASC`,
    ).all(since);
    const uvMap = new Map<string, number>();
    for (const row of uvRows) uvMap.set(String(row.day), toNumber(row.uv));
    return pvRows.map((row) => ({
      day: String(row.day),
      pv: toNumber(row.pv),
      uv: uvMap.get(String(row.day)) || 0,
    }));
  }

  /**
   * PV 路由排行。
   *
   * - COALESCE(route_to, url, '(unknown)')：优先 SPA 目标路由，其次完整 URL，最后兜底占位；
   * - COUNT(DISTINCT visitor_id)：该路由的独立访客数（不是全站 UV）；
   * - 只统计 kind='pv'（uv 事件没有 route 语义），按 pv 降序取前 limit。
   */
  listPvRoute(limit: number, since: number): PvRouteRow[] {
    const rows = this.stmt(
      `SELECT COALESCE(route_to, url, '(unknown)') AS route,
              SUM(count) AS pv,
              COUNT(DISTINCT visitor_id) AS uv
         FROM events
        WHERE kind = 'pv' AND created_at >= ?
        GROUP BY route
        ORDER BY pv DESC
        LIMIT ?`,
    ).all(since, limit);
    return rows.map((row) => ({
      route: String(row.route),
      pv: toNumber(row.pv),
      uv: toNumber(row.uv),
    }));
  }

  /**
   * 概览指标（三条聚合 SQL，都是索引可命中的写法）。
   *
   * - errors：COUNT(1) 统计「错误行数」（一行 = 一次上报，可能是 SDK 合并前的真实条数）；
   * - pv    ：COALESCE(SUM(count), 0) —— 空结果集时 SUM 返回 NULL，必须兜底成 0；
   * - uv    ：COUNT(DISTINCT visitor_id) 且 kind IN ('pv','uv')，与 listPvDaily 口径一致；
   * - errorRate：errors / pv，保留 4 位小数；pv=0 时返回 0，避免 NaN/Infinity 进入 JSON。
   */
  overview(since: number): OverviewRow {
    const errRow = this.stmt(
      "SELECT COUNT(1) AS c FROM events WHERE kind = 'error' AND created_at >= ?",
    ).get(since);
    const pvRow = this.stmt(
      "SELECT COALESCE(SUM(count), 0) AS c FROM events WHERE kind = 'pv' AND created_at >= ?",
    ).get(since);
    const uvRow = this.stmt(
      "SELECT COUNT(DISTINCT visitor_id) AS c FROM events WHERE kind IN ('pv','uv') AND created_at >= ?",
    ).get(since);
    const errors = toNumber(errRow && errRow.c);
    const pv = toNumber(pvRow && pvRow.c);
    const uv = toNumber(uvRow && uvRow.c);
    return {
      errors,
      pv,
      uv,
      visitors: uv,
      errorRate: pv > 0 ? Number((errors / pv).toFixed(4)) : 0,
    };
  }

  /** 全部规则（含停用的），按 id 升序；AlertEngine.reload 会再过滤 enabled=1 */
  listAlertRules(): AlertRuleRow[] {
    const rows = this.stmt(
      `SELECT id, name, scope, scope_value, metric, threshold, window_ms, cooldown_ms, enabled, channels
         FROM alert_rules ORDER BY id ASC`,
    ).all();
    return rows.map((row) => ({
      id: toNumber(row.id),
      name: String(row.name),
      scope: row.scope,
      scopeValue: row.scope_value ?? null,
      metric: row.metric,
      threshold: toNumber(row.threshold),
      windowMs: toNumber(row.window_ms),
      cooldownMs: toNumber(row.cooldown_ms),
      enabled: toNumber(row.enabled),
      channels: String(row.channels || '["console"]'),
    }));
  }

  /**
   * 新增或覆盖规则（UPSERT by name）。
   *
   * - 冲突判定用 name（唯一索引），所以「改阈值」只要同名 POST 一次即可；
   * - id 允许传 null（不传时由 AUTOINCREMENT 生成）；已存在同名规则时 id 不会变
   *   （ON CONFLICT 分支里没有更新 id），保证 AlertEngine 冷却 key 稳定；
   * - 注意 UPDATE 分支不包含 name —— name 就是冲突键，改它等于插一条新规则。
   */
  saveAlertRule(rule: Omit<AlertRuleRow, 'id'> & { id?: number }): void {
    this.stmt(
      `INSERT INTO alert_rules
        (id, name, scope, scope_value, metric, threshold, window_ms, cooldown_ms, enabled, channels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         scope = excluded.scope,
         scope_value = excluded.scope_value,
         metric = excluded.metric,
         threshold = excluded.threshold,
         window_ms = excluded.window_ms,
         cooldown_ms = excluded.cooldown_ms,
         enabled = excluded.enabled,
         channels = excluded.channels`,
    ).run(
      rule.id ?? null,
      rule.name,
      rule.scope,
      rule.scopeValue,
      rule.metric,
      rule.threshold,
      rule.windowMs,
      rule.cooldownMs,
      rule.enabled,
      rule.channels,
    );
  }

  /**
   * 追加一条预警记录。
   *
   * 注意：这里**不吞异常**（与 AlertService.persistLog 的 try/catch 配合）——
   * 存储层保持「要么成功要么抛错」的语义，由调用方决定是否降级。
   */
  logAlert(entry: AlertLogRow): void {
    this.stmt(
      `INSERT INTO alert_log
        (rule_id, rule_name, group_key, metric, value, threshold, window_ms, channels, payload, delivered, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.ruleId,
      entry.ruleName,
      entry.groupKey,
      entry.metric,
      entry.value,
      entry.threshold,
      entry.windowMs,
      entry.channels,
      entry.payload,
      entry.delivered,
      entry.error,
      entry.createdAt,
    );
  }

  /** 最近的预警日志：ORDER BY id DESC（id 自增 == 时间顺序），LIMIT 由调用方控制 */
  listAlerts(limit: number): AlertLogEntry[] {
    const rows = this.stmt(
      `SELECT id, rule_id, rule_name, group_key, metric, value, threshold, window_ms, channels, payload, delivered, error, created_at
         FROM alert_log ORDER BY id DESC LIMIT ?`,
    ).all(limit);
    return rows.map((row) => ({
      id: toNumber(row.id),
      ruleId: row.rule_id === null ? null : toNumber(row.rule_id),
      ruleName: String(row.rule_name || ''),
      groupKey: row.group_key ?? null,
      metric: String(row.metric || ''),
      value: toNumber(row.value),
      threshold: toNumber(row.threshold),
      windowMs: toNumber(row.window_ms),
      channels: String(row.channels || '[]'),
      payload: String(row.payload || ''),
      delivered: toNumber(row.delivered),
      error: row.error ?? null,
      createdAt: toNumber(row.created_at),
    }));
  }

  /**
   * 过期数据清理（保留策略的唯一入口，由 index.ts 的定时器调用）。
   *
   * 顺序与原因：
   * 1. 先查出 last_seen < ts 的分组 id 列表（后面要逐个删它的 groupUsers）；
   * 2. 一个事务内：删 error_group_users → 删 error_groups → 删 events → 删 alert_log；
   *    先删子表再删主表，避免留下悬挂的统计行（这也是开 foreign_keys 的意义）；
   * 3. alert_log 按 created_at 清理，但**不删 alert_rules**（配置类数据需要长期保留）；
   * 4. 失败时 ROLLBACK 并抛出，由调用方（index.ts）打日志 —— 不会留下半清理状态。
   *
   * @returns 删除的 groupUsers + groups + events 行数（不含 alert_log，与 JsonStore 口径一致）
   */
  purgeBefore(ts: number): number {
    const groupRows = this.stmt('SELECT id FROM error_groups WHERE last_seen < ?').all(ts);
    let removed = 0;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // 先删「错误 × 访客」，再删分组，最后删明细，避免留下悬挂的统计
      const delGroupUser = this.stmt('DELETE FROM error_group_users WHERE group_id = ?');
      for (const group of groupRows) {
        removed += toNumber(delGroupUser.run(toNumber(group.id)).changes);
      }
      removed += toNumber(
        this.stmt('DELETE FROM error_groups WHERE last_seen < ?').run(ts).changes,
      );
      removed += toNumber(this.stmt('DELETE FROM events WHERE created_at < ?').run(ts).changes);
      this.stmt('DELETE FROM alert_log WHERE created_at < ?').run(ts);
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    return removed;
  }

  /**
   * 关闭连接：先清语句缓存（释放 prepared statement），再关闭数据库。
   *
   * 关闭失败也吞掉：进程即将退出，这里抛错只会让退出流程变成非 0 状态码。
   * 可重复调用（第二次 close 会抛，被 catch 吃掉）。
   */
  close(): void {
    this.stmtCache.clear();
    try {
      this.db.close();
    } catch (error) {
      // 关闭失败不影响进程退出
    }
  }
}
