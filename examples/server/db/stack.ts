/**
 * 错误堆栈的落库格式。
 *
 * SDK 的 `ReportDataType.stack` 是**结构化帧数组**（extractErrorStack 的产物），
 * 不是原始堆栈字符串。早期 normalize 直接对数组调用 toText，数组被判为「不可转换」
 * 后写入 null，结果 events.stack 一直是空的，后台无法定位错误位置。
 *
 * 这里统一把 stack 序列化成 JSON 字符串：
 * - 数组：逐帧序列化，超过 max 时**按整帧截断**，保证结果仍是合法 JSON；
 * - 字符串：原样保留（兼容手工上报 / 旧 SDK 的原始堆栈），超长按字符截断；
 * - 其它对象：JSON.stringify；无法序列化时返回 null。
 *
 * `payload` 里保存的是整条上报 JSON，旧数据的 stack 仍可从 payload.stack 回填，
 * 因此「修复后只能看新数据」并不是硬限制（见 stackFromPayload）。
 */

const MAX_STACK = 8000;

/** 截断字符串，保留前 max 个字符并追加省略号 */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** JSON 序列化失败（循环引用 / BigInt）时返回 null，不把监控链路打挂 */
function safeStringify(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    return text && text !== 'null' ? text : null;
  } catch (error) {
    return null;
  }
}

/**
 * 把上报的 stack 转成可落库的文本。
 *
 * @param value SDK 上报的 stack（通常是帧数组，也可能是原始字符串）
 * @param max 最大字符数，默认 8000（与 schema 的注释一致）
 */
export function stackToText(value: unknown, max = MAX_STACK): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    return truncate(text, max);
  }

  if (Array.isArray(value)) {
    const frames: unknown[] = [];
    for (const frame of value) {
      // 按整帧追加，避免 JSON.stringify 后再 slice 把 JSON 截成非法格式。
      const next = [...frames, frame];
      const text = safeStringify(next);
      if (!text) continue;
      if (text.length > max) break;
      frames.push(frame);
    }
    return frames.length ? safeStringify(frames) : null;
  }

  if (typeof value === 'object') {
    const text = safeStringify(value);
    return text ? truncate(text, max) : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return truncate(String(value), max);
  }

  return null;
}

/**
 * 从 events.payload（整条上报 JSON）里回填 stack。
 *
 * 用途：修复前入库的历史事件 stack 为 null，但 payload 仍然保留了原始上报内容，
 * 展开详情时可以直接从 payload 解析，不需要重放数据。
 */
export function stackFromPayload(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return stackToText((parsed as Record<string, unknown>).stack);
    }
  } catch (error) {
    // payload 可能被 MAX_PAYLOAD 截断成非法 JSON，按没有堆栈处理
  }
  return null;
}
