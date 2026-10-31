<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import AppIcon from './AppIcon.vue';
import { MENU_ITEMS } from '@/router/menu';
import { version } from '../../package.json';

const route = useRoute();

/** 采集服务地址：优先读环境变量；都没配时退回当前站点（生产同域反代） */
const serviceUrl = computed(() => {
  const configured = import.meta.env.VITE_PROXY_TARGET || import.meta.env.VITE_API_BASE_URL || '';
  const base = (configured || window.location.origin).replace(/\/$/, '');
  return `${base}/api`;
});

function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(`${path}/`);
}
</script>

<template>
  <aside class="app-sidebar" aria-label="主导航">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="22" height="22">
          <path
            d="M4 23l6-13 5 8 4-5 9 13"
            fill="none"
            stroke="currentColor"
            stroke-width="2.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <span class="brand-text">
        <strong>Encode Monitor</strong>
        <small>稳定性监控后台</small>
      </span>
    </div>

    <nav class="nav">
      <p class="nav-caption">监控</p>
      <RouterLink
        v-for="item in MENU_ITEMS"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :class="{ 'is-active': isActive(item.path) }"
        :title="item.title"
      >
        <AppIcon :name="item.icon" :size="19" />
        <span class="nav-label">{{ item.title }}</span>
        <span class="nav-glow" aria-hidden="true" />
      </RouterLink>
    </nav>

    <div class="sidebar-footer">
      <a class="footer-link" :href="serviceUrl" target="_blank" rel="noreferrer">
        <span class="status-dot" aria-hidden="true" />
        <span class="sidebar-footer-text">
          <strong>采集服务</strong>
          <small>examples/server</small>
        </span>
        <AppIcon class="sidebar-footer-icon" name="arrow-up-right" :size="15" />
      </a>
      <p class="version">Admin v{{ version }}</p>
    </div>
  </aside>
</template>

<style scoped>
.app-sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  padding: 20px 14px 16px;
  overflow: hidden;
  color: var(--sidebar-text);
  background: var(--sidebar-bg);
  border-right: 1px solid var(--sidebar-border);
  transition:
    width 0.22s ease,
    transform 0.22s ease;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 50px;
  padding: 2px 8px 22px;
}

.brand-mark {
  display: grid;
  flex: none;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  color: #dbeafe;
  background: linear-gradient(140deg, #2563eb, #7c3aed);
  box-shadow: 0 10px 24px -10px rgba(59, 130, 246, 0.95);
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  white-space: nowrap;
}

.brand-text strong {
  color: #f8fafc;
  font-size: 14.5px;
  letter-spacing: 0.01em;
}

.brand-text small {
  margin-top: 2px;
  color: var(--sidebar-muted);
  font-size: 11px;
}

.nav {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
}

.nav-caption {
  margin: 6px 10px 2px;
  color: var(--sidebar-muted);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  white-space: nowrap;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  height: 42px;
  padding: 0 12px;
  border-radius: 10px;
  color: var(--sidebar-text);
  font-size: 13.5px;
  font-weight: 550;
  white-space: nowrap;
  transition:
    background 0.16s ease,
    color 0.16s ease;
}

.nav-item:hover {
  background: rgba(148, 163, 184, 0.1);
  color: #f1f5f9;
}

.nav-item.is-active {
  color: #fff;
  background: linear-gradient(100deg, rgba(59, 130, 246, 0.28), rgba(139, 92, 246, 0.16));
}

.nav-item.is-active::before {
  position: absolute;
  top: 9px;
  bottom: 9px;
  left: -14px;
  width: 3px;
  content: '';
  background: #60a5fa;
  border-radius: 0 3px 3px 0;
}

.nav-label {
  flex: 1;
  overflow: hidden;
}

.nav-glow {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: transparent;
}

.nav-item.is-active .nav-glow {
  background: #93c5fd;
  box-shadow: 0 0 10px 2px rgba(147, 197, 253, 0.6);
}

.sidebar-footer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid rgba(148, 163, 184, 0.14);
}

.footer-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  color: var(--sidebar-text);
  background: rgba(148, 163, 184, 0.06);
  transition: background 0.16s ease;
}

.footer-link:hover {
  background: rgba(148, 163, 184, 0.13);
}

.status-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #34d399;
  box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.14);
}

.sidebar-footer-text {
  display: flex;
  flex-direction: column;
  line-height: 1.3;
  white-space: nowrap;
}

.sidebar-footer-text strong {
  color: #e2e8f0;
  font-size: 12px;
  font-weight: 600;
}

.sidebar-footer-text small {
  color: var(--sidebar-muted);
  font-size: 10.5px;
}

.sidebar-footer-icon {
  margin-left: auto;
  opacity: 0.6;
}

.version {
  margin: 2px 10px 0;
  color: var(--sidebar-muted);
  font-size: 10.5px;
  letter-spacing: 0.04em;
}

@media (min-width: 901px) {
  :global(.admin-shell.is-collapsed) .app-sidebar {
    width: var(--sidebar-collapsed-width);
  }

  :global(.admin-shell.is-collapsed) .brand {
    justify-content: center;
    padding-right: 3px;
    padding-left: 3px;
  }

  :global(.admin-shell.is-collapsed) .brand-text,
  :global(.admin-shell.is-collapsed) .nav-label,
  :global(.admin-shell.is-collapsed) .nav-caption,
  :global(.admin-shell.is-collapsed) .nav-glow,
  :global(.admin-shell.is-collapsed) .sidebar-footer-text,
  :global(.admin-shell.is-collapsed) .sidebar-footer-icon,
  :global(.admin-shell.is-collapsed) .version {
    display: none;
  }

  :global(.admin-shell.is-collapsed) .nav-item {
    justify-content: center;
    padding: 0;
  }

  :global(.admin-shell.is-collapsed) .footer-link {
    justify-content: center;
    padding: 9px 0;
  }
}

@media (max-width: 900px) {
  .app-sidebar {
    width: min(var(--sidebar-width), 82vw);
    transform: translateX(-100%);
  }

  :global(.admin-shell.is-drawer-open) .app-sidebar {
    transform: translateX(0);
    box-shadow: 0 24px 60px rgba(2, 8, 23, 0.55);
  }
}
</style>
