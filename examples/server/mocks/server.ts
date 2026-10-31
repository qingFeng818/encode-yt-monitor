import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/**
 * 与 mocks/node.ts 等价的旧入口（历史文件，保留是为了不破坏已有 import）。
 * 新代码请统一使用 './node' 里的 mswServer；两者共享同一份 handlers。
 */
export const server = setupServer(...handlers);
