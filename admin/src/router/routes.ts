import type { RouteRecordRaw } from 'vue-router';
import AdminLayout from '@/layouts/AdminLayout.vue';

/**
 * 前端路由表（history 模式）。
 *
 * 全部页面挂在 AdminLayout 下，Layout 负责侧边栏 / 顶栏 / 内容区；
 * 菜单项见 src/router/menu.ts，两边 path 需要保持一致。
 *
 * 目前没有登录鉴权与路由守卫，刷新任意路径都能直接进入。
 */
export const layoutChildren: RouteRecordRaw[] = [
  {
    path: 'dashboard',
    name: 'dashboard',
    component: () => import('@/views/dashboard/DashboardView.vue'),
    meta: {
      title: '数据看板',
      icon: 'dashboard',
      description: '错误采集与 PV/UV 概览',
    },
  },
  {
    /**
     * 错误列表。
     *
     * 注意：这个路径是前端 history 路由，部署时 nginx 需要 `try_files $uri /index.html`；
     * 采集服务自己的采集入口是 /errors/upload，两者不在同一个域时互不影响，
     * 同域部署时请把 location /errors/ 限定到采集服务的上传地址，避免把页面请求转发过去。
     */
    path: 'errors',
    name: 'errors',
    component: () => import('@/views/errors/ErrorListView.vue'),
    meta: {
      title: '错误列表',
      icon: 'bug',
      description: '按窗口、类型、关键词检索错误分组',
    },
  },
];

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: AdminLayout,
    redirect: '/dashboard',
    children: layoutChildren,
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: {
      title: '页面不存在',
      menu: false,
    },
  },
];
