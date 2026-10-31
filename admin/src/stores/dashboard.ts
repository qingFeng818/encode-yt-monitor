import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { fetchErrorGroups, fetchOverview, fetchPvStats } from '@/api/stats';
import type { ErrorGroup, ErrorTypeStat, OverviewData, PvStatsData } from '@/types/monitor';
import { aggregateErrorTypes } from '@/utils/aggregate';

/**
 * 看板数据仓库。
 *
 * 三个接口一次性并行拉取：
 * - /api/stats/overview?windowHours=   → 顶部指标卡 + 队列健康
 * - /api/stats/errors?windowHours=&limit= → 错误类型分布 + 错误分组表
 * - /api/stats/pv?days=&limit=          → PV/UV 趋势 + 路由排行
 *
 * 并发保护：连续切换时间窗口时，用自增序号丢弃过期响应，避免慢请求覆盖新数据。
 */

export interface WindowOption {
  label: string;
  hours: number;
}

export const WINDOW_OPTIONS: WindowOption[] = [
  { label: '1 小时', hours: 1 },
  { label: '6 小时', hours: 6 },
  { label: '24 小时', hours: 24 },
  { label: '7 天', hours: 24 * 7 },
  { label: '30 天', hours: 24 * 30 },
];

export const DAY_OPTIONS = [7, 14, 30] as const;

/** 错误分组表与饼图共用的条数（服务端上限 200，demo 取 20 足够） */
const ERROR_GROUP_LIMIT = 20;
/** 路由排行条数 */
const TOP_ROUTE_LIMIT = 10;

export const useDashboardStore = defineStore('dashboard', () => {
  const windowHours = ref(24);
  const days = ref<number>(7);

  const overview = ref<OverviewData | null>(null);
  const errorGroups = ref<ErrorGroup[]>([]);
  const pvStats = ref<PvStatsData | null>(null);

  /** 首次加载（还没有任何数据）时展示骨架 */
  const loading = ref(false);
  /** 任何一次请求进行中都为 true，用于刷新按钮的转圈状态 */
  const refreshing = ref(false);
  const error = ref('');
  const lastUpdated = ref<number | null>(null);

  let requestSeq = 0;

  async function load(): Promise<void> {
    const seq = ++requestSeq;
    loading.value = overview.value === null;
    refreshing.value = true;

    try {
      const [nextOverview, nextErrors, nextPv] = await Promise.all([
        fetchOverview(windowHours.value),
        fetchErrorGroups({ windowHours: windowHours.value, limit: ERROR_GROUP_LIMIT }),
        fetchPvStats({ days: days.value, limit: TOP_ROUTE_LIMIT }),
      ]);

      if (seq !== requestSeq) return;

      overview.value = nextOverview;
      errorGroups.value = nextErrors;
      pvStats.value = nextPv;
      lastUpdated.value = Date.now();
      error.value = '';
    } catch (reason) {
      if (seq !== requestSeq) return;
      error.value = reason instanceof Error ? reason.message : '数据加载失败';
    } finally {
      if (seq === requestSeq) {
        loading.value = false;
        refreshing.value = false;
      }
    }
  }

  function setWindowHours(hours: number): void {
    if (hours === windowHours.value) return;
    windowHours.value = hours;
    void load();
  }

  function setDays(nextDays: number): void {
    if (nextDays === days.value) return;
    days.value = nextDays;
    void load();
  }

  const daily = computed(() => pvStats.value?.daily ?? []);
  const topRoutes = computed(() => pvStats.value?.topRoutes ?? []);
  const errorTypes = computed<ErrorTypeStat[]>(() => aggregateErrorTypes(errorGroups.value));

  return {
    windowHours,
    days,
    overview,
    errorGroups,
    pvStats,
    loading,
    refreshing,
    error,
    lastUpdated,
    daily,
    topRoutes,
    errorTypes,
    load,
    setWindowHours,
    setDays,
  };
});
