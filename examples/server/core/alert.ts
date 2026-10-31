import { AlertRuleRow, EventRow, GroupStat, Store } from '../db/types';

/**
 * ============================================================================
 * 预警引擎：纯内存滑动窗口 + 阈值判定（不落库、不推送）
 * ============================================================================
 *
 * 分层职责：
 *   AlertEngine（本文件）  只负责「算」：喂数据、维护窗口、判断是否越阈值、冷却去重
 *   AlertService           负责「做」：拿判定结果 → 落 alert_log → 调 Notifier 推送
 *   Notifier               负责「发」：控制台 + webhook（raw / 飞书 / 钉钉 / 企微）
 * 这样拆的好处：引擎是纯计算（好测、无副作用），推送失败不会影响统计的正确性。
 *
 * 统计模型（三类 key 前缀，全部存在同一个 Map 里）：
 *   'global'            全局所有错误
 *   'type:<errorType>'  按错误类型，例如 type:JAVASCRIPT_ERROR
 *   'group:<groupKey>'  按错误指纹分组（groupKey = err_<errorId> 或 fp_<sha1>）
 *   'new_group'         新分组出现事件（visitorId 传空串，统计的是「新增分组条数」）
 *
 * 三种指标的语义（与 db/types.ts 的 DEFAULT_ALERT_RULES 对应）：
 *   metric='count'     → 窗口内错误条数 >= threshold
 *   metric='users'     → 窗口内「不同 visitorId 数」>= threshold（同一用户重复报只算 1）
 *   metric='new_group' → 窗口内新建的错误分组数 >= threshold
 *
 * 设计取舍：
 * - 实时性：每批写库成功就 observe 一次，阈值判断在内存完成，O(1) 级别；
 * - 准确性：窗口内的「条数」和「去重访客数」都能算，满足「同一错误影响多少用户」；
 * - 成本：不做全量 SQL 聚合，避免每次上报都扫表；
 * - 冷却：同一规则 + 同一分组在 cooldownMs 内只报一次，防止告警风暴。
 *
 * 已知边界（demo 可接受，生产需注意）：
 * - 窗口数据在内存里，进程重启即清空 → 重启后第一个窗口「统计偏少」，只会漏报不会误报；
 * - 单实例有效；多实例部署时每个实例各自判断，需要靠「冷却 + 去重键」在推送侧收敛；
 * - firedAt 只增不删，条目数上限 ≈ 规则数 × 分组数，量级可控。
 */

/** 窗口内的一条原始记录：只保留判定所需的最小信息（时间 + 访客），节省内存 */
interface BucketEntry {
  ts: number;
  visitorId: string;
}

/** 一次命中：由 AlertService 负责落库 + 推送 */
export interface AlertDecision {
  /** 命中的规则快照（推送文案、冷却 key 都要用） */
  rule: AlertRuleRow;
  /** 命中的分组 key（scope=group 时有值，其余为 null；用于文案与 alert_log.group_key） */
  groupKey: string | null;
  /** 命中时使用的指标（count / users / new_group） */
  metric: string;
  /** 窗口内实际统计值（可能远大于阈值） */
  value: number;
  /** 规则阈值（用于文案「value（阈值 threshold / 时间窗）」） */
  threshold: number;
  /** 规则窗口长度（ms），用于文案 */
  windowMs: number;
  /** 分组样本（分组规则时给「错误信息、首次出现、累计次数」等上下文；其它规则为 null） */
  sample: GroupStat | null;
}

/** 单个 key 的滑动窗口最大长度，防止异常流量把内存打爆 */
const MAX_BUCKET_SIZE = 5000;

/**
 * 预警引擎（纯内存滑动窗口，不落库）。
 *
 * 生命周期：
 *   new AlertEngine(store)  → 构造时就从库里加载启用的规则（reload）
 *   observe(rows, groups)   → 由 WriteQueue.onFlushed 驱动，写库成功后累加窗口
 *   evaluate(now)           → 由 AlertService 的定时器（默认 5s）调用，产出 AlertDecision[]
 *   reload()                → 规则被 /api/alerts/rules 修改后调用，重新读库
 */
