<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { ErrorGroup } from '@/types/monitor';
import { formatDateTime, formatNumber, formatRelativeTime, truncate } from '@/utils/format';

/**
 * 错误分组表。
 *
 * 口径提醒（与 examples/server 保持一致）：
 * - 服务端只返回 lastSeen 在统计窗口内的分组；
 * - totalCount / affectedUsers 是分组的「历史累计值」，不是窗口内增量；
 * - sampleUrl 只作为文本展示（不渲染成可点击链接，避免库里出现 javascript: 之类的地址）。
 */
const props = defineProps<{
  groups: ErrorGroup[];
  windowLabel: string;
  loading?: boolean;
}>();

const totalCount = computed(() => props.groups.reduce((sum, group) => sum + group.totalCount, 0));
</script>

<template>
  <section class="panel error-panel">
    <header class="panel-header">
      <div>
        <h2 class="panel-title">错误分组 TOP {{ groups.length }}</h2>
        <p class="panel-subtitle">
          只显示最近 {{ windowLabel }} 出现过的分组；次数为分组历史累计值
        </p>
      </div>
      <span class="tag tag-danger">{{ formatNumber(totalCount) }} 累计次数</span>
    </header>

    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>错误类型 / 名称</th>
            <th>消息</th>
            <th>来源页面</th>
            <th class="num">累计次数</th>
            <th class="num">影响访客</th>
            <th>最近出现</th>
          </tr>
        </thead>
        <tbody>
          <template v-if="loading && groups.length === 0">
            <tr v-for="row in 5" :key="row">
              <td v-for="col in 6" :key="col">
                <div class="skeleton cell-skeleton" />
              </td>
            </tr>
          </template>

          <tr v-else-if="groups.length === 0">
            <td colspan="6" class="empty-cell">
              <div class="empty-inner">
                <AppIcon name="bug" :size="18" />
                <span>当前窗口内没有错误上报，采集链路是干净的</span>
              </div>
            </td>
          </tr>

          <template v-else>
            <tr v-for="group in groups" :key="group.groupKey">
              <td>
                <div class="error-head">
                  <span class="type-badge">{{ group.errorType || 'UNKNOWN' }}</span>
                  <span v-if="group.isNew" class="tag tag-success">NEW</span>
                </div>
                <div class="error-name" :title="group.groupKey">
                  {{ truncate(group.name || group.errorType || '未命名错误', 42) }}
                </div>
              </td>
              <td class="message-cell">
                <span :title="group.message || ''">{{ truncate(group.message, 64) }}</span>
              </td>
              <td class="url-cell">
                <span class="mono" :title="group.sampleUrl || ''">
                  {{ truncate(group.sampleUrl, 38) }}
                </span>
              </td>
              <td class="num strong">{{ formatNumber(group.totalCount) }}</td>
              <td class="num">{{ formatNumber(group.affectedUsers) }}</td>
              <td>
                <span class="time" :title="`最近：${formatDateTime(group.lastSeen)}`">
                  {{ formatRelativeTime(group.lastSeen) }}
                </span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.table-scroll {
  margin-top: 14px;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.strong {
  color: var(--text);
  font-weight: 650;
}

.error-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 3px;
}

.type-badge {
  display: inline-flex;
  align-items: center;
  max-width: 180px;
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

.error-name {
  max-width: 260px;
  overflow: hidden;
  color: var(--text);
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-cell {
  max-width: 320px;
}

.message-cell span {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-secondary);
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.url-cell {
  max-width: 260px;
}

.url-cell span {
  display: block;
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.time {
  color: var(--text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.cell-skeleton {
  width: 100%;
  height: 18px;
}

.empty-cell {
  padding: 0;
}

.empty-inner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 120px;
  color: var(--text-muted);
  font-size: 12.5px;
}
</style>
