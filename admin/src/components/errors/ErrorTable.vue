<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import ErrorStackTrace from '@/components/errors/ErrorStackTrace.vue';
import type { PageSize, ErrorSortKey, SortOrder } from '@/stores/errorList';
import { PAGE_SIZE_OPTIONS } from '@/stores/errorList';
import type { ErrorGroup, ErrorSample } from '@/types/monitor';
import { formatDateTime, formatNumber, formatRelativeTime, truncate } from '@/utils/format';

/**
 * 错误分组表（页面第三栏：展示栏）。
 *
 * 只做展示与交互，不请求数据：
 * 数据、筛选、排序、分页状态都在 stores/errorList.ts，页面负责把 props 接进来，
 * 这样表头排序、搜索栏下拉、URL query 三者不会各存一份「当前排序」。
 */

interface ColumnDef {
  key: string;
  label: string;
  /** 右对齐 + 等宽数字 */
  numeric?: boolean;
  /** 可点击排序时对应的 store 字段 */
  sortKey?: ErrorSortKey;
}

const COLUMNS: ColumnDef[] = [
  { key: 'type', label: '错误类型' },
  { key: 'error', label: '名称 / 消息' },
  { key: 'source', label: '来源页面' },
  { key: 'count', label: '累计次数', numeric: true, sortKey: 'totalCount' },
  { key: 'users', label: '影响访客', numeric: true, sortKey: 'affectedUsers' },
  { key: 'firstSeen', label: '首次出现', sortKey: 'firstSeen' },
  { key: 'lastSeen', label: '最近出现', sortKey: 'lastSeen' },
];

const props = defineProps<{
  groups: ErrorGroup[];
  loading: boolean;
  density: 'comfortable' | 'compact';
  sortBy: ErrorSortKey;
  sortOrder: SortOrder;
  page: number;
  pageCount: number;
  pageSize: PageSize;
  /** 筛选后的总条数（不是当前页条数） */
  total: number;
  hasFilters: boolean;
  expandedKey: string | null;
  /** 展开行的最近错误样本（由页面按需请求） */
  samples: ErrorSample[];
  samplesLoading: boolean;
  samplesError: string;
}>();

const emit = defineEmits<{
  sort: [key: ErrorSortKey];
  toggle: [key: string];
  'page-change': [page: number];
  'page-size-change': [size: number];
  'retry-samples': [];
}>();

/** 列显隐放在组件内部：属于纯展示偏好，不需要进 store / URL */
const visibleKeys = ref<string[]>(COLUMNS.map((column) => column.key));
const visibleColumns = computed(() => COLUMNS.filter((column) => visibleKeys.value.includes(column.key)));
const columnOpen = ref(false);
const columnWrapRef = ref<HTMLElement | null>(null);

function toggleColumn(key: string): void {
  if (visibleKeys.value.includes(key)) {
    // 至少保留两列，避免用户把表隐藏到无法操作
    if (visibleKeys.value.length <= 2) return;
    visibleKeys.value = visibleKeys.value.filter((item) => item !== key);
    return;
  }
  visibleKeys.value = [...visibleKeys.value, key];
}

function isColumnLocked(key: string): boolean {
  return visibleKeys.value.includes(key) && visibleKeys.value.length <= 2;
}

function ariaSort(column: ColumnDef): 'ascending' | 'descending' | 'none' {
  if (!column.sortKey || props.sortBy !== column.sortKey) return 'none';
  return props.sortOrder === 'asc' ? 'ascending' : 'descending';
}

const colspan = computed(() => visibleColumns.value.length + 1);

function onPageSizeChange(event: Event): void {
  emit('page-size-change', Number((event.target as HTMLSelectElement).value));
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (!columnOpen.value) return;
  const wrap = columnWrapRef.value;
  if (wrap && event.target instanceof Node && wrap.contains(event.target)) return;
  columnOpen.value = false;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') columnOpen.value = false;
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeydown);
});
</script>

