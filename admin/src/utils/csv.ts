/**
 * CSV 导出（零依赖）。
 *
 * 两个容易踩的点：
 * 1. Excel 打开 UTF-8 CSV 会按本地编码猜，中文会乱码 → 写入 BOM（\uFEFF）；
 * 2. 以 = + - @ 开头的单元格会被 Excel 当公式执行 → 前置单引号，避免 CSV 注入。
 */

export type CsvCell = string | number | null | undefined;
export type CsvRow = CsvCell[];

/** 公式注入防护：只对字符串做处理，数字保持原样（负数要能正常参与计算） */
function sanitizeCell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function escapeCell(value: CsvCell): string {
  const text = sanitizeCell(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: CsvRow[]): string {
  // CRLF 是 Excel 最稳的换行；行尾不额外加空行，避免出现「幽灵行」
  return rows.map((row) => row.map(escapeCell).join(',')).join('\r\n');
}

/** 生成 20261030-142530 形式的文件名后缀（本地时区，便于人工对账） */
export function timestampForFilename(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 触发浏览器下载。
 *
 * 用 a[download] + Blob URL：不依赖后端导出接口，纯前端生成；
 * URL 在点击后异步回收，避免 Safari 还没开始读就被 revoke。
 */
export function downloadCsv(filename: string, rows: CsvRow[]): void {
  const blob = new Blob([`\uFEFF${toCsv(rows)}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
