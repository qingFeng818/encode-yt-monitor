<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fetchErrorSamples } from '@/api/stats';
import AppIcon from '@/components/AppIcon.vue';
import OverflowActions from '@/components/common/OverflowActions.vue';
import type { OverflowAction } from '@/components/common/overflow';
import ErrorFilterBar from '@/components/errors/ErrorFilterBar.vue';
import ErrorTable from '@/components/errors/ErrorTable.vue';
import type { FilterFieldConfig, FilterValues } from '@/components/errors/filterConfig';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_ORDER,
  DEFAULT_WINDOW_HOURS,
  ERROR_QUERY_LIMIT,
  SORT_OPTIONS,
  WINDOW_HOURS_OPTIONS,
  normalizePageSize,
  normalizeWindowHours,
  parseSortValue,
  toSortValue,
  useErrorListStore,
  type ErrorFilters,
  type ErrorSortKey,
} from '@/stores/errorList';
import { copyText } from '@/utils/clipboard';
import { downloadCsv, timestampForFilename } from '@/utils/csv';
import { formatClock, formatDateTime, formatNumber } from '@/utils/format';
import type { ErrorSample } from '@/types/monitor';

/**
 * 错误列表页。
 *
 * 页面结构（标准后台三段式）：
 * 1. 搜索栏：ErrorFilterBar，字段由配置驱动，宽度不足/高级项自动收进「更多筛选」；
 * 2. 功能栏：查询 / 重置 / 刷新 / 导出 / 复制链接 / 密度切换，超出宽度自动进「更多」；
 * 3. 展示栏：ErrorTable，支持排序、分页、列显隐、行展开详情、空态/骨架/错误态。
 *
 * 状态同步：
 * - 生效条件以 store 为准（搜索栏 + 表头排序 + URL 三处只读同一份）；
 * - 每次「查询 / 重置 / 翻页 / 改每页条数 / 表头排序」后把条件写回 URL query，
 *   刷新/分享能还原；搜索栏里未点「查询」的草稿不会写入 URL。
 *
 * 服务端限制：/api/stats/errors 只返回窗口内 TOP 200 分组，没有 offset / 关键词参数，
 * 所以筛选与分页都是「这 200 条内」的前端行为，页面上已显式标注。
 */

type Density = 'comfortable' | 'compact';

interface ToastState {
  id: number;
  text: string;
  tone: 'success' | 'warning';
}

const store = useErrorListStore();
const route = useRoute();
const router = useRouter();

const filterBarRef = ref<InstanceType<typeof ErrorFilterBar> | null>(null);
const density = ref<Density>('comfortable');
const expandedKey = ref<string | null>(null);

/** 展开行的最近错误样本（按 groupKey 懒加载，最多 5 条） */
const samples = ref<ErrorSample[]>([]);
const samplesLoading = ref(false);
const samplesError = ref('');
/** 请求序号：快速切换行 / 收起时丢弃旧响应，避免堆栈串行 */
let samplesSeq = 0;

const toast = ref<ToastState | null>(null);
let toastTimer: number | undefined;
let toastSeq = 0;
/** 组件卸载后不要再回写 URL（load 可能很慢，用户已经切走） */
let disposed = false;

function notify(text: string, tone: ToastState['tone'] = 'success'): void {
  toast.value = { id: ++toastSeq, text, tone };
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
    toastTimer = undefined;
  }, 2600);
}

onBeforeUnmount(() => {
  disposed = true;
  // 让未完成的堆栈请求失效，避免卸载后写响应式状态
  samplesSeq += 1;
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
});

