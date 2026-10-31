/**
 * 展示层的格式化工具：保证 null / NaN / 非法时间都渲染成 '—'，不把 undefined 漏到界面上。
 */

const numberFormatter = new Intl.NumberFormat('zh-CN');
const pad = (value: number): string => String(value).padStart(2, '0');

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return numberFormatter.format(value);
}

/** ratio 是比值（0.0123 → 1.23%，1.4 → 140%） */
export function formatPercent(ratio: number | null | undefined, fractionDigits = 2): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
}

export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatClock(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 相对时间：刚刚 / x 秒前 / x 分钟前 / x 小时前 / 日期 */
export function formatRelativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  if (!timestamp) return '—';
  const diff = now - timestamp;
  if (Number.isNaN(diff)) return '—';
  if (diff < 0) return '刚刚';
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(timestamp).slice(0, 10);
}

/** '2026-10-30' → '10-30'，用于折线图 X 轴 */
export function formatDayLabel(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

/** 路由太长时在图表轴 / 表格里截断，完整值放到 title 里 */
export function truncate(text: string | null | undefined, max = 48): string {
  if (!text) return '—';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
