<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import EChart from '@/components/EChart.vue';
import StatCard from '@/components/StatCard.vue';
import ErrorGroupsTable from '@/components/dashboard/ErrorGroupsTable.vue';
import QueueStatusPanel from '@/components/dashboard/QueueStatusPanel.vue';
import { DAY_OPTIONS, useDashboardStore, WINDOW_OPTIONS } from '@/stores/dashboard';
import { buildErrorTypeOption, buildPvTrendOption, buildTopRouteOption } from '@/utils/chartOptions';
import { formatClock, formatNumber, formatPercent, formatRelativeTime } from '@/utils/format';

/**
 * 数据看板。
 *
 * 数据来源（examples/server）：
 * - /api/stats/overview  → 顶部 4 张指标卡 + 写队列状态
 * - /api/stats/errors    → 错误类型环形图 + 错误分组表
 * - /api/stats/pv        → PV/UV 日趋势 + 最近 24h 路由排行
 *
 * 错误类接口跟随顶部的时间窗口；PV 趋势跟随「天数」选择；路由排行固定 24h。
 */
const store = useDashboardStore();

const AUTO_REFRESH_MS = 30_000;
const autoRefresh = ref(true);
let timer: number | undefined;

const windowLabel = computed(
  () =>
    WINDOW_OPTIONS.find((option) => option.hours === store.windowHours)?.label ??
    `${store.windowHours} 小时`,
);

const trendOption = computed(() => buildPvTrendOption(store.daily));
const errorTypeOption = computed(() => buildErrorTypeOption(store.errorTypes));
const topRouteOption = computed(() => buildTopRouteOption(store.topRoutes));

const pvTotal = computed(() => store.daily.reduce((sum, item) => sum + item.pv, 0));

function stopTimer(): void {
  if (timer === undefined) return;
  window.clearInterval(timer);
  timer = undefined;
}

function startTimer(): void {
  stopTimer();
  timer = window.setInterval(() => {
    // 页面在后台 / 上一次请求还没结束时跳过，避免持续堆请求
    if (!document.hidden && !store.refreshing) void store.load();
  }, AUTO_REFRESH_MS);
}

watch(autoRefresh, (enabled) => {
  if (enabled) startTimer();
  else stopTimer();
});

onMounted(() => {
  void store.load();
  if (autoRefresh.value) startTimer();
});

onBeforeUnmount(stopTimer);
</script>

