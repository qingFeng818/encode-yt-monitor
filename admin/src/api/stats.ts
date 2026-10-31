import { request } from './http';
import type { ErrorGroup, ErrorSample, OverviewData, PvStatsData } from '@/types/monitor';

/**
 * 查询接口封装，路径与 examples/server/config.ts 的 ServerUrls 保持一致。
 */

/** 概览：错误数 / PV / UV / 错误率 + 写队列水位 */
export function fetchOverview(windowHours: number): Promise<OverviewData> {
  return request<OverviewData>('/api/stats/overview', { query: { windowHours } });
}

/** 错误分组：只返回 lastSeen 在窗口内的分组，按累计次数降序 */
export function fetchErrorGroups(params: {
  windowHours: number;
  limit: number;
}): Promise<ErrorGroup[]> {
  return request<ErrorGroup[]>('/api/stats/errors', { query: params });
}

/**
 * 单个错误分组的最近明细样本（展开行堆栈）。
 *
 * groupKey 含 `err_` / `fp_` 前缀，只有下划线与 hex，仍然统一编码，
 * 避免以后扩展成带特殊字符的指纹时破坏路径。
 */
export function fetchErrorSamples(groupKey: string, limit = 5): Promise<ErrorSample[]> {
  return request<ErrorSample[]>(`/api/stats/errors/${encodeURIComponent(groupKey)}/samples`, {
    query: { limit },
  });
}

/** PV/UV：日趋势（days 天）+ 路由排行（最近 24h） */
export function fetchPvStats(params: { days: number; limit: number }): Promise<PvStatsData> {
  return request<PvStatsData>('/api/stats/pv', { query: params });
}
