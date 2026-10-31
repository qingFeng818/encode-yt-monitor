import { CollectorConfig } from '../config';
import { AlertLogRow, AlertRuleRow, EventRow, GroupStat, Store } from '../db/types';
import { AlertDecision, AlertEngine } from './alert';
import { buildMessage, Notifier, NotifyResult } from './notifier';

/**
 * ============================================================================
 * 预警服务：把「统计（AlertEngine）→ 落库（alert_log）→ 推送（Notifier）」串起来
 * ============================================================================
 *
 * 触发时机（只有一条：定时轮询，默认 5s）：
 * - 定时器到点 → engine.evaluate() 判定窗口是否越阈值；
 * - 写库回调 observe() **只累加窗口，不评估** —— 否则每批写库都评估一次，
 *   大流量下会把 CPU 全耗在重复判定上；5s 的告警延迟对线上排障完全够用。
 *
 * 为什么「推送失败也算触发成功」：
 * 预警的价值在于「出现过异常」，而不是「消息一定送达」。所以：
 * - 先 engine.evaluate() 拿到判定（内部已经写入冷却，不会重复触发）；
 * - 再推送，把 delivered / error 一起写进 alert_log；
 * - 推送失败不回滚、不重试整条链路，而是留下可追溯的记录 + 用 /api/alerts/test 手动补发。
 *
 * 并发模型：Node 单线程，但 runOnce 是 async（webhook 是 IO），两个 tick 可能交错，
 * 因此用 evaluating 标志做「单飞」保护：前一次还没跑完，后一次直接返回空数组。
 */
export class AlertService {
  /** 统计引擎（内存滑动窗口）；routes/stats.ts 改规则后会调 engine.reload() */
  readonly engine: AlertEngine;
  /** 推送器（控制台 + 可选 webhook） */
  readonly notifier: Notifier;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 避免定时器与写库回调并发评估导致重复推送（单飞锁，不是队列） */
  private evaluating = false;

  constructor(
    private store: Store,
    private config: CollectorConfig,
  ) {
    this.engine = new AlertEngine(store);
    this.notifier = new Notifier({
      webhookUrl: config.alertWebhookUrl,
      format: config.alertWebhookFormat,
      timeoutMs: config.alertWebhookTimeoutMs,
    });
  }

  /**
   * 写队列落库回调：喂给引擎做实时统计。
   *
   * 注意这里只「记数」不「评估」：如果每次写库都评估，流量大时会疯狂跑 evaluate，
   * 判定交给定时器（默认 5s 一次）即可；极端突发的告警延迟最多 5s，可接受。
   */
  observe(rows: EventRow[], groups: GroupStat[]): void {
    this.engine.observe(rows, groups);
  }

  /** 启动定时评估（幂等）；unref 避免后台定时器把进程留住 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // 用 void 明确表示「故意不 await」：单次评估失败不应中断定时器
      void this.runOnce();
    }, this.config.alertEvaluateIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 停止定时评估（不影响已产出的判定，只是不再自动触发） */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 评估 → 落库 → 推送，返回本次触发的预警。
   *
   * 执行顺序（顺序很关键）：
   *   1. engine.evaluate(now) 先算出全部判定（顺带写入冷却）；
   *   2. 逐条推送 + 落 alert_log（串行 await，避免同一时刻打出多条 webhook 触发 IM 限流）；
   *   3. 返回判定数组（定时器路径忽略返回值，测试/手动触发用得上）。
   *
   * 单飞保护：evaluating=true 期间再次进入直接返回 []（不是排队），
   * 因为「这一轮还没算完就又来一轮」说明上一轮的数据已经够新了，多跑一遍只会重复推送。
   *
   * @param now 可注入时间，单测用固定时间戳验证窗口/冷却
   */
  async runOnce(now: number = Date.now()): Promise<AlertDecision[]> {
    if (this.evaluating) return [];
    this.evaluating = true;
    try {
      const decisions = this.engine.evaluate(now);
      for (const decision of decisions) {
        const message = buildMessage(decision);
        let result: NotifyResult = { delivered: false, error: null };
        try {
          // Notifier 内部已带超时 + 一次重试；这里再兜一层，防止意外异常打断整轮推送
          result = await this.notifier.send(decision, message);
        } catch (error) {
          result = {
            delivered: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        // 无论推送成功与否都要留痕：这是排查「告警有没有发出去」的唯一依据
        this.persistLog(decision, message.text, result);
      }
      return decisions;
    } finally {
      // 必须放在 finally：任何异常都不能让 evaluating 卡在 true（否则预警永久停摆）
      this.evaluating = false;
    }
  }

  /**
   * 手动触发一次测试推送，用于验证 webhook 配置是否可用（POST /api/alerts/test?rule=xxx）。
   *
   * 规则选取优先级：query 指定的规则名 → 库里第一条规则 → 内置兜底规则（库里一条都没有时）。
   * 兜底规则的 value = threshold，保证文案看起来「确实越过了阈值」，
   * 但它不会经过 engine.evaluate，因此**不占用冷却**，也不会污染窗口统计。
   * 落库时 ruleName 会加「手动测试:」前缀，便于在 alert_log 里区分人工触发与真实告警。
   */
  async fireTest(ruleName?: string): Promise<{ message: string; result: NotifyResult }> {
    const rules = this.store.listAlertRules();
    const rule: AlertRuleRow = rules.find((item) => item.name === ruleName) ||
      rules[0] || {
        id: 0,
        name: '手动测试',
        scope: 'global',
        scopeValue: null,
        metric: 'count',
        threshold: 1,
        windowMs: 60 * 1000,
        cooldownMs: 0,
        enabled: 1,
        channels: '["console","webhook"]',
      };
    const decision: AlertDecision = {
      rule,
      groupKey: null,
      metric: rule.metric,
      value: rule.threshold,
      threshold: rule.threshold,
      windowMs: rule.windowMs,
      sample: null,
    };
    const message = buildMessage(decision);
    const result = await this.notifier.send(decision, message);
    this.persistLog(decision, message.text, result, '手动测试');
    return { message: `${message.title}\n${message.text}`, result };
  }

  /**
   * 写一条预警记录到 alert_log。
   *
   * 字段语义：
   * - ruleId    ：规则被删除时可能为 null（用 0 兜底转 null，避免外键/展示上的歧义）
   * - ruleName  ：人工触发会加「手动测试:」前缀
   * - payload   ：完整文案（就是推给 webhook 的正文），事后可直接复制重发
   * - delivered ：1 = 至少一个渠道（控制台/无 webhook 时恒为 1）；0 = webhook 推送失败
   * - error     ：失败原因（HTTP 状态码 / 超时 / 网络错误），成功为 null
   *
   * 落库失败只打日志、不抛错：alert_log 是辅助数据，不能反过来影响推送结果。
   */
  private persistLog(
    decision: AlertDecision,
    text: string,
    result: NotifyResult,
    prefix = '',
  ): void {
    const entry: AlertLogRow = {
      ruleId: decision.rule.id || null,
      ruleName: prefix ? `${prefix}:${decision.rule.name}` : decision.rule.name,
      groupKey: decision.groupKey,
      metric: decision.metric,
      value: decision.value,
      threshold: decision.threshold,
      windowMs: decision.windowMs,
      channels: decision.rule.channels,
      payload: text,
      delivered: result.delivered ? 1 : 0,
      error: result.error,
      createdAt: Date.now(),
    };
    try {
      this.store.logAlert(entry);
    } catch (error) {
      console.error('[alert] 预警记录落库失败：', error);
    }
  }
}
