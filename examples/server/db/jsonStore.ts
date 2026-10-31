import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
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

/** JSON 存储里的分组行：比 GroupStat 多一个内部自增 id（用于 groupUsers 关联），对外不暴露 */
interface JsonGroup {
  /** 内部自增 id（seq.group），仅用于 `${id}|${visitorId}` 关联去重 */
  id: number;
  groupKey: string;
  errorType: string | null;
  name: string | null;
  message: string | null;
  sampleUrl: string | null;
  totalCount: number;
  affectedUsers: number;
  firstSeen: number;
  lastSeen: number;
}

/** 整个 JSON 文件的根结构（等价于 SQLite 的 5 张表 + 2 个自增序列） */
interface JsonState {
  /** 明细（error/pv/uv 混存，与 events 表对应） */
  events: EventRow[];
  /** 错误聚合（与 error_groups 表对应） */
  groups: JsonGroup[];
  /** 错误 × 访客去重：key = `${groupId}|${visitorId}`，value = 命中次数（对应 error_group_users 表） */
  groupUsers: Record<string, number>;
  /** 预警规则（alert_rules） */
  rules: AlertRuleRow[];
  /** 预警日志（alert_log），带自增 id */
  alerts: AlertLogEntry[];
  /** 自增序列：JSON 没有 AUTOINCREMENT，只能自己维护 */
  seq: { group: number; alert: number };
}

/**
 * ============================================================================
 * JSON 文件存储（降级实现）
 * ============================================================================
 *
 * 适用场景：本机没开 --experimental-sqlite、或想「零依赖」快速跑通 demo。
 * 与 SqliteStore 实现同一个 Store 接口，业务代码（采集/查询/预警）完全无感知。
 *
 * 内部模型（整个文件就是一个 JsonState）：
 *   events     ：全部明细（数组，按写入顺序追加）
 *   groups     ：错误聚合（数组，按 groupKey 线性查找）
 *   groupUsers ：`${groupId}|${visitorId}` → 命中次数（用于 affectedUsers 去重）
 *   rules/alerts/seq：预警规则、告警日志、自增序号
 *
 * 必须知道的局限（只适合 demo / 小流量）：
 * - 全量数据常驻内存，且**每次写入都全量序列化落盘**（O(总量)），数据大了会明显变慢；
 * - 写入是同步 writeFileSync，没有 WAL / 事务，进程被 kill 时可能截断文件
 *   （下次启动解析失败会重置为空，见 load 的 catch）；
 * - 查询是线性扫描（listPvDaily 等），没有索引；
 * - 单进程独占：两个进程同时写同一个文件会互相覆盖。
 * 迁到 SQLite 后上述问题全部消失，接口不变。
 */
export class JsonStore implements Store {
  readonly driver = 'json' as const;
  readonly location: string;
  private state: JsonState;
  /** 幂等去重集：与 state.events 的 eventUid 保持同步（内存 Set，查询 O(1)） */
  private eventUids = new Set<string>();

  constructor(file: string) {
    this.location = file;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.state = this.load(file);
  }

  /**
   * 读取（或初始化）状态文件。
   *
   * 容错策略：
   * - 文件不存在 → 返回空状态（首次启动的正常路径）；
   * - 文件损坏 / 字段缺失 → 回退到空状态并丢掉坏文件内容（宁可丢历史，也要保证服务能起来）；
   * - 用 `{...empty, ...parsed}` 合并，兼容「旧版本文件缺少新字段」的升级场景；
   * - 启动时顺便重建 eventUids 去重集合，保证幂等判重跨重启有效。
   */
  private load(file: string): JsonState {
    const empty: JsonState = {
      events: [],
      groups: [],
      groupUsers: {},
      rules: [],
      alerts: [],
      seq: { group: 0, alert: 0 },
    };
    if (!existsSync(file)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<JsonState>;
      const state: JsonState = {
        ...empty,
        ...parsed,
        seq: parsed.seq || empty.seq,
        groupUsers: parsed.groupUsers || {},
      };
      for (const event of state.events) this.eventUids.add(event.eventUid);
      return state;
    } catch (error) {
      // 文件损坏时重置，避免服务起不来
      return empty;
    }
  }