<template>
  <section class="panel table-panel">
    <header class="panel-header">
      <div>
        <h2 class="panel-title">错误分组</h2>
        <p class="panel-subtitle">
          服务端只返回窗口内累计次数 TOP 200 的分组；本页的搜索、排序、分页均在此范围内完成。
        </p>
      </div>

      <div class="panel-tools">
        <span class="tag tag-info">筛选后 {{ formatNumber(props.total) }} 组</span>
        <div ref="columnWrapRef" class="column-wrap">
          <button
            class="icon-button"
            type="button"
            title="列设置"
            aria-haspopup="true"
            :aria-expanded="columnOpen"
            @click="columnOpen = !columnOpen"
          >
            <AppIcon name="columns" :size="17" />
          </button>

          <div v-if="columnOpen" class="column-pop">
            <p class="column-pop-title">显示列</p>
            <label v-for="column in COLUMNS" :key="column.key" class="column-item">
              <input
                type="checkbox"
                :checked="visibleKeys.includes(column.key)"
                :disabled="isColumnLocked(column.key)"
                @change="toggleColumn(column.key)"
              />
              <span>{{ column.label }}</span>
            </label>
            <p class="column-pop-hint">至少保留两列</p>
          </div>
        </div>
      </div>
    </header>

    <div class="table-scroll">
      <table class="data-table" :class="{ 'is-compact': props.density === 'compact' }">
        <thead>
          <tr>
            <th
              v-for="column in visibleColumns"
              :key="column.key"
              :class="{ num: column.numeric }"
              :aria-sort="ariaSort(column)"
            >
              <button
                v-if="column.sortKey"
                class="sort-button"
                type="button"
                :title="`按${column.label}排序`"
                @click="emit('sort', column.sortKey)"
              >
                <span>{{ column.label }}</span>
                <AppIcon
                  v-if="props.sortBy === column.sortKey"
                  :name="props.sortOrder === 'asc' ? 'arrow-up' : 'arrow-down'"
                  :size="13"
                  class="sort-icon is-active"
                />
                <AppIcon v-else name="chevrons-up-down" :size="13" class="sort-icon" />
              </button>
              <template v-else>{{ column.label }}</template>
            </th>
            <th class="action-head">详情</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="props.loading && props.groups.length === 0">
            <tr v-for="row in 6" :key="`skeleton-${row}`">
              <td v-for="column in visibleColumns" :key="column.key">
                <div class="skeleton cell-skeleton" />
              </td>
              <td><div class="skeleton cell-skeleton" /></td>
            </tr>
          </template>

          <tr v-else-if="props.groups.length === 0">
            <td :colspan="colspan" class="empty-cell">
              <div class="empty-inner">
                <AppIcon name="bug" :size="20" />
                <div>
                  <strong>
                    {{ props.hasFilters ? '当前条件下没有匹配的错误分组' : '当前窗口内没有错误上报' }}
                  </strong>
                  <p>
                    {{
                      props.hasFilters
                        ? '可以放宽关键词 / 最小次数，或点击「重置」查看全部。'
                        : '采集链路是干净的，等待新的上报即可。'
                    }}
                  </p>
                </div>
              </div>
            </td>
          </tr>

          <template v-else>
            <template v-for="group in props.groups" :key="group.groupKey">
              <tr :class="{ 'is-expanded': props.expandedKey === group.groupKey }">
                <td v-if="visibleKeys.includes('type')">
                  <div class="type-cell">
                    <span class="type-badge">{{ group.errorType || 'UNKNOWN' }}</span>
                    <span v-if="group.isNew" class="tag tag-success">NEW</span>
                  </div>
                </td>

                <td v-if="visibleKeys.includes('error')" class="error-cell">
                  <div class="error-name" :title="group.name || group.groupKey">
                    {{ group.name || '未命名错误' }}
                  </div>
                  <div class="error-message" :title="group.message || ''">
                    {{ truncate(group.message, 72) }}
                  </div>
                </td>

                <td v-if="visibleKeys.includes('source')" class="source-cell">
                  <span class="mono" :title="group.sampleUrl || ''">
                    {{ truncate(group.sampleUrl, 44) }}
                  </span>
                </td>

                <td v-if="visibleKeys.includes('count')" class="num strong">
                  {{ formatNumber(group.totalCount) }}
                </td>
                <td v-if="visibleKeys.includes('users')" class="num">
                  {{ formatNumber(group.affectedUsers) }}
                </td>

                <td v-if="visibleKeys.includes('firstSeen')" class="time-cell">
                  <span :title="formatDateTime(group.firstSeen)">{{ formatDateTime(group.firstSeen) }}</span>
                </td>
                <td v-if="visibleKeys.includes('lastSeen')" class="time-cell">
                  <span :title="formatDateTime(group.lastSeen)">{{ formatRelativeTime(group.lastSeen) }}</span>
                </td>

                <td class="action-cell">
                  <button
                    class="btn btn-sm"
                    type="button"
                    :aria-expanded="props.expandedKey === group.groupKey"
                    @click="emit('toggle', group.groupKey)"
                  >
                    {{ props.expandedKey === group.groupKey ? '收起' : '详情' }}
                    <AppIcon
                      name="chevron-down"
                      :size="13"
                      :class="{ 'is-flipped': props.expandedKey === group.groupKey }"
                    />
                  </button>
                </td>
              </tr>

              <tr v-if="props.expandedKey === group.groupKey" class="detail-row">
                <td :colspan="colspan">
                  <div class="detail-grid">
                    <div class="detail-item">
                      <span class="detail-label">分组键</span>
                      <code class="detail-code">{{ group.groupKey }}</code>
                    </div>
                    <div class="detail-item">
                      <span class="detail-label">首次 / 最近</span>
                      <p class="detail-text">
                        {{ formatDateTime(group.firstSeen) }} → {{ formatDateTime(group.lastSeen) }}
                        <span class="detail-muted">（{{ formatRelativeTime(group.lastSeen) }}）</span>
                      </p>
                    </div>
                    <div class="detail-item detail-wide">
                      <span class="detail-label">完整消息</span>
                      <p class="detail-text">{{ group.message || '—' }}</p>
                    </div>
                    <div class="detail-item detail-wide">
                      <span class="detail-label">来源页面</span>
                      <code class="detail-code">{{ group.sampleUrl || '—' }}</code>
                    </div>
                    <ErrorStackTrace
                      :samples="props.samples"
                      :loading="props.samplesLoading"
                      :error="props.samplesError"
                      @retry="emit('retry-samples')"
                    />
                  </div>
                </td>
              </tr>

            </template>
          </template>

        </tbody>
      </table>
    </div>

    <footer class="table-footer">
      <p class="footer-meta">
        共 <strong>{{ formatNumber(props.total) }}</strong> 个分组
        <span class="footer-sep">·</span>
        第 {{ props.page }} / {{ props.pageCount }} 页
      </p>

      <div class="footer-controls">
        <label class="page-size">
          每页
          <select :value="props.pageSize" @change="onPageSizeChange">
            <option v-for="size in PAGE_SIZE_OPTIONS" :key="size" :value="size">{{ size }}</option>
          </select>
          条
        </label>

        <div class="pager" role="group" aria-label="分页">
          <button
            class="btn btn-sm"
            type="button"
            :disabled="props.page <= 1"
            @click="emit('page-change', 1)"
          >
            首页
          </button>
          <button
            class="btn btn-sm pager-icon"
            type="button"
            aria-label="上一页"
            :disabled="props.page <= 1"
            @click="emit('page-change', props.page - 1)"
          >
            <AppIcon name="chevron-left" :size="14" />
          </button>
          <span class="pager-current" :title="`第 ${props.page} 页`">{{ props.page }}</span>
          <button
            class="btn btn-sm pager-icon"
            type="button"
            aria-label="下一页"
            :disabled="props.page >= props.pageCount"
            @click="emit('page-change', props.page + 1)"
          >
            <AppIcon name="chevron-right" :size="14" />
          </button>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="props.page >= props.pageCount"
            @click="emit('page-change', props.pageCount)"
          >
            末页
          </button>
        </div>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.table-panel {
  min-width: 0;
}

