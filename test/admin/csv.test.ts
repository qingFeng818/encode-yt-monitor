import { describe, expect, it } from 'vitest';
import { timestampForFilename, toCsv } from '../../admin/src/utils/csv';

/**
 * 错误列表页的 CSV 导出工具。
 *
 * 这两类问题在后台导出里最容易出事：
 * 1. 消息里带逗号/引号/换行 → 必须按 RFC 4180 转义，否则列会错位；
 * 2. 单元格以 = + - @ 开头 → Excel 会当公式执行，必须前置单引号（CSV 注入）。
 */
describe('admin csv exporter', () => {
  it('转义逗号、引号与换行', () => {
    expect(toCsv([['a,b', 'c"d'], ['line1\nline2', '']])).toBe('"a,b","c""d"\r\n"line1\nline2",');
  });

  it('对公式注入加前缀，但数字保持原样', () => {
    expect(toCsv([['=1+1', '+cmd', '-5', '@x', -5], [0, null, undefined, '', 12]])).toBe(
      "'=1+1,'+cmd,'-5,'@x,-5\r\n0,,,,12",
    );
  });

  it('空输入返回空字符串，文件名按本地时间格式化', () => {
    expect(toCsv([])).toBe('');
    expect(timestampForFilename(new Date(2026, 9, 30, 1, 2, 3))).toBe('20261030-010203');
  });
});
