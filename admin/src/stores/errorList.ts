import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { fetchErrorGroups } from '@/api/stats';
import type { ErrorGroup } from '@/types/monitor';

/**
 * ============================================================================
 * 错误列表页数据仓库
 * ============================================================================
 *
 * 服务端 /api/stats/errors 只支持 `limit`（上限 200）与 `windowHours`，
 * 没有 offset / 关键词 / 类型参数，因此：
 * - 网络请求只负责「取回窗口内的 TOP 200 分组」；
 * - 关键词、类型、新错误、最小次数等筛选与排序、分页全部在**前端**完成；
 * - UI 上必须明确写出「在 TOP N 内检索」，否则用户会误以为筛的是全量历史。
 *
 * 如果以后要做服务端分页/检索，优先在 examples/server 增加查询参数（并在
 * db/types.ts 的 Store 接口上扩展），而不是把 limit 调得更大。
 */

/** 服务端强制的条数上限（routes/stats.ts: readNumber limit max=200） */
export const ERROR_QUERY_LIMIT = 200;

/** 与服务端 windowHours 取值范围（1~720）对齐的常用窗口 */
export const WINDOW_HOURS_OPTIONS = [1, 6, 24, 24 * 7, 24 * 30] as const;

export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export type ErrorSortKey = 'totalCount' | 'affectedUsers' | 'firstSeen' | 'lastSeen';
export type SortOrder = 'asc' | 'desc';

export const SORT_KEYS: ErrorSortKey[] = ['totalCount', 'affectedUsers', 'firstSeen', 'lastSeen'];
export const DEFAULT_SORT_BY: ErrorSortKey = 'totalCount';
export const DEFAULT_SORT_ORDER: SortOrder = 'desc';
export const DEFAULT_PAGE_SIZE: PageSize = 10;
export const DEFAULT_WINDOW_HOURS = 24;

/** 搜索栏「排序」下拉的取值（key:order），与表头点击排序共用一份状态 */
export const SORT_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '累计次数 ↓', value: 'totalCount:desc' },
  { label: '累计次数 ↑', value: 'totalCount:asc' },
  { label: '影响访客 ↓', value: 'affectedUsers:desc' },
  { label: '影响访客 ↑', value: 'affectedUsers:asc' },
  { label: '最近出现 ↓', value: 'lastSeen:desc' },
  { label: '最近出现 ↑', value: 'lastSeen:asc' },
  { label: '首次出现 ↓', value: 'firstSeen:desc' },
  { label: '首次出现 ↑', value: 'firstSeen:asc' },
];

export interface ErrorFilters {
  /** 匹配 message / name / groupKey / sampleUrl / errorType（不区分大小写） */
  keyword: string;
  /** '' 表示全部；UNKNOWN 表示 errorType 为空的分组 */
  errorType: string;
  /** 只看 isNew=true 的分组 */
  newOnly: boolean;
  /** 输入框原文，空串表示不限；非法数字按「不限」处理 */
  minCount: string;
  minUsers: string;
  /** 匹配 sampleUrl（来源页面） */
  route: string;
}

export const DEFAULT_FILTERS: ErrorFilters = {
  keyword: '',
  errorType: '',
  newOnly: false,
  minCount: '',
  minUsers: '',
  route: '',
};

export interface ErrorQueryState {
  windowHours: number;
  filters: ErrorFilters;
  sortBy: ErrorSortKey;
  sortOrder: SortOrder;
  page: number;
  pageSize: number;
}

/** 把输入框里的字符串转成正整数；0 / 负数 / 非数字都视为「不限制」 */
function toPositiveInt(raw: string): number | null {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function normalizeWindowHours(value: number): number {
  return (WINDOW_HOURS_OPTIONS as readonly number[]).includes(value) ? value : DEFAULT_WINDOW_HOURS;
}

export function parseSortValue(value: string): { sortBy: ErrorSortKey; sortOrder: SortOrder } {
  const [rawKey, rawOrder] = value.split(':');
  const sortBy = (SORT_KEYS as string[]).includes(rawKey) ? (rawKey as ErrorSortKey) : DEFAULT_SORT_BY;
  const sortOrder: SortOrder = rawOrder === 'asc' ? 'asc' : 'desc';
  return { sortBy, sortOrder };
}

export function toSortValue(sortBy: ErrorSortKey, sortOrder: SortOrder): string {
  return `${sortBy}:${sortOrder}`;
}

export function normalizePageSize(value: number): PageSize {
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value) ? (value as PageSize) : DEFAULT_PAGE_SIZE;
}