export class AlertEngine {
  /** 当前启用的规则快照（enabled=1）；reload 时整体替换 */
  private rules: AlertRuleRow[] = [];
  /** key → 窗口内条目（按 ts 升序追加，裁剪时从头删，保证数组始终有序） */
  private buckets = new Map<string, BucketEntry[]>();
  /** 冷却记录：key = `${rule.id}:${groupKey || bucketKey}`，value = 上次触发时间 */
  private firedAt = new Map<string, number>();
  /** 分组样本：groupKey → 最近一次写库返回的聚合结果（只用于告警文案，最多保留 2000 条） */
  private samples = new Map<string, GroupStat>();

  constructor(private store: Store) {
    this.reload();
  }

  /**
   * 重新加载规则（改了阈值 / 新增规则后调用）。
   *
   * 只保留 enabled=1 的规则 → 停用规则等价于「从引擎里删掉」，不需要额外状态；
   * 注意这里不会清理已累积的窗口数据：重新启用规则后，旧窗口仍会被继续使用
   *（这是期望行为：窗口统计与规则启停解耦）。
   */
  reload(): void {
    this.rules = this.store.listAlertRules().filter((rule) => rule.enabled === 1);
  }

  /** 当前生效的规则（只读，调用方不要修改数组里的对象） */
  getRules(): AlertRuleRow[] {
    return this.rules;
  }

  /**
   * 往某个 key 的窗口追加一条记录。
   *
   * 超长保护：超过 MAX_BUCKET_SIZE 时从头部（最老的）删，只保留最近 5000 条。
   * 对「1 分钟窗口」来说 5000 条通常远大于阈值，因此截断只影响 value 的绝对值，
   * 不影响「是否越过阈值」的判断。
   */
  private push(key: string, ts: number, visitorId: string): void {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push({ ts, visitorId });
    if (bucket.length > MAX_BUCKET_SIZE) bucket.splice(0, bucket.length - MAX_BUCKET_SIZE);
  }

  /**
   * 写入成功后喂数据：只有错误类事件参与预警。
   *
   * 参数语义：
   * - rows   ：本批真正写入库的明细（PV/UV 直接跳过，它们不参与错误预警）
   * - groups ：本批涉及的错误分组聚合结果，isNew=true 表示「本批新建了这个分组」
   * - now    ：批次的处理时间（同一批内所有条共用同一个时间戳，避免批内漂移）
   *
   * 为什么 group 样本要单独缓存：告警文案需要「错误类型 / 错误信息 / 首次出现 / 累计次数」，
   * 这些只有聚合表有；evaluate 阶段再查库会引入 IO，所以在 observe 时就存下来。
   */
  observe(rows: EventRow[], groups: GroupStat[], now: number = Date.now()): void {
    for (const row of rows) {
      if (row.kind !== 'error') continue;
      // 每条错误同时进三个窗口：全局 / 类型 / 分组，供不同 scope 的规则各自取用
      this.push('global', now, row.visitorId);
      if (row.errorType) this.push(`type:${row.errorType}`, now, row.visitorId);
      if (row.groupKey) this.push(`group:${row.groupKey}`, now, row.visitorId);
    }
    for (const group of groups) {
      this.samples.set(group.groupKey, group);
      // 新分组：visitorId 传空串（去重无意义），此时 metric='count' 语义即「新增分组数」
      if (group.isNew) this.push('new_group', now, '');
    }
    // 只保留最近 2000 个分组样本，避免无限增长（超出时丢最老的）
    if (this.samples.size > 2000) {
      const keys = Array.from(this.samples.keys()).slice(0, this.samples.size - 2000);
      for (const key of keys) this.samples.delete(key);
    }
  }

