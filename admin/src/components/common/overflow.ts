import type { IconName } from '@/components/icons';

/**
 * 功能按钮栏的动作配置。
 *
 * 放在独立 .ts 里而不是 <script setup> 内部 export：
 * - `<script setup>` 不允许 ES module 导出（类型导出也可能被编译器拦下）；
 * - 页面需要 `OverflowAction[]` 的类型，独立文件可以直接 import type。
 */
export interface OverflowAction {
  key: string;
  label: string;
  icon?: IconName;
  tone?: 'default' | 'primary';
  /** 优先显示（排序在最前）；宽度不足时仍可能进「更多」，避免工具栏溢出 */
  pinned?: boolean;
  disabled?: boolean;
  title?: string;
}

/**
 * 计算功能栏能直接展示多少个按钮（纯函数，便于单测）。
 *
 * 约定：
 * - containerWidth 未知（Infinity / 0）时全部展示，避免首帧少按钮；
 * - 全部放得下时全部展示（不预留「更多」按钮）；
 * - 放不下时先给「更多」按钮留位置，再按顺序取前缀；
 * - 至少保留第一个动作，避免极端窄屏下「一个按钮都没有」。
 */
export function computeVisibleCount(params: {
  widths: number[];
  containerWidth: number;
  moreWidth: number;
  gap: number;
}): number {
  const { widths, containerWidth, moreWidth, gap } = params;
  const totalCount = widths.length;
  if (totalCount === 0) return 0;
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return totalCount;

  const fullWidth = widths.reduce((sum, width, index) => sum + width + (index > 0 ? gap : 0), 0);
  if (fullWidth <= containerWidth) return totalCount;

  const budget = containerWidth - moreWidth - gap;
  let used = 0;
  let count = 0;
  for (let index = 0; index < totalCount; index += 1) {
    const extra = widths[index] + (count > 0 ? gap : 0);
    if (count > 0 && used + extra > budget) break;
    used += extra;
    count += 1;
  }
  return count;
}
