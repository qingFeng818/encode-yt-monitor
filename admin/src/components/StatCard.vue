<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import type { IconName } from './icons';

/**
 * 顶部指标卡：一个主数值 + 口径说明。
 * 数值由父组件格式化成字符串（百分比 / 千分位），这里只负责排版。
 */
type Tone = 'primary' | 'danger' | 'warning' | 'success' | 'purple';

withDefaults(
  defineProps<{
    label: string;
    value: string;
    unit?: string;
    hint?: string;
    icon: IconName;
    tone?: Tone;
    badge?: string;
    loading?: boolean;
  }>(),
  {
    unit: '',
    hint: '',
    tone: 'primary',
    badge: '',
    loading: false,
  },
);
</script>

<template>
  <article class="stat-card panel" :class="`tone-${tone}`">
    <div class="stat-top">
      <span class="stat-icon">
        <AppIcon :name="icon" :size="18" />
      </span>
      <span v-if="badge" class="stat-badge">{{ badge }}</span>
    </div>

    <p class="stat-label">{{ label }}</p>

    <div class="stat-value-row">
      <div v-if="loading" class="skeleton stat-skeleton" />
      <template v-else>
        <strong class="stat-value">{{ value }}</strong>
        <span v-if="unit" class="stat-unit">{{ unit }}</span>
      </template>
    </div>

    <p v-if="hint" class="stat-hint">{{ hint }}</p>
  </article>
</template>

<style scoped>
.stat-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  padding: 17px 20px 18px;
  overflow: hidden;
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    border-color 0.18s ease;
}

.stat-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.stat-card::after {
  position: absolute;
  right: -36px;
  bottom: -52px;
  width: 132px;
  height: 132px;
  content: '';
  background: radial-gradient(circle, var(--tone-glow), transparent 68%);
  border-radius: 50%;
  pointer-events: none;
}

.stat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stat-icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: var(--tone);
  background: var(--tone-soft);
}

.stat-badge {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--tone-soft);
  color: var(--tone);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.stat-label {
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 550;
}

.stat-value-row {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-height: 38px;
}

.stat-value {
  color: var(--text);
  font-size: 28px;
  font-weight: 680;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  line-height: 1.15;
}

.stat-unit {
  color: var(--text-muted);
  font-size: 12px;
}

.stat-skeleton {
  width: 62%;
  height: 30px;
  margin: 4px 0;
}

.stat-hint {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tone-primary {
  --tone: var(--primary);
  --tone-soft: var(--primary-soft);
  --tone-glow: rgba(59, 130, 246, 0.2);
}

.tone-danger {
  --tone: var(--danger);
  --tone-soft: var(--danger-soft);
  --tone-glow: rgba(239, 68, 68, 0.2);
}

.tone-warning {
  --tone: var(--warning);
  --tone-soft: var(--warning-soft);
  --tone-glow: rgba(245, 158, 11, 0.22);
}

.tone-success {
  --tone: var(--success);
  --tone-soft: var(--success-soft);
  --tone-glow: rgba(16, 185, 129, 0.2);
}

.tone-purple {
  --tone: var(--purple);
  --tone-soft: var(--purple-soft);
  --tone-glow: rgba(139, 92, 246, 0.2);
}
</style>
