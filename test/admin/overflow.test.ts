import { describe, expect, it } from 'vitest';
import { computeVisibleCount } from '../../admin/src/components/common/overflow';

/**
 * 功能栏折叠计算。
 *
 * 这里测的是「纯数学」部分：按钮宽度由隐藏探针实测后传进来，
 * 所以只要能保证：
 * 1. 全部放得下时不要无谓地折叠；
 * 2. 放不下时为「更多」按钮预留宽度，并且按顺序取前缀；
 * 3. 极窄屏至少保留一个动作（否则页面上只剩「更多」）。
 */
describe('overflow actions width budget', () => {
  const base = { moreWidth: 100, gap: 8 };

  it('没有动作时返回 0', () => {
    expect(computeVisibleCount({ ...base, widths: [], containerWidth: 300 })).toBe(0);
  });

  it('宽度未知时先全部展示，避免首帧少按钮', () => {
    const widths = [70, 75, 80];
    expect(computeVisibleCount({ ...base, widths, containerWidth: Number.POSITIVE_INFINITY })).toBe(3);
    expect(computeVisibleCount({ ...base, widths, containerWidth: 0 })).toBe(3);
  });

  it('全部放得下时不预留「更多」按钮', () => {
    // 70 + 8 + 75 + 8 + 80 = 241 <= 300
    expect(computeVisibleCount({ ...base, widths: [70, 75, 80], containerWidth: 300 })).toBe(3);
  });

  it('放不下时为「更多」预留宽度，并按顺序取前缀', () => {
    // 全部 256 > 250，预算 250 - 100 - 8 = 142：
    // 第 1 个 80 放得下，第 2 个需要 80 + 8 = 88，累计 168 > 142，因此只展示 1 个。
    expect(computeVisibleCount({ ...base, widths: [80, 80, 80], containerWidth: 250 })).toBe(1);
  });

  it('极窄屏至少保留第一个动作', () => {
    expect(computeVisibleCount({ ...base, widths: [200], containerWidth: 100 })).toBe(1);
  });

  it('能放下两个动作时优先多展示，而不是直接全部收进「更多」', () => {
    // 全部 329 > 300，预算 192：70 + (8+75)=153 放得下，再加 88 会到 241，因此展示 2 个。
    expect(computeVisibleCount({ ...base, widths: [70, 75, 80, 80], containerWidth: 300 })).toBe(2);
  });
});