  /**
   * 全量落盘。
   *
   * 失败只吞掉（不打日志）：写盘失败通常是磁盘满/权限问题，此时打日志也写不进去，
   * 而且不应该让「持久化失败」变成「请求失败」——内存里的数据仍然可以查询。
   */
  private persist(): void {
    try {
      writeFileSync(this.location, JSON.stringify(this.state), 'utf8');
    } catch (error) {
      // 落盘失败只影响持久化，不影响请求处理
    }
  }

  /**
   * 初始化：只在「规则表为空」时灌默认规则（不覆盖用户改过的阈值，与 SqliteStore 行为一致）。
   * JSON 存储没有建表动作，init 只负责保证 rules 有默认值并落盘一次。
   */
  init(): void {
    if (this.state.rules.length === 0) {
      this.state.rules = DEFAULT_ALERT_RULES.map((rule, index) => ({ ...rule, id: index + 1 }));
    }
    this.persist();
  }

  /**
   * 批量写入（幂等 + 聚合维护）。
   *
   * 逐行处理顺序（顺序不能变）：
   *   1. eventUid 已存在 → duplicated++，跳过（不重复累加聚合）
   *   2. 否则入 events、登记 eventUid、inserted++
   *   3. 只有 kind='error' 且带 groupKey 的行才进聚合
   *   4. 聚合：找不到分组就按当前行「建档」（firstSeen=当前行时间），然后 totalCount++ / lastSeen 更新
   *   5. 用户去重：groupUsers 里没有 (groupId|visitorId) 说明是新访客 → affectedUsers++，否则只累加命中次数
   *
   * isNew 的语义（曾踩过的坑）：同批次里同一个新分组可能出现多条事件，
   * 必须用 createdGroups 记住「本批创建过」，否则后一条会把 isNew 覆盖成 false，
   * 导致「新错误首次出现」这条预警在同批数据里被漏掉。
   */
  writeEvents(rows: EventRow[]): WriteResult {
    const result: WriteResult = { inserted: 0, duplicated: 0, groups: [] };
    if (!rows || rows.length === 0) return result;
    const touched = new Map<string, GroupStat>();
    /** 本批次内新建的分组；同批次后续同组事件不能把 isNew 覆盖成 false */
    const createdGroups = new Set<string>();

    for (const row of rows) {
      if (this.eventUids.has(row.eventUid)) {
        result.duplicated += 1;
        continue;
      }
      this.eventUids.add(row.eventUid);
      this.state.events.push(row);
      result.inserted += 1;

      if (row.kind !== 'error' || !row.groupKey) continue;

      let group = this.state.groups.find((item) => item.groupKey === row.groupKey);
      if (!group) {
        this.state.seq.group += 1;
        group = {
          id: this.state.seq.group,
          groupKey: row.groupKey,
          errorType: row.errorType,
          name: row.name,
          message: row.message,
          sampleUrl: row.url,
          totalCount: 0,
          affectedUsers: 0,
          firstSeen: row.createdAt,
          lastSeen: row.createdAt,
        };
        this.state.groups.push(group);
        createdGroups.add(group.groupKey);
      }

      group.totalCount += 1;
      group.lastSeen = row.createdAt;
      group.errorType = group.errorType || row.errorType;
      group.message = group.message || row.message;

      const userKey = `${group.id}|${row.visitorId}`;
      if (this.state.groupUsers[userKey] === undefined) {
        this.state.groupUsers[userKey] = 1;
        group.affectedUsers += 1;
      } else {
        this.state.groupUsers[userKey] += 1;
      }

      touched.set(group.groupKey, {
        groupKey: group.groupKey,
        errorType: group.errorType,
        name: group.name,
        message: group.message,
        sampleUrl: group.sampleUrl,
        totalCount: group.totalCount,
        affectedUsers: group.affectedUsers,
        firstSeen: group.firstSeen,
        lastSeen: group.lastSeen,
        isNew: createdGroups.has(group.groupKey),
      });
    }

    this.persist();
    result.groups = Array.from(touched.values());
    return result;
  }