.panel-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.column-wrap {
  position: relative;
}

.column-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 30;
  width: 182px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-md);
}

.column-pop-title {
  padding: 4px 8px 8px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.column-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 7px;
  color: var(--text-secondary);
  font-size: 12.5px;
  cursor: pointer;
}

.column-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.column-item input {
  accent-color: var(--primary);
}

.column-pop-hint {
  padding: 6px 8px 2px;
  color: var(--text-muted);
  font-size: 11px;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.strong {
  color: var(--text);
  font-weight: 650;
}

.sort-button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
}

.sort-button:hover {
  color: var(--text);
}

.sort-icon {
  flex: none;
  color: var(--text-muted);
  opacity: 0.55;
}

.sort-icon.is-active {
  color: var(--primary);
  opacity: 1;
}

.type-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.type-badge {
  display: inline-flex;
  align-items: center;
  max-width: 170px;
  padding: 2px 7px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--danger-soft);
  color: var(--danger);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-cell {
  max-width: 340px;
}

.error-name {
  overflow: hidden;
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-message {
  display: -webkit-box;
  margin-top: 3px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.source-cell {
  max-width: 260px;
}

.source-cell .mono {
  display: block;
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time-cell {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.action-cell {
  width: 96px;
  text-align: right;
  white-space: nowrap;
}

.action-cell :deep(.app-icon) {
  transition: transform 0.16s ease;
}

.action-cell :deep(.app-icon.is-flipped) {
  transform: rotate(180deg);
}

.is-expanded td {
  background: var(--surface-hover);
}

.is-compact td {
  padding-top: 8px;
  padding-bottom: 8px;
}

.cell-skeleton {
  width: 100%;
  height: 17px;
}

.empty-cell {
  padding: 0;
}

.empty-inner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 140px;
  padding: 20px;
  color: var(--text-muted);
  text-align: left;
}

.empty-inner > :first-child {
  color: var(--danger);
  opacity: 0.75;
}

.empty-inner strong {
  display: block;
  color: var(--text-secondary);
  font-size: 13px;
}

.empty-inner p {
  margin-top: 3px;
  font-size: 12px;
}

.detail-row td {
  padding: 0;
  background: var(--surface-2);
}

/* 详情行 hover 时保持浅底，避免和普通行的 hover 高亮视觉混淆 */
.detail-row:hover td {
  background: var(--surface-2);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 20px;
  padding: 14px 16px 16px;
}

.detail-wide {
  grid-column: 1 / -1;
}

.detail-item {
  min-width: 0;
}

.detail-label {
  display: block;
  margin-bottom: 5px;
  color: var(--text-muted);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.detail-code {
  display: block;
  max-height: 120px;
  padding: 7px 9px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  word-break: break-all;
  white-space: normal;
}

.detail-text {
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}

.detail-muted {
  color: var(--text-muted);
}

.detail-note {
  display: flex;
  grid-column: 1 / -1;
  align-items: flex-start;
  gap: 6px;
  padding-top: 9px;
  border-top: 1px dashed var(--border);
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.detail-note :deep(.app-icon) {
  margin-top: 1px;
  flex: none;
  color: var(--warning);
}

.table-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}

.footer-meta {
  color: var(--text-muted);
  font-size: 12px;
}

.footer-meta strong {
  color: var(--text);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.footer-sep {
  margin: 0 4px;
  opacity: 0.6;
}

.footer-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.page-size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.page-size select {
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.pager {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pager-icon {
  width: 30px;
  padding: 0;
}

.pager-current {
  min-width: 34px;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 900px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .table-footer {
    align-items: flex-start;
  }
}

@media (max-width: 640px) {
  .panel-header {
    flex-direction: column;
  }

  .panel-tools {
    justify-content: flex-start;
  }

  .footer-controls {
    width: 100%;
    justify-content: space-between;
  }
}
</style>