function windowLabelOf(hours: number): string {
  if (hours >= 48 && hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

const windowLabel = computed(() => windowLabelOf(store.windowHours));

const typeOptions = computed(() => {
  const options = store.errorTypes.map((type) => ({
    label: type === 'UNKNOWN' ? 'UNKNOWN（无类型）' : type,
    value: type,
  }));
  // 刷新后已选项可能不再有数据：保留一项占位，避免下拉显示空白导致用户误判
  if (store.filters.errorType && !store.errorTypes.includes(store.filters.errorType)) {
    options.unshift({ label: `${store.filters.errorType}（已无数据）`, value: store.filters.errorType });
  }
  return [{ label: '全部类型', value: '' }, ...options];
});

/** 搜索栏配置：改字段只需要动这个数组，布局与折叠会自动适配 */
const fields = computed<FilterFieldConfig[]>(() => [
  {
    key: 'keyword',
    label: '关键词',
    type: 'search',
    width: 250,
    placeholder: '消息 / 名称 / 页面 / groupKey',
    title: '匹配错误消息、名称、来源页面、分组键，不区分大小写',
  },
  {
    key: 'errorType',
    label: '错误类型',
    type: 'select',
    width: 190,
    options: typeOptions.value,
  },
  {
    key: 'windowHours',
    label: '时间窗口',
    type: 'select',
    width: 150,
    options: WINDOW_HOURS_OPTIONS.map((hours) => ({ label: windowLabelOf(hours), value: String(hours) })),
    title: '服务端按 lastSeen 过滤：只返回该窗口内出现过的分组',
    // 有默认值，折叠到「更多筛选」时不应被当成「已填写条件」计入角标
    defaultValue: String(DEFAULT_WINDOW_HOURS),
  },
  {
    key: 'sort',
    label: '排序',
    type: 'select',
    width: 170,
    options: SORT_OPTIONS,
    title: '与表头点击排序共用同一份状态',
    defaultValue: toSortValue(DEFAULT_SORT_BY, DEFAULT_SORT_ORDER),
  },
  {
    key: 'newOnly',
    label: '是否新错误',
    type: 'select',
    width: 150,
    defaultValue: 'all',
    advanced: true,
    options: [
      { label: '全部', value: 'all' },
      { label: '只看新错误', value: 'new' },
    ],
  },
  {
    key: 'minCount',
    label: '最小累计次数',
    type: 'search',
    width: 160,
    advanced: true,
    placeholder: '例如 10',
  },
  {
    key: 'minUsers',
    label: '最小影响访客',
    type: 'search',
    width: 160,
    advanced: true,
    placeholder: '例如 3',
  },
  {
    key: 'route',
    label: '来源页面包含',
    type: 'search',
    width: 240,
    advanced: true,
    placeholder: '/checkout',
  },
]);

/** 已生效条件 → 搜索栏展示值（窗口/排序也走同一套表单值） */
const filterModel = computed<Record<string, string>>(() => ({
  keyword: store.filters.keyword,
  errorType: store.filters.errorType,
  windowHours: String(store.windowHours),
  sort: toSortValue(store.sortBy, store.sortOrder),
  newOnly: store.filters.newOnly ? 'new' : 'all',
  minCount: store.filters.minCount,
  minUsers: store.filters.minUsers,
  route: store.filters.route,
}));

const actions = computed<OverflowAction[]>(() => [
  { key: 'search', label: '查询', icon: 'search', tone: 'primary', pinned: true },
  { key: 'reset', label: '重置', icon: 'x', pinned: true },
  {
    key: 'refresh',
    label: '刷新',
    icon: 'refresh',
    pinned: true,
    disabled: store.refreshing,
    title: `重新拉取最近 ${windowLabel.value} 的 TOP ${ERROR_QUERY_LIMIT} 分组`,
  },
  { key: 'export', label: '导出 CSV', icon: 'download', title: '导出筛选后的全部分组（不受分页限制）' },
  { key: 'copy', label: '复制链接', icon: 'link', title: '复制带当前查询条件的页面地址' },
  {
    key: 'density',
    label: density.value === 'compact' ? '舒适密度' : '紧凑密度',
    icon: 'rows',
    title: '切换表格行高',
  },
]);
function handleSearch(values: FilterValues): void {
  const parsed = parseSortValue(values.sort || '');
  const filters: ErrorFilters = {
    keyword: values.keyword ?? '',
    errorType: values.errorType ?? '',
    newOnly: values.newOnly === 'new',
    minCount: values.minCount ?? '',
    minUsers: values.minUsers ?? '',
    route: values.route ?? '',
  };

  store.hydrate({
    windowHours: normalizeWindowHours(Number(values.windowHours)),
    filters,
    sortBy: parsed.sortBy,
    sortOrder: parsed.sortOrder,
    page: 1,
    pageSize: store.pageSize,
  });

  collapseRow();
  syncQuery();
  void store.load();
}

function handleReset(): void {
  store.resetQuery();
  collapseRow();
  syncQuery();
  void store.load();
}

function handleSort(key: ErrorSortKey): void {
  store.setSort(key);
  collapseRow();
  syncQuery();
}

function handlePageChange(page: number): void {
  store.setPage(page);
  collapseRow();
  syncQuery();
}

function handlePageSizeChange(size: number): void {
  store.setPageSize(size);
  collapseRow();
  syncQuery();
}

/** 收起详情并丢弃未完成的堆栈请求 */
function collapseRow(): void {
  expandedKey.value = null;
  samplesSeq += 1;
  samples.value = [];
  samplesLoading.value = false;
  samplesError.value = '';
}

/** 按需加载某个分组的最近堆栈；序号防止快速切换行时旧响应覆盖新行 */
async function loadSamples(key: string): Promise<void> {
  const seq = ++samplesSeq;
  samples.value = [];
  samplesError.value = '';
  samplesLoading.value = true;
  try {
    const list = await fetchErrorSamples(key, 5);
    if (disposed || seq !== samplesSeq) return;
    samples.value = list;
  } catch (reason) {
    if (disposed || seq !== samplesSeq) return;
    samplesError.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    if (!disposed && seq === samplesSeq) samplesLoading.value = false;
  }
}

function retrySamples(): void {
  if (expandedKey.value) void loadSamples(expandedKey.value);
}

function toggleRow(key: string): void {
  if (expandedKey.value === key) {
    collapseRow();
    return;
  }
  expandedKey.value = key;
  void loadSamples(key);
}

function exportCsv(): void {
  const rows = store.sortedGroups;
  if (rows.length === 0) {
    notify('没有可导出的数据，请先调整筛选条件', 'warning');
    return;
  }

  downloadCsv(`error-groups-${timestampForFilename()}.csv`, [
    ['错误类型', '名称', '消息', '来源页面', '累计次数', '影响访客', '首次出现', '最近出现', '分组键', '是否新错误'],
    ...rows.map((group) => [
      group.errorType || 'UNKNOWN',
      group.name ?? '',
      group.message ?? '',
      group.sampleUrl ?? '',
      group.totalCount,
      group.affectedUsers,
      formatDateTime(group.firstSeen),
      formatDateTime(group.lastSeen),
      group.groupKey,
      group.isNew ? '是' : '否',
    ]),
  ]);

  notify(`已导出 ${rows.length} 个分组（筛选后全部）`);
}

/** 只把非默认值写进 URL，地址栏保持干净；query 键名尽量短 */
function buildQuery(): Record<string, string> {
  const query: Record<string, string> = {};
  if (store.windowHours !== DEFAULT_WINDOW_HOURS) query.window = String(store.windowHours);
  if (store.filters.keyword) query.q = store.filters.keyword;
  if (store.filters.errorType) query.type = store.filters.errorType;
  if (store.filters.newOnly) query.newOnly = '1';
  if (store.filters.minCount) query.minCount = store.filters.minCount;
  if (store.filters.minUsers) query.minUsers = store.filters.minUsers;
  if (store.filters.route) query.route = store.filters.route;
  if (store.sortBy !== DEFAULT_SORT_BY || store.sortOrder !== DEFAULT_SORT_ORDER) {
    query.sort = toSortValue(store.sortBy, store.sortOrder);
  }
  if (store.page > 1) query.page = String(store.page);
  if (store.pageSize !== DEFAULT_PAGE_SIZE) query.size = String(store.pageSize);
  return query;
}

function syncQuery(): void {
  void router.replace({ query: buildQuery() });
}

/** 复制链接不依赖 router 是否已经完成 replace，直接按当前状态拼 URL */
function buildShareUrl(): string {
  const url = new URL(window.location.href);
  url.search = '';
  Object.entries(buildQuery()).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

async function copyShareLink(): Promise<void> {
  const ok = await copyText(buildShareUrl());
  notify(ok ? '查询链接已复制' : '复制失败，请手动复制地址栏链接', ok ? 'success' : 'warning');
}

function handleAction(key: string): void {
  switch (key) {
    case 'search':
      if (filterBarRef.value) filterBarRef.value.apply();
      else handleSearch(filterModel.value);
      break;
    case 'reset':
      if (filterBarRef.value) filterBarRef.value.reset();
      else handleReset();
      break;
    case 'refresh':
      collapseRow();
      void store.load();
      break;
    case 'export':
      exportCsv();
      break;
    case 'copy':
      void copyShareLink();
      break;
    case 'density':
      density.value = density.value === 'compact' ? 'comfortable' : 'compact';
      break;
    default:
      break;
  }
}

function readQueryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

onMounted(() => {
  const query = route.query;
  const parsed = parseSortValue(
    readQueryValue(query.sort) || toSortValue(DEFAULT_SORT_BY, DEFAULT_SORT_ORDER),
  );

  store.hydrate({
    windowHours: normalizeWindowHours(Number(readQueryValue(query.window))),
    filters: {
      keyword: readQueryValue(query.q),
      errorType: readQueryValue(query.type),
      newOnly: readQueryValue(query.newOnly) === '1',
      minCount: readQueryValue(query.minCount),
      minUsers: readQueryValue(query.minUsers),
      route: readQueryValue(query.route),
    },
    sortBy: parsed.sortBy,
    sortOrder: parsed.sortOrder,
    page: Math.max(1, Math.floor(Number(readQueryValue(query.page)) || 1)),
    pageSize: normalizePageSize(Number(readQueryValue(query.size))),
  });

  // page 可能超出本次数据的总页数（分享链接 / 数据被清理），store 在 load 完成后会夹取；
  // 这里把夹取后的页码写回 URL，避免地址栏停留在 page=9 而页面显示第 3 页。
  const requestedPage = store.page;
  void store.load().then(() => {
    if (!disposed && store.page !== requestedPage) syncQuery();
  });
});
</script>

<template>
  <div class="error-page">
    <section class="page-head">
      <div class="page-head-copy">
        <p class="eyebrow"><span class="pulse-dot" aria-hidden="true" /> Error Explorer</p>
        <h1>错误列表</h1>
        <p class="page-desc">
          按时间窗口检索错误分组，支持关键词、类型、新错误、最小次数与来源页面过滤；展开行可查看最近上报的
          堆栈（<code>JS 文件:行:列</code>）。数据来自 <code>/api/stats/errors</code>，服务端最多返回 TOP
          {{ ERROR_QUERY_LIMIT }} 组。
        </p>
        <p class="head-meta">
          <AppIcon name="clock" :size="14" />
          <span>更新于 {{ store.lastUpdated ? formatClock(store.lastUpdated) : '—' }}</span>
          <span class="meta-sep" aria-hidden="true">·</span>
          <span>窗口 {{ windowLabel }}</span>
          <span class="meta-sep" aria-hidden="true">·</span>
          <span>已加载 {{ formatNumber(store.groups.length) }} / {{ ERROR_QUERY_LIMIT }} 组</span>
        </p>
      </div>
    </section>

    <div v-if="store.error" class="error-banner" role="alert">
      <AppIcon name="warning" :size="18" />
      <div class="error-copy">
        <strong>数据加载失败</strong>
        <p>{{ store.error }}</p>
      </div>
      <button class="btn btn-sm" type="button" :disabled="store.refreshing" @click="store.load()">
        重试
      </button>
    </div>

    <ErrorFilterBar
      ref="filterBarRef"
      :fields="fields"
      :model-value="filterModel"
      :loading="store.loading"
      @search="handleSearch"
      @reset="handleReset"
    />

    <section class="toolbar" aria-label="功能栏">
      <div class="toolbar-summary">
        <span class="tag tag-info">命中 {{ formatNumber(store.summary.groups) }} 组</span>
        <span class="tag">累计 {{ formatNumber(store.summary.totalCount) }} 条</span>
        <span v-if="store.summary.newGroups > 0" class="tag tag-danger">
          新错误 {{ formatNumber(store.summary.newGroups) }}
        </span>
        <span v-if="store.hasFilters" class="tag tag-purple">
          影响人次 {{ formatNumber(store.summary.affectedUsers) }}
        </span>
        <span v-if="store.refreshing" class="refresh-hint">
          <AppIcon name="refresh" :size="13" class="is-spinning" />
          加载中
        </span>
      </div>

      <OverflowActions :actions="actions" @select="handleAction" />
    </section>

    <ErrorTable
      :groups="store.pagedGroups"
      :loading="store.loading"
      :density="density"
      :sort-by="store.sortBy"
      :sort-order="store.sortOrder"
      :page="store.page"
      :page-count="store.pageCount"
      :page-size="store.pageSize"
      :total="store.summary.groups"
      :has-filters="store.hasFilters"
      :expanded-key="expandedKey"
      :samples="samples"
      :samples-loading="samplesLoading"
      :samples-error="samplesError"
      @sort="handleSort"
      @toggle="toggleRow"
      @retry-samples="retrySamples"
      @page-change="handlePageChange"
      @page-size-change="handlePageSizeChange"
    />

    <p class="page-note">
      <AppIcon name="warning" :size="14" />
      <span>
        口径：累计次数 / 影响访客为分组历史累计，不是窗口内增量；筛选、排序与分页只作用于已加载的
        TOP {{ ERROR_QUERY_LIMIT }} 分组。
      </span>
    </p>

    <Transition name="toast">
      <div
        v-if="toast"
        :key="toast.id"
        class="toast"
        :class="`is-${toast.tone}`"
        role="status"
        aria-live="polite"
      >
        <AppIcon :name="toast.tone === 'success' ? 'check' : 'warning'" :size="16" />
        <span>{{ toast.text }}</span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.error-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.page-head-copy {
  min-width: 0;
}

.eyebrow {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 6px;
  color: var(--text-muted);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--success);
  animation: pulse 2.2s infinite;
}

@keyframes pulse {
  70% {
    box-shadow: 0 0 0 8px rgba(16, 185, 129, 0);
  }

  100% {
    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
  }
}

h1 {
  font-size: 26px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.page-desc {
  max-width: 760px;
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.page-desc code {
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface-2);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.head-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.meta-sep {
  opacity: 0.6;
}

.error-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 13px 16px;
  border: 1px solid var(--danger-soft);
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
}

.error-copy {
  flex: 1;
  min-width: 0;
}

.error-copy strong {
  display: block;
  font-size: 13px;
}

.error-copy p {
  margin-top: 2px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.error-banner .btn {
  flex: none;
  color: var(--danger);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.toolbar-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.refresh-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.page-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.55;
}

.page-note :deep(.app-icon) {
  flex: none;
  margin-top: 2px;
  color: var(--warning);
}

.toast {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(380px, calc(100vw - 32px));
  padding: 11px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--success);
  border-radius: var(--radius-sm);
  background: var(--surface);
  box-shadow: var(--shadow-md);
  color: var(--text-secondary);
  font-size: 12.5px;
}

.toast.is-warning {
  border-left-color: var(--warning);
}

.toast.is-success :deep(.app-icon) {
  color: var(--success);
}

.toast.is-warning :deep(.app-icon) {
  color: var(--warning);
}

.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 1000px) {
  .page-head {
    flex-direction: column;
  }
}

@media (max-width: 640px) {
  h1 {
    font-size: 22px;
  }

  .toolbar {
    align-items: stretch;
  }

  .toolbar-summary {
    width: 100%;
  }

  .toast {
    right: 16px;
    bottom: 16px;
    left: 16px;
    max-width: none;
  }
}
</style>
