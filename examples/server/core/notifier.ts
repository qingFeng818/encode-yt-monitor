import { WebhookFormat } from '../config';
import { AlertDecision } from './alert';

/**
 * ============================================================================
 * 预警推送器：控制台 + 三方 webhook
 * ============================================================================
 *
 * 两个通道：
 * - console：**永远打印**（console.warn），本地 demo 的默认通道，也是「没有 webhook 时」的兜底；
 * - webhook：配置 ALERT_WEBHOOK_URL 后启用，按 ALERT_WEBHOOK_FORMAT 组装报文：
 *     raw      → 本项目自定义结构（含 rule/value/threshold/groupKey/firedAt），自建网关用；
 *     feishu   → {"msg_type":"text","content":{"text":"..."}}（飞书群机器人）
 *     dingtalk → {"msgtype":"markdown","markdown":{"title","text"}}（钉钉群机器人）
 *     wecom    → {"msgtype":"markdown","markdown":{"content"}}（企业微信群机器人）
 *
 * 可靠性语义（刻意做得保守，绝不影响采集主流程）：
 * - 每次请求 3s 超时（AbortController），超时即算失败；
 * - 只重试 1 次（总共最多 2 次请求）：IM 侧多半是限流 / 配置错误，重试多了没意义还会雪崩；
 * - 「成功」的判定是 response.ok（2xx）；飞书/钉钉即使 HTTP 200 也可能在 body 里报错
 *   （例如 errcode != 0），本 demo 不解析业务 code，需要更严格的话在这里加。
 *
 * 返回的 NotifyResult 会原样写进 alert_log.delivered / alert_log.error。
 */

/** 组装好的通用文案（与渠道无关） */
export interface AlertMessage {
  /** 标题行，例如「[监控预警] JS错误-1分钟」 */
  title: string;
  /** 正文（多行纯文本），三方渠道只是把它换行/加 markdown 语法 */
  text: string;
}

/** 推送结果：delivered=false 时 error 一定有值，便于在 alert_log 里定位 */
export interface NotifyResult {
  delivered: boolean;
  error: string | null;
}

export interface NotifierOptions {
  /** 未配置时只打控制台，不算失败（delivered 仍为 true） */
  webhookUrl: string | undefined;
  format: WebhookFormat;
  timeoutMs: number;
}

/** 把毫秒窗口转成人读的时间描述（「3 小时」/「5 分钟」/「30 秒」），用于文案 */
function formatDuration(windowMs: number): string {
  if (windowMs >= 60 * 60 * 1000) return `${Math.round(windowMs / (60 * 60 * 1000))} 小时`;
  if (windowMs >= 60 * 1000) return `${Math.round(windowMs / (60 * 1000))} 分钟`;
  return `${Math.round(windowMs / 1000)} 秒`;
}

/**
 * 组装告警文案（同时用于控制台与三方 webhook）。
 *
 * 第一行永远是「规则名 + 作用域 + 指标值（阈值阈值 / 窗口）」，
 * 分组规则再追加错误明细（类型 / 信息 / 首次出现 / 累计次数 / 影响用户）。
 *
 * scopeText 的优先级：有 groupKey 或 sample → 用分组名；否则按 scope 描述，
 * 这样「单分组告警」能直接看到是哪个错误，「全局/类型告警」看窗口维度。
 */
export function buildMessage(decision: AlertDecision): AlertMessage {
  const { rule, sample } = decision;
  const scopeText =
    decision.groupKey || sample
      ? `分组：${(sample && sample.name) || decision.groupKey}`
      : rule.scope === 'error_type'
        ? `错误类型：${rule.scopeValue || '全部'}`
        : '全局';
  // 指标文案：三种 metric 的单位不同，必须分开表述，否则「50」到底是条数还是人数说不清
  const metricText =
    decision.metric === 'users'
      ? `影响用户数 ${decision.value}`
      : decision.metric === 'new_group'
        ? `新增错误分组 ${decision.value} 个`
        : `错误条数 ${decision.value}`;
  const detail = sample
    ? `\n错误类型：${sample.errorType || '-'}\n错误信息：${sample.message || '-'}\n首次出现：${new Date(
        sample.firstSeen,
      ).toLocaleString()}\n累计次数：${sample.totalCount}\n影响用户：${sample.affectedUsers}`
    : '';

  return {
    title: `[监控预警] ${rule.name}`,
    text: `规则：${rule.name}\n${scopeText}\n${metricText}（阈值 ${decision.threshold} / ${formatDuration(
      decision.windowMs,
    )}）${detail}`,
  };
}

