<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import { computeVisibleCount, type OverflowAction } from './overflow';
import { useElementWidth } from '@/composables/useElementWidth';

/**
 * 功能按钮栏（页面第二栏）的动态溢出组件。
 *
 * 方案对比（为什么不用 canvas measureText）：
 * - canvas 只能测「文字」宽度，按钮还有图标、左右 padding、边框、gap；
 * - 浏览器缩放 / 自定义字体 / 字体延迟加载都会让 canvas 结果和真实布局不一致；
 * - 按钮数量很少（≤ 10），用隐藏探针行 + getBoundingClientRect 实测成本可以忽略；
 * - 实测结果缓存在 widths 里，只有文案变化 / 字体 ready / 探针尺寸变化时才重算。
 *
 * 折叠规则：
 * - `pinned: true` 的按钮（例如「查询」「刷新」）排在最前、优先显示；
 * - 其余按钮按顺序累加宽度，放不下的收进「更多」下拉；
 * - 容器宽度由 ResizeObserver 监听，侧边栏折叠、窗口缩放都会触发重算。
 * - 极窄屏放不下全部 pinned 时，尾部 pinned 也会进「更多」——优先保证工具栏不溢出。
 */

const props = withDefaults(
  defineProps<{
    actions: OverflowAction[];
    /** 按钮间距，与 CSS 的 --actions-gap 保持一致 */
    gap?: number;
  }>(),
  { gap: 8 },
);

const emit = defineEmits<{
  select: [key: string];
}>();

const rootRef = ref<HTMLElement | null>(null);
const rootWidth = useElementWidth(rootRef);
const probeRef = ref<HTMLElement | null>(null);
const actionWidths = ref<number[]>([]);
const moreWidth = ref(96);
const open = ref(false);

/** pinned 排前面，保证「更多」只吞掉尾部按钮（稳定排序，保持原有相对顺序） */
const orderedActions = computed(() =>
  [...props.actions].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))),
);

function measure(): void {
  const probe = probeRef.value;
  if (!probe) return;
  const buttons = Array.from(probe.querySelectorAll<HTMLElement>('[data-probe="action"]'));
  actionWidths.value = buttons.map((button) => button.getBoundingClientRect().width);
  const more = probe.querySelector<HTMLElement>('[data-probe="more"]');
  moreWidth.value = more ? more.getBoundingClientRect().width : 96;
}

const visibleCount = computed(() => {
  const list = orderedActions.value;
  const widths = actionWidths.value;
  if (list.length === 0) return 0;
  // 宽度未知或还没量完按钮时先全部展示，避免首帧少按钮
  if (widths.length !== list.length) return list.length;
  return computeVisibleCount({
    widths,
    containerWidth: rootWidth.value,
    moreWidth: moreWidth.value,
    gap: props.gap,
  });
});

const visibleActions = computed(() => orderedActions.value.slice(0, visibleCount.value));
const overflowActions = computed(() => orderedActions.value.slice(visibleCount.value));
const hasOverflow = computed(() => overflowActions.value.length > 0);

watch(hasOverflow, (value) => {
  if (!value) open.value = false;
});

// 文案/禁用态变化后探针宽度可能变化，等 DOM 更新完再量
watch(
  () => props.actions,
  () => {
    void nextTick(measure);
  },
  { deep: true, flush: 'post' },
);

let probeObserver: ResizeObserver | null = null;

function onDocumentPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const root = rootRef.value;
  if (root && event.target instanceof Node && root.contains(event.target)) return;
  open.value = false;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false;
}

onMounted(() => {
  void nextTick(measure);
  // 字体加载完成后按钮宽度会变（尤其是中文/等宽字体），重新量一次
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    document.fonts.ready.then(() => measure()).catch(() => undefined);
  }
  if (probeRef.value && typeof ResizeObserver !== 'undefined') {
    probeObserver = new ResizeObserver(() => measure());
    probeObserver.observe(probeRef.value);
  }
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  probeObserver?.disconnect();
  probeObserver = null;
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('keydown', onDocumentKeydown);
});

function choose(key: string): void {
  const action = props.actions.find((item) => item.key === key);
  if (action?.disabled) return;
  open.value = false;
  emit('select', key);
}
</script>

<template>
  <div ref="rootRef" class="overflow-actions" :style="{ '--actions-gap': `${props.gap}px` }">
    <!-- 隐藏探针：与真实按钮同一套 class / padding / 字体，测量值可直接复用 -->
    <div ref="probeRef" class="probe" aria-hidden="true">
      <button
        v-for="action in orderedActions"
        :key="action.key"
        type="button"
        tabindex="-1"
        data-probe="action"
        :class="['btn', { 'btn-primary': action.tone === 'primary' }]"
      >
        <AppIcon v-if="action.icon" :name="action.icon" :size="15" />
        {{ action.label }}
      </button>
      <button type="button" tabindex="-1" data-probe="more" class="btn">
        <AppIcon name="more-horizontal" :size="16" />
        更多
        <span class="more-badge">9</span>
      </button>
    </div>

    <button
      v-for="action in visibleActions"
      :key="action.key"
      type="button"
      :class="['btn', { 'btn-primary': action.tone === 'primary' }]"
      :disabled="action.disabled"
      :title="action.title"
      @click="choose(action.key)"
    >
      <AppIcon v-if="action.icon" :name="action.icon" :size="15" />
      {{ action.label }}
    </button>

    <div v-if="hasOverflow" class="more-wrap">
      <button
        type="button"
        class="btn more-button"
        :class="{ 'is-open': open }"
        aria-haspopup="menu"
        :aria-expanded="open"
        title="剩余操作"
        @click="open = !open"
      >
        <AppIcon name="more-horizontal" :size="16" />
        <span>更多</span>
        <span class="more-badge">{{ overflowActions.length }}</span>
      </button>

      <div v-if="open" class="more-menu" role="menu" aria-label="更多操作">
        <button
          v-for="action in overflowActions"
          :key="action.key"
          type="button"
          class="menu-item"
          role="menuitem"
          :disabled="action.disabled"
          :title="action.title"
          @click="choose(action.key)"
        >
          <AppIcon v-if="action.icon" :name="action.icon" :size="15" />
          <span>{{ action.label }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overflow-actions {
  position: relative;
  display: flex;
  flex: 1 1 420px;
  flex-wrap: nowrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--actions-gap, 8px);
  min-width: 0;
}

/** 探针绝对定位、不可见，不占据布局，也不会被读屏/键盘访问 */
.probe {
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  /* max-content：探针不能被容器宽度挤压，否则量到的是「压扁后」的按钮宽度 */
  width: max-content;
  gap: var(--actions-gap, 8px);
  visibility: hidden;
  pointer-events: none;
  white-space: nowrap;
}

.probe .btn,
.overflow-actions > .btn {
  flex: none;
}

.more-wrap {
  position: relative;
  flex: none;
}

.more-button.is-open {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-soft);
}

.more-badge {
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

.more-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 45;
  min-width: 190px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  box-shadow: var(--shadow-md);
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 550;
  text-align: left;
  white-space: nowrap;
  transition:
    background 0.14s ease,
    color 0.14s ease;
}

.menu-item:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
