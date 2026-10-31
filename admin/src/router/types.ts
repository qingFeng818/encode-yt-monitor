import type { IconName } from '@/components/icons';

/**
 * 扩展 vue-router 的路由 meta 类型，让模板里 `route.meta.title` 是 string 而不是 unknown。
 * 这个文件不需要被显式 import，tsconfig 的 include 会把它纳入全局类型增强。
 */
declare module 'vue-router' {
  interface RouteMeta {
    /** 页面标题：用于 document.title、面包屑、菜单 */
    title: string;
    /** 侧边栏图标；不配则使用 dashboard 图标 */
    icon?: IconName;
    /** 页面副标题 / 说明 */
    description?: string;
    /** 是否出现在侧边栏，默认 true */
    menu?: boolean;
  }
}
