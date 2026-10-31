/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 采集服务地址；空字符串表示与当前站点同域（开发态由 vite proxy 转发） */
  readonly VITE_API_BASE_URL?: string;
  /** 开发态代理目标，仅 vite.config.ts 使用 */
  readonly VITE_PROXY_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
