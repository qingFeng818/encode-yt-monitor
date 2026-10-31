<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import echarts, { type ChartInstance, type EChartsCoreOption } from '@/plugins/echarts';
import { useAppStore } from '@/stores/app';

/**
 * ECharts 容器组件。
 *
 * - 按需注册的 echarts 来自 plugins/echarts.ts（新增图表类型要去那里补注册）；
 * - 跟随全局主题重建实例（dark / default），并监听容器尺寸变化自动 resize；
 * - loading / empty 用覆盖层表示，实例本身始终存在，避免反复 init/dispose 造成闪烁。
 */
const props = withDefaults(
  defineProps<{
    option: EChartsCoreOption;
    height?: number | string;
    loading?: boolean;
    empty?: boolean;
    emptyText?: string;
  }>(),
  {
    height: 300,
    loading: false,
    empty: false,
    emptyText: '暂无数据',
  },
);

const app = useAppStore();
const container = ref<HTMLDivElement | null>(null);
const chart = shallowRef<ChartInstance | null>(null);
let observer: ResizeObserver | null = null;

function render(): void {
  chart.value?.setOption(props.option, { notMerge: true });
}

function init(): void {
  if (!container.value) return;
  chart.value = echarts.init(
    container.value,
    app.theme === 'dark' ? 'dark' : undefined,
    { renderer: 'canvas' },
  );
  render();
}

function dispose(): void {
  chart.value?.dispose();
  chart.value = null;
}

onMounted(() => {
  init();
  if (container.value) {
    observer = new ResizeObserver(() => chart.value?.resize());
    observer.observe(container.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  dispose();
});

watch(() => props.option, render);

// 主题切换：dispose 后重建，让 ECharts 内置配色（坐标轴 / 文字）一并切换
watch(
  () => app.theme,
  () => {
    dispose();
    init();
  },
);
</script>

<template>
  <div class="chart" :style="{ height: typeof height === 'number' ? `${height}px` : height }">
    <div ref="container" class="chart-canvas" />

    <div v-if="loading" class="chart-overlay">
      <div class="skeleton chart-skeleton" />
    </div>
    <div v-else-if="empty" class="chart-overlay chart-empty">
      <span>{{ emptyText }}</span>
    </div>
  </div>
</template>

<style scoped>
.chart {
  position: relative;
  width: 100%;
  min-height: 160px;
}

.chart-canvas {
  width: 100%;
  height: 100%;
}

.chart-overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
}

.chart-skeleton {
  width: 100%;
  height: 100%;
  border-radius: 10px;
}

.chart-empty {
  color: var(--text-muted);
  font-size: 12.5px;
  background: var(--surface);
}
</style>
