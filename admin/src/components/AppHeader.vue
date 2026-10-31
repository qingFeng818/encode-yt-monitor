<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppIcon from './AppIcon.vue';
import { useAppStore } from '@/stores/app';

const app = useAppStore();
const route = useRoute();

/** 面包屑：只取有 title 的匹配记录，最后一级高亮 */
const crumbs = computed(() =>
  route.matched
    .map((record) => String(record.meta.title ?? ''))
    .filter((title) => title.length > 0),
);

const themeLabel = computed(() => (app.theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'));
/** 模板里不能直接写 import.meta，先取到脚本变量再暴露给模板 */
const isProd = import.meta.env.PROD;
const envLabel = isProd ? 'PROD' : 'DEV';
</script>

<template>
  <header class="app-header">
    <div class="header-left">
      <button
        class="icon-button"
        type="button"
        aria-label="切换侧边栏"
        title="切换侧边栏"
        @click="app.toggleSidebar()"
      >
        <AppIcon name="menu" :size="19" />
      </button>

      <nav class="breadcrumb" aria-label="面包屑">
        <span class="crumb-root">监控中心</span>
        <template v-for="(crumb, index) in crumbs" :key="`${crumb}-${index}`">
          <AppIcon class="crumb-sep" name="chevron-right" :size="13" />
          <span class="crumb" :class="{ 'is-current': index === crumbs.length - 1 }">
            {{ crumb }}
          </span>
        </template>
      </nav>
    </div>

    <div class="header-right">
      <span class="env-badge" :class="{ 'is-prod': isProd }">{{ envLabel }}</span>
      <span class="header-divider" aria-hidden="true" />
      <button
        class="icon-button"
        type="button"
        :aria-label="themeLabel"
        :title="themeLabel"
        @click="app.toggleTheme()"
      >
        <AppIcon :name="app.theme === 'dark' ? 'sun' : 'moon'" :size="18" />
      </button>
      <span class="header-avatar" title="未接入登录鉴权">AD</span>
    </div>
  </header>
</template>

<style scoped>
.app-header {
  position: sticky;
  top: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: var(--header-height);
  padding: 0 28px;
  background: var(--surface);
  background: color-mix(in srgb, var(--surface) 84%, transparent);
  border-bottom: 1px solid var(--border);
  backdrop-filter: blur(14px);
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
}

.crumb-root {
  color: var(--text-muted);
}

.crumb-sep {
  color: var(--text-muted);
  opacity: 0.7;
}

.crumb {
  overflow: hidden;
  color: var(--text-secondary);
  text-overflow: ellipsis;
}

.crumb.is-current {
  color: var(--text);
  font-weight: 600;
}

.env-badge {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--primary-soft);
  color: var(--primary);
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.env-badge.is-prod {
  background: var(--danger-soft);
  color: var(--danger);
}

.header-divider {
  width: 1px;
  height: 20px;
  margin: 0 2px;
  background: var(--border);
}

.header-avatar {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: #e0e7ff;
  background: linear-gradient(140deg, #4f46e5, #7c3aed);
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  user-select: none;
}

@media (max-width: 900px) {
  .app-header {
    padding: 0 16px;
  }

  .crumb-root,
  .crumb-sep:first-of-type {
    display: none;
  }

  .header-avatar {
    display: none;
  }
}
</style>
