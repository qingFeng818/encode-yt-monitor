<script setup lang="ts">
import { watch } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from '@/components/AppHeader.vue';
import AppSidebar from '@/components/AppSidebar.vue';
import { useAppStore } from '@/stores/app';

const route = useRoute();
const app = useAppStore();

// 移动端抽屉模式下，切换页面后自动收起
watch(
  () => route.fullPath,
  () => app.closeMobileSidebar(),
);
</script>

<template>
  <div
    class="admin-shell"
    :class="{
      'is-collapsed': app.sidebarCollapsed,
      'is-drawer-open': app.mobileSidebarOpen,
    }"
  >
    <AppSidebar />

    <div class="admin-main">
      <AppHeader />
      <main class="admin-content">
        <router-view v-slot="{ Component }">
          <transition name="page-fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <button
      v-if="app.mobileSidebarOpen"
      class="sidebar-mask"
      type="button"
      aria-label="关闭菜单"
      @click="app.closeMobileSidebar()"
    />
  </div>
</template>

<style scoped>
.admin-shell {
  min-height: 100vh;
}

.admin-main {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  margin-left: var(--sidebar-width);
  transition: margin-left 0.22s ease;
}

.admin-content {
  flex: 1;
  width: 100%;
  max-width: 1560px;
  margin: 0 auto;
  padding: 24px 28px 44px;
}

.sidebar-mask {
  position: fixed;
  inset: 0;
  z-index: 35;
  display: none;
  padding: 0;
  border: 0;
  background: rgba(8, 15, 30, 0.52);
  backdrop-filter: blur(2px);
}

.page-fade-enter-active,
.page-fade-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.page-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-fade-leave-to {
  opacity: 0;
}

@media (min-width: 901px) {
  .admin-shell.is-collapsed .admin-main {
    margin-left: var(--sidebar-collapsed-width);
  }
}

@media (max-width: 900px) {
  .admin-main {
    margin-left: 0;
  }

  .admin-content {
    padding: 18px 16px 32px;
  }

  .sidebar-mask {
    display: block;
  }
}
</style>