  /**
   * 错误分组列表（/api/stats/errors 的数据源）。
   *
   * - 过滤：只保留 lastSeen >= since 的分组（「最近还在发生」的错误）；
   * - 排序：先按总次数降序，次数相同再按最近出现时间降序（把「又多又新」的排前面）；
   * - 结构：**剥掉内部自增 id**，与 SqliteStore 的返回保持一致；
   *   isNew 恒为 false —— 查询接口语义是「当前聚合快照」，不是「本次写入增量」。
   */
  listErrorGroups(limit: number, since: number): GroupStat[] {
    return this.state.groups
      .filter((group) => group.lastSeen >= since)
      .sort((a, b) => b.totalCount - a.totalCount || b.lastSeen - a.lastSeen)
      .slice(0, limit)
      // 与 SqliteStore 保持同样的返回结构，不把内部自增 id 暴露给接口
      .map(({ id, ...group }) => ({ ...group, isNew: false }));
  }

  /**
   * 某个错误分组的最近明细样本（错误列表展开行「最近堆栈」）。
   *
   * 与 SqliteStore 语义一致：按 createdAt 倒序、不含身份字段；
   * stack 为 null 时从 payload.stack 回填旧数据。
   */
  listErrorSamples(groupKey: string, limit: number): ErrorSample[] {
    return this.state.events
      .filter((event) => event.kind === 'error' && event.groupKey === groupKey)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((event) => ({
        errorType: event.errorType,
        name: event.name,
        message: event.message,
        stack: event.stack ?? stackFromPayload(event.payload),
        url: event.url,
        ua: event.ua,
        sdkVersion: event.sdkVersion,
        createdAt: event.createdAt,
      }));
  }

  /**
   * PV/UV 日趋势。
   *
   * 口径说明（容易踩坑）：
   * - 只统计 kind='pv' / 'uv' 的事件，错误事件不参与；
   * - pv 用 SUM(count)：SDK 可能把多次 PV 合并成一条上报；
   * - uv 用「当天出现过的不同 visitorId」：同一个人当天多次访问只算 1；
   * - 日期用 toISOString() 的 UTC 日期（与 SQLite 的 strftime(unixepoch) 一致，避免两边时区不同）；
   * - 输出按日期升序，只包含「有数据的日期」（不补零），前端画图时需自行补齐空档。
   */
  listPvDaily(days: number): PvDailyRow[] {
    const since = Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000;
    const map = new Map<string, { pv: number; visitors: Set<string> }>();
    for (const event of this.state.events) {
      if (event.createdAt < since || (event.kind !== 'pv' && event.kind !== 'uv')) continue;
      const day = new Date(event.createdAt).toISOString().slice(0, 10);
      const bucket = map.get(day) || { pv: 0, visitors: new Set<string>() };
      if (event.kind === 'pv') bucket.pv += event.count;
      bucket.visitors.add(event.visitorId);
      map.set(day, bucket);
    }
    return Array.from(map.keys())
      .sort()
      .map((day) => {
        const bucket = map.get(day);
        return { day, pv: bucket.pv, uv: bucket.visitors.size };
      });
  }

  /**
   * PV 路由排行（取 PV 最多的前 limit 个路由）。
   *
   * - 路由 key 的优先级：route_to（SPA 跳转目标）→ url → '(unknown)'，
   *   这样「SPA 内部跳转」和「直接打开页面」都能被归到合理维度；
   * - uv 是「该路由下的不同访客数」，同一个访客访问多个路由会在每个路由各算一次；
   * - 只统计 kind='pv'，且 createdAt >= since。
   */
  listPvRoute(limit: number, since: number): PvRouteRow[] {
    const map = new Map<string, { pv: number; visitors: Set<string> }>();
    for (const event of this.state.events) {
      if (event.kind !== 'pv' || event.createdAt < since) continue;
      const route = event.routeTo || event.url || '(unknown)';
      const bucket = map.get(route) || { pv: 0, visitors: new Set<string>() };
      bucket.pv += event.count;
      bucket.visitors.add(event.visitorId);
      map.set(route, bucket);
    }
    return Array.from(map.entries())
      .map(([route, bucket]) => ({ route, pv: bucket.pv, uv: bucket.visitors.size }))
      .sort((a, b) => b.pv - a.pv)
      .slice(0, limit);
  }

