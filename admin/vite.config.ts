import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * ============================================================================
 * 管理后台构建配置
 * ============================================================================
 *
 * 开发态默认把 /api、/healthz 代理到 examples/server（http://localhost:2021），
 * 这样浏览器地址栏里只有 admin 自己的端口，不存在跨域，也方便后面挂到同一个域名下。
 *
 * 需要指向别的采集服务时，改 admin/.env.development 里的 VITE_PROXY_TARGET 即可，
 * 不需要动这个文件。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_PROXY_TARGET || 'http://localhost:2021';

  return {
    plugins: [vue()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5174,
      strictPort: false,
      proxy: {
        '/api': { target: proxyTarget, changeOrigin: true },
        '/healthz': { target: proxyTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 900,
    },
  };
});
