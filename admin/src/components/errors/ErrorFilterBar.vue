<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { useElementWidth } from '@/composables/useElementWidth';
import FilterField from './FilterField.vue';
import type { FilterFieldConfig, FilterValues } from './filterConfig';

/**
 * 可配置搜索栏（页面第一栏：搜索栏）。
 *
 * 折叠逻辑（纯计算，不用 canvas）：
 * 1. 每个字段有固定设计宽度 width，容器宽度由 ResizeObserver 提供；
 * 2. 先判断「所有常用字段 + 间距」是否放得下；放得下就全部展示；
 * 3. 放不下时为「更多筛选」按钮预留宽度，再按顺序累加字段宽度，
 *    放不下的字段（以及配置里 advanced=true 的字段）进入展开区；
 * 4. 窗口变宽时同一套公式会算出更多可展示字段，不需要手写断点。
 *
 * 为什么不按文本长度动态算宽度：输入框/下拉的宽度是产品定的（避免一行里
 * 长短不一），配置化后按宽度求整比 canvas 测量文字更稳定，也不会受字体影响。
 */

const GAP = 12;
/**
 * 「更多筛选」按钮的预留宽度（含图标、文字、角标、箭头与 padding）。
 * 取偏保守的 152px：宁可少放一个字段，也不要让按钮顶出容器。
 */
const TOGGLE_WIDTH = 152;
const DEFAULT_FIELD_WIDTH = 220;

const props = defineProps<{
  fields: FilterFieldConfig[];
  /** 已生效的查询条件（来自 store / URL） */
  modelValue: FilterValues;
  loading?: boolean;
}>();

const emit = defineEmits<{
  /** 点击「查询」或在输入框回车 */
  search: [values: FilterValues];
  /** 点击「清空全部条件」 */
  reset: [];
}>();

const rowRef = ref<HTMLElement | null>(null);
const rowWidth = useElementWidth(rowRef);
const expanded = ref(false);

/** 草稿：用户改了但还没点「查询」时不污染已生效条件 */
const draft = reactive<FilterValues>({});

function defaultValueOf(field: FilterFieldConfig): string {
  return field.defaultValue ?? '';
}

function normalize(values: FilterValues): FilterValues {
  const next: FilterValues = {};
  props.fields.forEach((field) => {
    next[field.key] = values[field.key] ?? defaultValueOf(field);
  });
  return next;
}

// immediate：首次挂载就把 modelValue 灌进草稿；deep：父级重置后能同步回来
// 只覆盖「父级确实变了」的键：用户在草稿里改了关键词但没点查询时，
// 点击表头排序不会把他输入到一半的内容冲掉。
let lastModel: FilterValues = {};

watch(
  () => props.modelValue,
  (next) => {
    const normalized = normalize(next);
    const first = Object.keys(lastModel).length === 0;
    Object.keys(normalized).forEach((key) => {
      if (first || normalized[key] !== lastModel[key]) draft[key] = normalized[key];
    });
    lastModel = normalized;
  },
  { deep: true, immediate: true },
);

const inlineCandidates = computed(() => props.fields.filter((field) => !field.advanced));
const fixedAdvanced = computed(() => props.fields.filter((field) => field.advanced));

function fieldWidth(field: FilterFieldConfig): number {
  return field.width ?? DEFAULT_FIELD_WIDTH;
}

/**
 * 第一行能放下多少个「常用字段」。
 * rowWidth 初始为 Infinity（全部展示），挂载后立刻量真实宽度；
 * 宽度还未知时按「全放得下」处理，避免首帧先折叠再展开的跳动。
 */
const inlineCount = computed(() => {
  const list = inlineCandidates.value;
  const width = rowWidth.value;
  if (!Number.isFinite(width) || width <= 0) return list.length;

  const total = list.reduce((sum, field) => sum + fieldWidth(field), 0) + GAP * Math.max(0, list.length - 1);
  // 有固定高级项时要始终给「更多筛选」按钮留位置（即使常用字段本身放得下）
  const reserve = fixedAdvanced.value.length > 0 ? TOGGLE_WIDTH + GAP : 0;
  if (total + reserve <= width) return list.length;

  // 需要折叠时，先给「更多筛选」按钮留位置
  const budget = width - TOGGLE_WIDTH - GAP;
  let used = 0;
  let count = 0;
  for (const field of list) {
    const extra = fieldWidth(field) + (count > 0 ? GAP : 0);
    if (used + extra > budget) break;
    used += extra;
    count += 1;
  }
  return count;
});