  /**
   * 取某个 key 在 [now - windowMs, now] 内的条目，并顺手把更早的条目从数组里删掉。
   *
   * 实现要点：
   * - 依赖「数组按 ts 升序」这个不变量，从头往后再删，代价 O(被删条数)；
   * - 裁剪范围用调用方传入的 windowMs（evaluate 会传「所有规则里最大的窗口」），
   *   这样同一个 bucket 被不同窗口的规则复用时，不会被短窗口规则提前裁掉长窗口需要的数据；
   * - 返回的是内部数组引用（不拷贝），调用方只读，不可再修改。
   */
  private windowEntries(key: string, windowMs: number, now: number): BucketEntry[] {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.length === 0) return [];
    const from = now - windowMs;
    // 窗口是有序追加的，从头裁剪即可
    let start = 0;
    while (start < bucket.length && bucket[start].ts < from) start += 1;
    if (start > 0) bucket.splice(0, start);
    return bucket;
  }

  /**
   * 规则的作用目标：全局 / 某类错误 / 某个错误分组。
   *
   * 返回的每个 target 是一对 (窗口 key, 分组 key)：
   * - scope='global'            → 只用 'global' 窗口
   * - scope='error_type' + 有值 → 只看 type:<scopeValue>
   * - scope='error_type' + 无值 → 对「当前已出现过的所有类型」各判一次（每种类型独立告警）
   * - scope='group' + 有值      → 只看 group:<scopeValue>
   * - scope='group' + 无值      → 对「当前所有分组」各判一次（典型的「单个错误影响用户数」规则）
   * - metric='new_group'        → 永远只看 'new_group' 窗口（与 scope 无关）
   *
   * 注意「无 scopeValue」的分支依赖 buckets 里已经出现过的 key，
   * 因此是「新分组/新类型出现后才可能告警」，不会对不存在的分组产生空告警。
   */
  private resolveTargets(rule: AlertRuleRow): Array<{ key: string; groupKey: string | null }> {
    if (rule.metric === 'new_group') return [{ key: 'new_group', groupKey: null }];
    if (rule.scope === 'error_type') {
      if (rule.scopeValue) return [{ key: `type:${rule.scopeValue}`, groupKey: null }];
      return Array.from(this.buckets.keys())
        .filter((key) => key.startsWith('type:'))
        .map((key) => ({ key, groupKey: null }));
    }
    if (rule.scope === 'group') {
      const groupKeys = rule.scopeValue
        ? [`group:${rule.scopeValue}`]
        : Array.from(this.buckets.keys()).filter((key) => key.startsWith('group:'));
      return groupKeys.map((key) => ({ key, groupKey: key.slice('group:'.length) }));
    }
    return [{ key: 'global', groupKey: null }];
  }

  /**
   * 评估所有规则，返回本次需要推送的预警。
   *
   * 判定流程（对「规则 × 目标」的笛卡尔积逐个判断）：
   *   1. 取窗口条目（先按「全规则最大窗口」裁剪，避免误删别的规则需要的数据）
   *   2. 再按本规则窗口精确过滤出 inWindow
   *   3. 算 value：users → 去重 visitorId 数；count / new_group → 条目数
   *   4. value < threshold → 跳过（不占用冷却）
   *   5. 冷却检查：同一 (rule.id, 分组) 在 cooldownMs 内已报过就跳过
   *   6. 记录 firedAt 并产出 decision
   *
   * 两个「有意为之」的行为：
   * - firedAt 在产出 decision 时就写入，而不是等推送成功 → 推送失败也不会在冷却期内反复轰炸；
   *   失败信息会落在 alert_log.error 里，需要重发就调 /api/alerts/test；
   * - value 用 `>=` 判断（等于阈值就报），符合「阈值」的直觉。
   *
   * @param now 可注入时间，单测用它推进窗口而不必真的等待
   */
  evaluate(now: number = Date.now()): AlertDecision[] {
    const decisions: AlertDecision[] = [];
    const maxWindow = Math.max(60 * 1000, ...this.rules.map((rule) => rule.windowMs));

    for (const rule of this.rules) {
      for (const target of this.resolveTargets(rule)) {
        const entries = this.windowEntries(target.key, Math.max(rule.windowMs, maxWindow), now);
        const inWindow = entries.filter((entry) => entry.ts >= now - rule.windowMs);
        const value =
          rule.metric === 'users'
            ? new Set(inWindow.map((entry) => entry.visitorId).filter(Boolean)).size
            : inWindow.length;
        if (value < rule.threshold) continue;

        const cooldownKey = `${rule.id}:${target.groupKey || target.key}`;
        const lastFired = this.firedAt.get(cooldownKey) || 0;
        if (now - lastFired < rule.cooldownMs) continue;
        this.firedAt.set(cooldownKey, now);

        decisions.push({
          rule,
          groupKey: target.groupKey,
          metric: rule.metric,
          value,
          threshold: rule.threshold,
          windowMs: rule.windowMs,
          sample: target.groupKey ? this.samples.get(target.groupKey) || null : null,
        });
      }
    }
    return decisions;
  }

  /** 当前所有窗口 key（调试 / 单测用，例如断言 'type:JAVASCRIPT_ERROR' 窗口是否已建立） */
  getBucketKeys(): string[] {
    return Array.from(this.buckets.keys());
  }
}
