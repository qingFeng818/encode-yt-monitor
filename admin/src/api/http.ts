/**
 * ============================================================================
 * 极简 fetch 封装（零依赖，统一处理 { code, message, data } 响应）
 * ============================================================================
 *
 * examples/server 的所有查询接口都返回 { code: 0, message: 'ok', data }，
 * code !== 0 或 HTTP 非 2xx 都抛 ApiError，页面只需要展示 error.message。
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
const DEFAULT_TIMEOUT_MS = 15_000;

type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  /** 外部取消信号（例如组件卸载时取消请求） */
  signal?: AbortSignal;
  /** 超时时间，默认 15s */
  timeout?: number;
}

/** 与后端约定的响应信封 */
interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export class ApiError extends Error {
  readonly code: number;

  constructor(message: string, code = -1) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  Object.entries(query ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  const suffix = search.toString();
  return `${BASE_URL}${path}${suffix ? `?${suffix}` : ''}`;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;

  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  const handleExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', handleExternalAbort);

  try {
    const response = await fetch(buildUrl(path, options.query), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    // 先读文本再解析：后端 404/500 时可能返回 HTML，直接 response.json() 会抛
    // "Unexpected token < in JSON"，对使用者没有信息量。
    const raw = await response.text();
    let payload: ApiEnvelope<T> | null = null;
    try {
      payload = raw ? (JSON.parse(raw) as ApiEnvelope<T>) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      throw new ApiError(payload?.message || `请求失败（HTTP ${response.status}）`, payload?.code ?? response.status);
    }
    if (!payload) {
      throw new ApiError('响应不是合法的 JSON', -1);
    }
    if (payload.code !== 0) {
      throw new ApiError(payload.message || '接口返回异常', payload.code);
    }

    return payload.data;
  } catch (reason) {
    if (reason instanceof ApiError) throw reason;
    if (reason instanceof Error && reason.name === 'AbortError') {
      throw new ApiError(timedOut ? `请求超时（${timeout}ms）` : '请求已取消');
    }
    const detail = reason instanceof Error ? reason.message : String(reason);
    throw new ApiError(`无法连接采集服务，请确认 examples/server 已启动（pnpm demo）：${detail}`);
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener('abort', handleExternalAbort);
  }
}
