import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/**
 * Node 环境下的 MSW server（单测用）。
 *
 * 标准用法（在测试文件的 beforeAll / afterEach / afterAll 里）：
 *   beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => mswServer.resetHandlers());
 *   afterAll(() => mswServer.close());
 * 'error' 策略能帮你发现「SDK 实际打了一个没被 mock 的地址」这类问题。
 */
export const mswServer = setupServer(...handlers);