<template>
  <div class="dashboard">
    <section class="page-head">
      <div class="page-head-copy">
        <p class="eyebrow"><span class="pulse-dot" aria-hidden="true" /> Liveness &amp; Errors</p>
        <h1>数据看板</h1>
        <p class="page-desc">
          错误采集链路健康度、错误分组与页面访问趋势，数据来自 examples/server 的
          <code>/api/stats/*</code> 接口。
        </p>
        <p class="head-meta">
          <AppIcon name="clock" :size="14" />
          <span>
            更新于 {{ store.lastUpdated ? formatClock(store.lastUpdated) : '—' }}
            <template v-if="store.lastUpdated">
              （{{ formatRelativeTime(store.lastUpdated) }}）
            </template>
          </span>
          <span class="meta-sep" aria-hidden="true">·</span>
          <span>错误指标窗口 {{ windowLabel }}</span>
          <span class="meta-sep" aria-hidden="true">·</span>
          <span>{{ autoRefresh ? '每 30 秒自动刷新' : '自动刷新已关闭' }}</span>
        </p>
      </div>

      <div class="page-actions">
        <div class="segmented" role="group" aria-label="错误统计窗口">
          <button
            v-for="option in WINDOW_OPTIONS"
            :key="option.hours"
            type="button"
            :class="{ 'is-active': store.windowHours === option.hours }"
            @click="store.setWindowHours(option.hours)"
          >
            {{ option.label }}
          </button>
        </div>

        <label class="switch" title="开启后每 30 秒自动拉取一次数据">
          <input v-model="autoRefresh" type="checkbox" />
          <span class="switch-track" aria-hidden="true"><span class="switch-thumb" /></span>
          <span>自动刷新</span>
        </label>

        <button
          class="btn btn-primary"
          type="button"
          :disabled="store.refreshing"
          @click="store.load()"
        >
          <AppIcon name="refresh" :size="16" :class="{ 'is-spinning': store.refreshing }" />
          {{ store.refreshing ? '刷新中' : '刷新' }}
        </button>
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

    <section class="stat-grid" aria-label="核心指标">
      <StatCard
        label="错误上报"
        :value="formatNumber(store.overview?.errors)"
        unit="条"
        :hint="`${windowLabel}内的错误上报条数，含重复上报`"
        icon="bug"
        tone="danger"
        :badge="windowLabel"
        :loading="store.loading"
      />
      <StatCard
        label="页面浏览 PV"
        :value="formatNumber(store.overview?.pv)"
        unit="次"
        hint="SDK 合并上报后按 count 求和"
        icon="eye"
        tone="primary"
        :badge="windowLabel"
        :loading="store.loading"
      />
      <StatCard
        label="独立访客 UV"
        :value="formatNumber(store.overview?.uv)"
        unit="人"
        hint="窗口内不同 visitorId 数"
        icon="users"
        tone="purple"
        :badge="windowLabel"
        :loading="store.loading"
      />
      <StatCard
        label="错误率"
        :value="formatPercent(store.overview?.errorRate)"
        hint="errors / pv，可能超过 100%（pv 为 0 时记作 0）"
        icon="activity"
        tone="warning"
        :badge="windowLabel"
        :loading="store.loading"
      />
    </section>

    <section class="chart-grid">
      <article class="panel">
        <header class="panel-header">
          <div>
            <h2 class="panel-title">PV / UV 趋势</h2>
            <p class="panel-subtitle">按服务器时区的自然日聚合，PV 为 SUM(count)</p>
          </div>
          <div class="panel-tools">
            <span class="tag tag-info">PV {{ formatNumber(pvTotal) }}</span>
            <div class="segmented segmented-sm" role="group" aria-label="趋势天数">
              <button
                v-for="option in DAY_OPTIONS"
                :key="option"
                type="button"
                :class="{ 'is-active': store.days === option }"
                @click="store.setDays(option)"
              >
                {{ option }} 天
              </button>
            </div>
          </div>
        </header>
        <div class="panel-body">
          <EChart
            :option="trendOption"
            :height="300"
            :loading="store.loading"
            :empty="store.daily.length === 0"
            empty-text="所选天数内还没有 PV/UV 数据"
          />
        </div>
      </article>

      <article class="panel">
        <header class="panel-header">
          <div>
            <h2 class="panel-title">错误类型分布</h2>
            <p class="panel-subtitle">按当前 TOP 分组的累计次数聚合</p>
          </div>
          <span class="tag tag-purple">{{ store.errorTypes.length }} 种类型</span>
        </header>
        <div class="panel-body">
          <EChart
            :option="errorTypeOption"
            :height="300"
            :loading="store.loading"
            :empty="store.errorTypes.length === 0"
            empty-text="当前窗口没有错误类型数据"
          />
        </div>
      </article>
    </section>

    <section class="split-grid">
      <article class="panel">
        <header class="panel-header">
          <div>
            <h2 class="panel-title">路由访问排行</h2>
            <p class="panel-subtitle">
              最近 24 小时 PV / UV TOP {{ store.topRoutes.length || 10 }}
            </p>
          </div>
          <span class="tag tag-info">24h</span>
        </header>
        <div class="panel-body">
          <EChart
            :option="topRouteOption"
            :height="280"
            :loading="store.loading"
            :empty="store.topRoutes.length === 0"
            empty-text="最近 24 小时没有路由 PV 数据"
          />
        </div>
      </article>

      <QueueStatusPanel :queue="store.overview?.queue ?? null" :loading="store.loading" />
    </section>

    <ErrorGroupsTable
      :groups="store.errorGroups"
      :window-label="windowLabel"
      :loading="store.loading"
    />

    <section class="insight-grid" aria-label="指标口径说明">
      <div class="insight">
        <AppIcon name="activity" :size="17" />
        <div>
          <strong>指标口径</strong>
          <p>
            errors 是错误上报条数（不是去重分组数）；pv 是 SDK 合并上报后的 SUM(count)；
            errorRate = errors / pv。
          </p>
        </div>
      </div>
      <div class="insight">
        <AppIcon name="server" :size="17" />
        <div>
          <strong>分组与队列</strong>
          <p>
            分组接口按 lastSeen 过滤窗口，次数为历史累计；队列计数自进程启动累积，
            depth 为实时水位。
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 20px;
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
  max-width: 720px;
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

.page-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex: none;
}

.segmented-sm {
  padding: 2px;
  border-radius: 9px;
}

.segmented-sm button {
  height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 11.5px;
}

.panel-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.error-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 16px;
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

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 16px;
}

.chart-grid,
.split-grid {
  display: grid;
  gap: 16px;
  margin-bottom: 16px;
}

.chart-grid {
  grid-template-columns: minmax(0, 1.85fr) minmax(0, 1fr);
}

.split-grid {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  margin-top: 16px;
}

.chart-grid > .panel,
.split-grid > .panel {
  min-width: 0;
}

.insight-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.insight {
  display: flex;
  gap: 10px;
  padding: 13px 16px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.insight > :first-child {
  margin-top: 1px;
  color: var(--primary);
}

.insight strong {
  display: block;
  margin-bottom: 2px;
  color: var(--text-secondary);
  font-size: 12.5px;
}

.insight p {
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.55;
}

@media (max-width: 1340px) {
  .chart-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 1180px) {
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1000px) {
  .page-head {
    flex-direction: column;
  }

  .page-actions {
    justify-content: flex-start;
  }

  .split-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .page-actions,
  .page-actions .segmented {
    width: 100%;
  }

  .page-actions .segmented {
    overflow-x: auto;
  }

  .page-actions .btn {
    flex: 1;
  }

  .panel-tools {
    justify-content: flex-start;
  }

  .insight-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  h1 {
    font-size: 22px;
  }
}
</style>
