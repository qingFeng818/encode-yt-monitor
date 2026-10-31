import { createRouter, createWebHistory } from 'vue-router';
import { routes } from './routes';

/**
 * 路由实例。
 *
 * - history 模式：地址干净（/dashboard），部署时需要 nginx `try_files $uri /index.html`；
 * - 暂不接入登录鉴权：后续在 beforeEach 里加 token 校验与重定向即可，
 *   路由本身仍然由前端静态表控制。
 */
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0, left: 0 }),
});

router.afterEach((to) => {
  const title = String(to.meta.title ?? '');
  document.title = title ? `${title} · Encode Monitor` : 'Encode Monitor';
});

export default router;