const visibleFields = computed(() => inlineCandidates.value.slice(0, inlineCount.value));
const collapsedFields = computed(() => [
  ...inlineCandidates.value.slice(inlineCount.value),
  ...fixedAdvanced.value,
]);
const hasMore = computed(() => collapsedFields.value.length > 0);

/** 收起区里已填写的条件数量（「全部」这种默认值不算） */
const collapsedActiveCount = computed(
  () => collapsedFields.value.filter((field) => (draft[field.key] ?? '') !== defaultValueOf(field)).length,
);

watch(hasMore, (value) => {
  if (!value) expanded.value = false;
});

// 窄屏时一行放不下任何常用字段：自动展开，避免用户只看到一个「更多筛选」按钮
watch(inlineCount, (count) => {
  if (count === 0 && hasMore.value) expanded.value = true;
});

function apply(): void {
  emit('search', normalize(draft));
}

function reset(): void {
  const cleared: FilterValues = {};
  props.fields.forEach((field) => {
    cleared[field.key] = defaultValueOf(field);
  });
  Object.assign(draft, cleared);
  expanded.value = false;
  emit('reset');
}

defineExpose({ apply, reset });
</script>

<template>
  <section class="panel filter-bar" :aria-busy="props.loading">
    <div ref="rowRef" class="filter-row" role="search" aria-label="错误筛选条件">
      <FilterField
        v-for="field in visibleFields"
        :key="field.key"
        v-model="draft[field.key]"
        :field="field"
        @submit="apply"
      />

      <button
        v-if="hasMore"
        class="more-toggle"
        type="button"
        :aria-expanded="expanded"
        aria-controls="error-filter-more"
        @click="expanded = !expanded"
      >
        <AppIcon name="filter" :size="15" />
        <span>{{ expanded ? '收起筛选' : '更多筛选' }}</span>
        <span v-if="collapsedActiveCount > 0" class="more-count">{{ collapsedActiveCount }}</span>
        <AppIcon name="chevron-down" :size="14" :class="{ 'is-flipped': expanded }" />
      </button>
    </div>

    <div v-if="expanded && hasMore" id="error-filter-more" class="filter-more">
      <div class="filter-more-fields">
        <FilterField
          v-for="field in collapsedFields"
          :key="field.key"
          v-model="draft[field.key]"
          :field="field"
          @submit="apply"
        />
      </div>
      <p class="filter-more-hint">
        <AppIcon name="warning" :size="13" />
        <span>
          收起项包含配置为「高级」的字段，以及当前宽度放不下的字段；缩放窗口会自动重新计算。
        </span>
        <button class="link-button" type="button" @click="reset">清空全部条件</button>
      </p>
    </div>
  </section>
</template>

<style scoped>
.filter-bar {
  padding: 14px 16px;
}

.filter-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  min-width: 0;
}

.more-toggle {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 11px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  transition:
    background 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease;
}

.more-toggle:hover {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary);
}

.more-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--primary);
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 1;
}

.more-toggle :deep(.app-icon) {
  transition: transform 0.18s ease;
}

.more-toggle :deep(.app-icon.is-flipped) {
  transform: rotate(180deg);
}

.filter-more {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}

.filter-more-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.filter-more-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.5;
}

.filter-more-hint :deep(.app-icon) {
  color: var(--warning);
}

.link-button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--primary);
  font-size: 11.5px;
  font-weight: 600;
}

.link-button:hover {
  text-decoration: underline;
}

@media (max-width: 640px) {
  .filter-row {
    flex-wrap: wrap;
  }

  .filter-bar :deep(.filter-field) {
    width: 100% !important;
  }

  .more-toggle {
    width: 100%;
    justify-content: center;
  }
}
</style>
