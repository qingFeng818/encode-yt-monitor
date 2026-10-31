import type { IconName } from '@/components/icons';

/**
 * 侧边栏菜单（前端路由控制的唯一数据源）。
 *
 * 新增页面时：
 * 1. 在 src/views 下创建页面组件；
 * 2. 在 src/router/routes.ts 里挂到 AdminLayout 的 children；
 * 3. 在这里补一条菜单项（path 必须与路由一致）。
 *
 * 暂未接入登录鉴权；后续如需权限控制，在 router/index.ts 的 beforeEach 里
 * 根据用户角色过滤 MENU_ITEMS 与路由即可。
 */
export interface MenuItem {
  path: string;
  title: string;
  icon: IconName;
  description?: string;
}

export const MENU_ITEMS: MenuItem[] = [
  {
    path: '/dashboard',
    title: '数据看板',
    icon: 'dashboard',
    description: '错误采集与 PV/UV 概览',
  },
  {
    path: '/errors',
    title: '错误列表',
    icon: 'bug',
    description: '按窗口、类型、关键词检索错误分组',
  },
];
