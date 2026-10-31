import type { IconName } from '@/components/icons';

/**
 * 搜索栏字段配置。
 *
 * 设计要点：
 * - 字段宽度由 `width` 显式声明，折叠计算就是「容器宽度 / 字段宽度」的整数运算，
 *   不依赖 canvas 估算文本宽度（原因见 composables/useElementWidth.ts 的注释）；
 * - `advanced: true` 的字段永远放进「更多筛选」，与宽度无关；
 * - 非 advanced 字段在窗口变窄时自动收进「更多筛选」，窗口变宽时自动回到第一行。
 */
export interface FilterFieldOption {
  label: string;
  value: string;
}

export interface FilterFieldConfig {
  key: string;
  label: string;
  /** search = 文本输入（回车触发查询）；select = 下拉 */
  type: 'search' | 'select';
  placeholder?: string;
  options?: FilterFieldOption[];
  /** 设计宽度（px），默认 220；只影响布局，不限制输入内容长度 */
  width?: number;
  /** 高级项：默认收起 */
  advanced?: boolean;
  /** 未填写时使用的值（例如「全部」= all），用于「更多筛选」角标判断 */
  defaultValue?: string;
  icon?: IconName;
  title?: string;
}

/** 搜索栏的表单值：键与 FilterFieldConfig.key 对应，统一用字符串，便于 URL query 往返 */
export type FilterValues = Record<string, string>;