export const useErrorListStore = defineStore('errorList', () => {
  const windowHours = ref<number>(DEFAULT_WINDOW_HOURS);
  const filters = reactive<ErrorFilters>({ ...DEFAULT_FILTERS });
  const sortBy = ref<ErrorSortKey>(DEFAULT_SORT_BY);
  const sortOrder = ref<SortOrder>(DEFAULT_SORT_ORDER);
  const page = ref(1);
  const pageSize = ref<PageSize>(DEFAULT_PAGE_SIZE);

  const groups = ref<ErrorGroup[]>([]);
  /** 首次加载（还没有任何数据）时显示骨架 */
  const loading = ref(false);
  /** 任何请求进行中都为 true（刷新按钮转圈 / 禁用重复点击） */
  const refreshing = ref(false);
  const error = ref('');
  const lastUpdated = ref<number | null>(null);

  let requestSeq = 0;

  async function load(): Promise<void> {
    const seq = ++requestSeq;
    loading.value = groups.value.length === 0;
    refreshing.value = true;

    try {
      const next = await fetchErrorGroups({
        windowHours: windowHours.value,
        limit: ERROR_QUERY_LIMIT,
      });
      if (seq !== requestSeq) return;

      groups.value = next;
      lastUpdated.value = Date.now();
      error.value = '';
    } catch (reason) {
      if (seq !== requestSeq) return;
      error.value = reason instanceof Error ? reason.message : '数据加载失败';
    } finally {
      if (seq === requestSeq) {
        loading.value = false;
        refreshing.value = false;
        // 分享链接里的 page 可能超出本次数据（或旧数据）的总页数：统一在这里夹取，
        // 避免 hydrate 阶段因为「数据还没到」把 page=3 吞成 1。
        if (page.value > pageCount.value) page.value = pageCount.value;
      }
    }
  }

  /** 时间窗口变化需要重新请求（服务端按 lastSeen 过滤） */
  function setWindowHours(hours: number): void {
    const next = normalizeWindowHours(hours);
    if (next === windowHours.value) return;
    windowHours.value = next;
    page.value = 1;
    void load();
  }

  function applyFilters(next: ErrorFilters): void {
    Object.assign(filters, next);
    page.value = 1;
  }

  function resetFilters(): void {
    Object.assign(filters, DEFAULT_FILTERS);
    page.value = 1;
  }

  /** 重置整页查询条件（含窗口 / 排序 / 每页条数），不改已加载的数据，由调用方决定是否重新请求 */
  function resetQuery(): void {
    windowHours.value = DEFAULT_WINDOW_HOURS;
    Object.assign(filters, DEFAULT_FILTERS);
    sortBy.value = DEFAULT_SORT_BY;
    sortOrder.value = DEFAULT_SORT_ORDER;
    page.value = 1;
    pageSize.value = DEFAULT_PAGE_SIZE;
  }

  /** 从 URL query 恢复状态（恢复时不发请求，避免和 onMounted 里的 load 重复） */
  function hydrate(state: Partial<ErrorQueryState>): void {
    if (state.windowHours !== undefined) windowHours.value = normalizeWindowHours(state.windowHours);
    if (state.filters) Object.assign(filters, { ...DEFAULT_FILTERS, ...state.filters });
    if (state.sortBy) sortBy.value = state.sortBy;
    if (state.sortOrder) sortOrder.value = state.sortOrder;
    if (state.pageSize !== undefined) pageSize.value = normalizePageSize(state.pageSize);
    page.value = Math.max(1, Math.floor(state.page ?? 1));
    // 这里不夹取页码：恢复时数据可能还是上一次的（或还没加载），
    // 等 load() 完成后按本次数据的总页数统一夹取。
  }

  function setSort(key: ErrorSortKey): void {
    if (sortBy.value === key) {
      sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc';
    } else {
      sortBy.value = key;
      // 数值/时间默认降序：先看「最多/最近」通常更有用；升序由再次点击切换
      sortOrder.value = 'desc';
    }
    page.value = 1;
  }

  function setSortValue(value: string): void {
    const parsed = parseSortValue(value);
    if (parsed.sortBy === sortBy.value && parsed.sortOrder === sortOrder.value) return;
    sortBy.value = parsed.sortBy;
    sortOrder.value = parsed.sortOrder;
    page.value = 1;
  }

  function setPage(next: number): void {
    page.value = Math.max(1, Math.floor(next));
  }

  function setPageSize(next: number): void {
    const size = normalizePageSize(next);
    if (size === pageSize.value) return;
    pageSize.value = size;
    page.value = 1;
  }

  /** 下拉里可选的错误类型（从当前已加载的分组里提取，UNKNOWN 归并空值） */
  const errorTypes = computed<string[]>(() => {
    const types = new Set<string>();
    groups.value.forEach((group) => types.add(group.errorType || 'UNKNOWN'));
    return Array.from(types).sort((a, b) => a.localeCompare(b));
  });

  const filteredGroups = computed<ErrorGroup[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase();
    const route = filters.route.trim().toLowerCase();
    const minCount = toPositiveInt(filters.minCount);
    const minUsers = toPositiveInt(filters.minUsers);

    return groups.value.filter((group) => {
      if (filters.errorType && (group.errorType || 'UNKNOWN') !== filters.errorType) return false;
      if (filters.newOnly && !group.isNew) return false;
      if (minCount !== null && group.totalCount < minCount) return false;
      if (minUsers !== null && group.affectedUsers < minUsers) return false;
      if (route && !(group.sampleUrl || '').toLowerCase().includes(route)) return false;

      if (keyword) {
        const haystack = [group.message, group.name, group.groupKey, group.sampleUrl, group.errorType]
          .filter((part): part is string => Boolean(part))
          .join('\n')
          .toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }

      return true;
    });
  });

  const sortedGroups = computed<ErrorGroup[]>(() => {
    const direction = sortOrder.value === 'asc' ? 1 : -1;

    return [...filteredGroups.value].sort((a, b) => {
      const left = a[sortBy.value];
      const right = b[sortBy.value];
      if (left !== right) return (left - right) * direction;
      // 同值时按最近出现兜底，保证分页顺序稳定（避免翻页时行位置跳动）
      return b.lastSeen - a.lastSeen;
    });
  });

  const pageCount = computed(() => Math.max(1, Math.ceil(sortedGroups.value.length / pageSize.value)));

  const pagedGroups = computed<ErrorGroup[]>(() => {
    const start = (page.value - 1) * pageSize.value;
    return sortedGroups.value.slice(start, start + pageSize.value);
  });

  const summary = computed(() => {
    let totalCount = 0;
    let affectedUsers = 0;
    filteredGroups.value.forEach((group) => {
      totalCount += group.totalCount;
      affectedUsers += group.affectedUsers;
    });
    return {
      /** 筛选后命中的分组数 */
      groups: filteredGroups.value.length,
      /** 筛选后分组的累计错误条数（分组历史累计） */
      totalCount,
      /** 各分组 affectedUsers 相加，跨分组可能重复，按「影响人次」理解 */
      affectedUsers,
      newGroups: filteredGroups.value.filter((group) => group.isNew).length,
    };
  });

  /** 搜索栏里「筛选类」条件数量（不含窗口与排序），用于「更多筛选」角标 */
  const activeFilterCount = computed(
    () =>
      [
        filters.keyword.trim(),
        filters.errorType,
        filters.newOnly ? 'new' : '',
        filters.minCount.trim(),
        filters.minUsers.trim(),
        filters.route.trim(),
      ].filter(Boolean).length,
  );

  const hasFilters = computed(() => activeFilterCount.value > 0);

  return {
    windowHours,
    filters,
    sortBy,
    sortOrder,
    page,
    pageSize,
    groups,
    loading,
    refreshing,
    error,
    lastUpdated,
    errorTypes,
    filteredGroups,
    sortedGroups,
    pagedGroups,
    pageCount,
    summary,
    activeFilterCount,
    hasFilters,
    load,
    setWindowHours,
    applyFilters,
    resetFilters,
    resetQuery,
    hydrate,
    setSort,
    setSortValue,
    setPage,
    setPageSize,
  };
});