/**
 * 把通用文案转换成三方机器人要求的报文格式。
 *
 * 各渠道的差异点（改结构时注意别破坏）：
 * - 飞书：msg_type 是下划线风格，正文在 content.text；
 * - 钉钉：markdown 用 title + text，标题建议用 ### 包一层才显示得大；
 * - 企微：markdown 只有 content 一个字段，且换行要写成 "> " 引用形式才好看；
 * - raw：保留结构化字段，方便自建网关二次分发（firedAt 用 ISO 字符串，便于日志检索）。
 */
function buildBody(format: WebhookFormat, message: AlertMessage, decision: AlertDecision): unknown {
  if (format === 'feishu') {
    return { msg_type: 'text', content: { text: `${message.title}\n${message.text}` } };
  }
  if (format === 'dingtalk') {
    return {
      msgtype: 'markdown',
      markdown: { title: message.title, text: `### ${message.title}\n\n${message.text}` },
    };
  }
  if (format === 'wecom') {
    return {
      msgtype: 'markdown',
      markdown: { content: `### ${message.title}\n${message.text.replace(/\n/g, '\n> ')}` },
    };
  }
  return {
    title: message.title,
    text: message.text,
    rule: { id: decision.rule.id, name: decision.rule.name, metric: decision.metric },
    value: decision.value,
    threshold: decision.threshold,
    groupKey: decision.groupKey,
    firedAt: new Date().toISOString(),
  };
}

/**
 * 预警推送器。
 *
 * 渠道：
 * - console：永远打印，本地 demo 的默认通道；
 * - webhook：配置 ALERT_WEBHOOK_URL 后启用，支持 raw / 飞书 / 钉钉 / 企业微信；
 * 推送失败只影响「送达标记」，绝不影响采集主流程（超时 3s + 单次重试）。
 */
export class Notifier {
  constructor(private options: NotifierOptions) {}

  /** 是否配置了 webhook（/healthz 用它显示 alertWebhook=disabled） */
  get hasWebhook(): boolean {
    return typeof this.options.webhookUrl === 'string' && this.options.webhookUrl.length > 0;
  }

  /**
   * 发送一条预警。
   *
   * @param decision 命中详情（raw 格式需要结构化字段，三方格式只需要 message）
   * @param message  已组装好的文案
   * @returns delivered=true 表示「控制台已打印且（若配置了 webhook）webhook 返回 2xx」；
   *          没有配置 webhook 时也返回 delivered=true —— 因为「配置为只打控制台」是预期行为，不是失败。
   *
   * 每次请求都新建 AbortController + 独立定时器（不能复用，abort 是一次性的），
   * 并在 finally 里 clearTimeout，避免「响应很快但定时器还挂着」造成的句柄泄漏。
   */
  async send(decision: AlertDecision, message: AlertMessage): Promise<NotifyResult> {
    // 控制台通道：无论是否配置 webhook 都打，本地调试最直观
    console.warn(`\n${message.title}\n${message.text}\n`);
    if (!this.hasWebhook) return { delivered: true, error: null };

    // 用 globalThis.fetch 而不是 import：Node 18+ 内置，老版本要提示而不是崩
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== 'function') {
      return { delivered: false, error: '当前 Node 不支持 fetch，无法推送 webhook' };
    }

    const body = buildBody(this.options.format, message, decision);
    let lastError = '';

    // 最多 2 次尝试（首次 + 1 次重试）；最后一次的错误信息作为返回值
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await fetchFn(this.options.webhookUrl as string, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          clearTimeout(timer);
          return { delivered: true, error: null };
        }
        // 非 2xx：记录状态码后重试（4xx 多半是地址/密钥错，重试仍会失败，但成本很低）
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        // 超时（AbortError）/ DNS / 连接被拒都走这里
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
    }
    return { delivered: false, error: lastError || 'unknown' };
  }
}
