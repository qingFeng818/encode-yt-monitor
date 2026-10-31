import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

/**
 * 全局 UI 状态：主题、侧边栏折叠、移动端抽屉。
 *
 * 主题的首次初始化放在 index.html 的内联脚本里（避免白屏闪烁），
 * 这里只负责读取 <html data-theme> 的当前值并负责后续切换与持久化。
 */

export type ThemeMode = 'light' | 'dark';

const THEME_KEY = 'monitor-admin:theme';
const SIDEBAR_KEY = 'monitor-admin:sidebar-collapsed';
const MOBILE_BREAKPOINT = 900;

function readInitialTheme(): ThemeMode {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark') {
    return 'dark';
  }
  return 'light';
}

function readInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1';
  } catch {
    return false;
  }
}

export const useAppStore = defineStore('app', () => {
  const theme = ref<ThemeMode>(readInitialTheme());
  const sidebarCollapsed = ref(readInitialCollapsed());
  const mobileSidebarOpen = ref(false);

  watch(
    theme,
    (value) => {
      document.documentElement.dataset.theme = value;
      try {
        localStorage.setItem(THEME_KEY, value);
      } catch {
        // 隐私模式 / 存储被禁用时忽略，主题仍然在当前会话生效
      }
    },
    { immediate: true },
  );

  watch(sidebarCollapsed, (value) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, value ? '1' : '0');
    } catch {
      // 同上
    }
  });

  function toggleTheme(): void {
    theme.value = theme.value === 'dark' ? 'light' : 'dark';
  }

  /** 桌面端折叠侧边栏；移动端开合抽屉 */
  function toggleSidebar(): void {
    const isMobile = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
    if (isMobile) {
      mobileSidebarOpen.value = !mobileSidebarOpen.value;
      return;
    }
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  function closeMobileSidebar(): void {
    mobileSidebarOpen.value = false;
  }

  return {
    theme,
    sidebarCollapsed,
    mobileSidebarOpen,
    toggleTheme,
    toggleSidebar,
    closeMobileSidebar,
  };
});
