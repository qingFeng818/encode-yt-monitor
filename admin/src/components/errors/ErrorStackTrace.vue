<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import type { ErrorSample } from '@/types/monitor';
import { copyText } from '@/utils/clipboard';
import { formatDateTime } from '@/utils/format';
import {
  formatFrameLocation,
  formatStackForCopy,
  isLinkableFrame,
  parseStack,
  type StackFrame,
} from '@/utils/stack';

/**
 * 错误堆栈（错误列表展开行）。
 *
 * 数据由页面按需拉取后传入：组件只负责解析 / 展示 / 复制，不请求接口。
 * 展示的是浏览器上报的 JS 文件位置（URL:line:column），生产环境通常是压缩后的 bundle；
 * 要映射回 .ts/.vue 源码需要 source map（见页面说明与 README）。
 */
const props = defineProps<{
  samples: ErrorSample[];
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  retry: [];
}>();

const latest = computed(() => props.samples[0] ?? null);
const frames = computed<StackFrame[]>(() => parseStack(latest.value?.stack));
const copyState = ref('');
let copyTimer: number | undefined;

function flashCopy(text: string): void {
  copyState.value = text;
  if (copyTimer !== undefined) window.clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    copyState.value = '';
    copyTimer = undefined;
  }, 1600);
}

async function copyFrame(frame: StackFrame): Promise<void> {
  const ok = await copyText(formatFrameLocation(frame));
  flashCopy(ok ? '已复制位置' : '复制失败');
}

async function copyAll(): Promise<void> {
  const source = frames.value.length
    ? formatStackForCopy(frames.value)
    : latest.value?.stack || '';
  if (!source) return;
  const ok = await copyText(source);
  flashCopy(ok ? '已复制堆栈' : '复制失败');
}

onBeforeUnmount(() => {
  if (copyTimer !== undefined) window.clearTimeout(copyTimer);
});
</script>

<template>
  <section class="stack-trace detail-wide" aria-label="最近堆栈">
    <div class="stack-head">
      <div class="stack-title">
        <span class="detail-label">最近堆栈</span>
        <span v-if="latest" class="stack-meta">
          {{ formatDateTime(latest.createdAt) }}
          <template v-if="latest.sdkVersion"> · SDK {{ latest.sdkVersion }}</template>
          <template v-if="props.samples.length > 1"> · 共 {{ props.samples.length }} 条样本</template>
        </span>
      </div>
      <button
        v-if="latest?.stack"
        class="btn btn-sm stack-action"
        type="button"
        @click="copyAll"
      >
        <AppIcon name="copy" :size="13" />
        {{ copyState || '复制堆栈' }}
      </button>
    </div>

    <div v-if="props.loading" class="stack-state" aria-live="polite">
      <span class="stack-spinner" aria-hidden="true" />
      正在加载最近堆栈…
    </div>

    <div v-else-if="props.error" class="stack-state is-error" role="alert">
      <AppIcon name="warning" :size="14" />
      <span>{{ props.error }}</span>
      <button class="btn btn-sm" type="button" @click="emit('retry')">重试</button>
    </div>

    <template v-else-if="latest">
      <ol v-if="frames.length" class="stack-list">
        <li v-for="(frame, index) in frames" :key="`${index}-${frame.url}-${frame.line}`" class="stack-item">
          <span class="stack-index">#{{ index }}</span>
          <span class="stack-func" :title="frame.func">{{ frame.func }}</span>
          <a
            v-if="isLinkableFrame(frame)"
            class="stack-loc"
            :href="frame.url || undefined"
            target="_blank"
            rel="noreferrer"
            :title="formatFrameLocation(frame)"
          >
            {{ formatFrameLocation(frame) }}
          </a>
          <span v-else class="stack-loc" :title="formatFrameLocation(frame)">
            {{ formatFrameLocation(frame) }}
          </span>
          <button
            class="stack-copy"
            type="button"
            title="复制这一帧的位置"
            @click="copyFrame(frame)"
          >
            复制
          </button>
        </li>
      </ol>

      <pre v-else-if="latest.stack" class="stack-raw">{{ latest.stack }}</pre>

      <p v-else class="stack-empty">
        这条样本没有堆栈（HTTP / 资源加载错误，或旧 SDK 未上报 stack）。
      </p>

      <p v-if="latest.ua" class="stack-ua" :title="latest.ua">
        UA：{{ latest.ua }}
      </p>
    </template>

    <p v-else class="stack-empty">
      该分组的明细已过保留期（RETENTION_DAYS），只保留聚合计数。
    </p>

    <p v-if="!props.loading && !props.error && latest" class="stack-hint">
      位置格式为 <code>JS 文件:行:列</code>。生产环境通常是压缩后的 bundle；要映射回源码，需要构建时保留
      source map 并在服务端解析（当前仅展示浏览器上报的原始位置）。
    </p>
  </section>
</template>

<style scoped>
.stack-trace {
  grid-column: 1 / -1;
  min-width: 0;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}

.stack-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.stack-title {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.stack-title :deep(.detail-label) {
  display: block;
  margin-bottom: 0;
  color: var(--text-muted);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.stack-meta {
  color: var(--text-muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.stack-action {
  height: 26px;
  padding: 0 9px;
  font-size: 11.5px;
}

.stack-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 260px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  list-style: none;
}

.stack-item {
  display: grid;
  grid-template-columns: 30px minmax(90px, 0.6fr) minmax(0, 1fr) auto;
  align-items: baseline;
  gap: 8px;
  padding: 3px 4px;
  border-radius: 5px;
}

.stack-item:hover {
  background: var(--surface-2);
}

.stack-index {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  text-align: right;
}

.stack-func {
  overflow: hidden;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stack-loc {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
  text-decoration: none;
}

a.stack-loc:hover {
  color: var(--primary);
  text-decoration: underline;
}

.stack-copy {
  padding: 1px 5px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
}

.stack-item:hover .stack-copy,
.stack-copy:focus-visible {
  opacity: 1;
}

.stack-copy:hover {
  background: var(--surface-2);
  color: var(--text);
}

.stack-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.stack-state.is-error {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
}

.stack-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: stack-spin 0.7s linear infinite;
}

@keyframes stack-spin {
  to {
    transform: rotate(360deg);
  }
}

.stack-raw {
  max-height: 220px;
  margin: 0;
  padding: 9px 11px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
}

.stack-empty {
  margin: 0;
  padding: 9px 11px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.stack-ua {
  margin: 7px 0 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stack-hint {
  margin: 9px 0 0;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.6;
}

.stack-hint code {
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface-2);
  font-family: var(--font-mono);
  font-size: 11px;
}

@media (max-width: 900px) {
  .stack-item {
    grid-template-columns: 26px minmax(70px, 0.5fr) minmax(0, 1fr);
  }

  .stack-copy {
    display: none;
  }
}
</style>