  /**
   * 概览指标（since 之后）。
   *
   * 口径：
   * - errors：错误**条数**（一行算 1，不受 count 字段影响）；
   * - pv    ：SUM(count)，即真实的页面浏览次数；
   * - uv    ：pv/uv 事件里出现过的不同 visitorId 数（只上送了错误、没上送 PV 的访客不计入）；
   * - errorRate：errors / pv，保留 4 位小数；pv=0 时返回 0（不产生 Infinity/NaN）。
   */
  overview(since: number): OverviewRow {
    let errors = 0;
    let pv = 0;
    const visitors = new Set<string>();
    for (const event of this.state.events) {
      if (event.createdAt < since) continue;
      if (event.kind === 'error') errors += 1;
      if (event.kind === 'pv') {
        pv += event.count;
        visitors.add(event.visitorId);
      }
      if (event.kind === 'uv') visitors.add(event.visitorId);
    }
    return {
      errors,
      pv,
      uv: visitors.size,
      visitors: visitors.size,
      errorRate: pv > 0 ? Number((errors / pv).toFixed(4)) : 0,
    };
  }

  /** 规则列表（返回副本，避免调用方改到内部状态；不做排序，顺序即插入顺序） */
  listAlertRules(): AlertRuleRow[] {
    return this.state.rules.map((rule) => ({ ...rule }));
  }

  /**
   * 新增 / 覆盖规则（按 name 匹配，与 SQLite 的 ON CONFLICT(name) 语义一致）。
   *
   * - 已存在同名规则 → 覆盖除 id 以外的所有字段（id 保持不变，因为冷却 key 用的是 id）；
   * - 不存在 → 追加，id 取「当前最大 id + 1」（不依赖数组长度，删除后也不会撞号）。
   */
  saveAlertRule(rule: Omit<AlertRuleRow, 'id'> & { id?: number }): void {
    const exist = this.state.rules.find((item) => item.name === rule.name);
    if (exist) {
      Object.assign(exist, rule, { id: exist.id });
    } else {
      const id = rule.id || Math.max(0, ...this.state.rules.map((item) => item.id)) + 1;
      this.state.rules.push({ ...(rule as AlertRuleRow), id });
    }
    this.persist();
  }

  /** 追加一条告警日志（id 自增，永不覆盖）；每次写都全量落盘 */
  logAlert(entry: AlertLogRow): void {
    this.state.seq.alert += 1;
    this.state.alerts.push({ ...entry, id: this.state.seq.alert });
    this.persist();
  }

  /** 最近的告警日志：按 id 倒序（= 时间倒序）取前 limit 条 */
  listAlerts(limit: number): AlertLogEntry[] {
    return this.state.alerts
      .slice()
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }

  /**
   * 清理过期数据（保留策略）。
   *
   * 清理顺序与规则（与 SqliteStore 保持一致）：
   * 1. events：createdAt < ts 的明细，同时从 eventUids 里移除（否则这个 eventUid 再也写不回来）；
   * 2. error_groups：lastSeen < ts 的分组，并连带清理它的 groupUsers 行（避免悬挂的去重记录）；
   * 3. alert_log：createdAt < ts 的历史告警（只保留近期，避免文件无限膨胀）；
   * 4. alert_rules 永远不清理（配置类数据）。
   *
   * @returns 删除的明细行数 + 分组数（不含 alert_log，与 SQLite 实现的计数口径一致）
   */
  purgeBefore(ts: number): number {
    const beforeEvents = this.state.events.length;
    const expired = this.state.events.filter((event) => event.createdAt < ts);
    for (const event of expired) this.eventUids.delete(event.eventUid);
    this.state.events = this.state.events.filter((event) => event.createdAt >= ts);

    const beforeGroups = this.state.groups.length;
    const staleGroups = this.state.groups.filter((group) => group.lastSeen < ts);
    for (const group of staleGroups) {
      for (const key of Object.keys(this.state.groupUsers)) {
        if (key.startsWith(`${group.id}|`)) delete this.state.groupUsers[key];
      }
    }
    this.state.groups = this.state.groups.filter((group) => group.lastSeen >= ts);

    this.state.alerts = this.state.alerts.filter((alert) => alert.createdAt >= ts);
    this.persist();
    return beforeEvents - this.state.events.length + (beforeGroups - this.state.groups.length);
  }

  /** 关闭：JSON 存储没有连接可关，这里只做最后一次落盘（可重复调用） */
  close(): void {
    this.persist();
  }
}
