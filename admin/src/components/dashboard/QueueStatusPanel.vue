<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { QueueStats } from '@/types/monitor';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/utils/format';

/**
 * 写队列健康面板。
 * 数据来自 /api/stats/overview 的 queue 字段（WriteQueue.getStats()）：
 * 除 depth / lastFlushAt 外都是「进程启动以来」的累计计数。
 */
const props = defineProps<{
  queue: QueueStats | null;
  loading?: boolean;
}>();

const status = computed<{ label: string; className: string }>(() => {
  const queue = props.queue;
  if (!queue) {
    return props.loading
      ? { label: '加载中', className: 'tag' }
      : { label: '等待数据', className: 'tag' };
  }
  if (queue.lastError || queue.failures > 0) {
    return { label: '写库异常', className: 'tag tag-danger' };
  }
  if (queue.dropped > 0) {
    return { label: '存在丢弃', className: 'tag tag-warning' };
  }
  if (queue.depth > 200) {
    return { label: '队列积压', className: 'tag tag-warning' };
  }
  return { label: '运行正常', className: 'tag tag-success' };
});

const metrics = computed(() => {
  const queue = props.queue;
  if (!queue) return [];
  return [
    { label: '接收', value: queue.received, hint: 'push 总条数', danger: false },
    { label: '入队', value: queue.accepted, hint: '进入内存队列', danger: false },
    { label: '落库', value: queue.persisted, hint: '写入存储', danger: false },
    { label: '去重', value: queue.duplicated, hint: '幂等键拦截', danger: false },
    { label: '批次', value: queue.batches, hint: '成功事务数', danger: false },
    { label: '失败', value: queue.failures, hint: '写库失败批次', danger: queue.failures > 0 },
  ];
});

const hasProblem = computed(() => {
  const queue = props.queue;
  return Boolean(queue && (queue.dropped > 0 || queue.failures > 0));
});
</script>

<template>
  <article class="panel queue-panel">
    <header class="panel-header">
      <div>
        <h2 class="panel-title">写队列健康</h2>
        <p class="panel-subtitle">进程启动以来的累计计数，depth 为实时水位</p>
      </div>
      <span :class="status.className">{{ status.label }}</span>
    </header>

    <div class="panel-body">
      <div class="hero">
        <div class="hero-block">
          <span class="hero-label">当前水位 depth</span>
          <strong class="hero-value">{{ formatNumber(queue?.depth) }}</strong>
          <span class="hero-unit">条待落库</span>
        </div>
        <div class="hero-block">
          <span class="hero-label">丢弃 / 失败</span>
          <strong class="hero-value" :class="{ 'is-danger': hasProblem }">
            {{ formatNumber(queue?.dropped) }}
            <span class="slash">/</span>
            {{ formatNumber(queue?.failures) }}
          </strong>
          <span class="hero-unit">条 / 批次</span>
        </div>
      </div>

      <ul class="metric-grid">
        <li
          v-for="item in metrics"
          :key="item.label"
          class="metric"
          :class="{ 'is-danger': item.danger }"
        >
          <span class="metric-label">{{ item.label }}</span>
          <strong class="metric-value">{{ formatNumber(item.value) }}</strong>
          <span class="metric-hint">{{ item.hint }}</span>
        </li>
      </ul>

      <p class="flush">
        <AppIcon name="clock" :size="14" />
        <span>
          最近一次 flush
          <strong :title="formatDateTime(queue?.lastFlushAt)">
            {{ formatRelativeTime(queue?.lastFlushAt) }}
          </strong>
        </span>
      </p>

      <p v-if="queue?.lastError" class="last-error">
        <AppIcon name="warning" :size="14" />
        <span>{{ queue.lastError }}</span>
      </p>
    </div>
  </article>
</template>

<style scoped>
.queue-panel {
  display: flex;
  flex-direction: column;
}

.queue-panel .panel-body {
  display: flex;
  flex: 1;
  flex-direction: column;
}

.hero {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.hero-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 12px;
}

.hero-label {
  color: var(--text-muted);
  font-size: 11.5px;
}

.hero-value {
  color: var(--text);
  font-size: 24px;
  font-weight: 680;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.hero-value.is-danger {
  color: var(--danger);
}

.slash {
  margin: 0 2px;
  color: var(--text-muted);
  font-weight: 400;
}

.hero-unit {
  color: var(--text-muted);
  font-size: 11px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px dashed var(--border);
}

.metric {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.metric-label {
  color: var(--text-muted);
  font-size: 11.5px;
}

.metric-value {
  color: var(--text);
  font-size: 16px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.metric.is-danger .metric-value {
  color: var(--danger);
}

.metric-hint {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flush {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 14px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.flush strong {
  color: var(--text-secondary);
  font-weight: 600;
}

.last-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 10px;
  color: var(--danger);
  background: var(--danger-soft);
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.45;
  word-break: break-all;
}
</style>
