import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { HandleEvents } from '../../packages/browser/src/handleEvents';
import { transportData, breadcrumb } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, ErrorTypes } from 'encode-yt-monitor-shared';
import {
  createResourceErrorEvent,
  createScriptErrorEvent,
  dispatchWindowError,
} from '../helpers/errorEvents';
import { SCRIPT_ERROR_FIXTURES } from '../helpers/errorFixtures';
import type { ReportDataType } from 'encode-yt-monitor-types';

/**
 * 集成：与 listenError 相同 — window capture 阶段 error → handleError
 * （Vitest 中 SDK 的 _global 可能指向 process，故直接挂 window 监听）
 *
 * 目标：不仅验证“监听被触发”，更验证上报载荷是否准确携带有效信息。
 */
describe('window error 监听链路（集成）', () => {
  let sendSpy: MockInstance<(data: ReportDataType) => Promise<void>>;
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    window.addEventListener(
      'error',
      (error) => {
        HandleEvents.handleError(error as ErrorEvent);
      },
      true,
    );
  });

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  describe('脚本运行时错误（JAVASCRIPT_ERROR）', () => {
    it.each(SCRIPT_ERROR_FIXTURES)(
      'dispatch ErrorEvent：$name 经 capture 监听后应上报且字段完整',
      async ({ error, message }) => {
        dispatchWindowError(createScriptErrorEvent({ message, error: error() }));
        await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());

        const payload = sendSpy.mock.calls.at(-1)?.[0];
        expect(payload?.type).toBe(ErrorTypes.JAVASCRIPT_ERROR);
        expect(payload?.name).toBeTruthy();
        expect(payload?.message).toBeTruthy();
        expect(payload?.url).toBeTruthy();
        expect(typeof payload?.time).toBe('number');
        // 携带结构化调用栈：至少一帧，且帧包含定位信息
        expect(Array.isArray(payload?.stack)).toBe(true);
        expect(payload?.stack?.length).toBeGreaterThan(0);
        const frame = payload.stack[0];
        expect(typeof frame.line).toBe('number');
        // extractErrorStack 产出的帧字段为 column（部分场景可为 null）
        expect(typeof frame.column).toMatch(/number|object/);
        expect(frame.url).toBeTruthy();

        expect(pushSpy).toHaveBeenCalledWith(
          expect.objectContaining({ type: BreadCrumbTypes.CODE_ERROR }),
        );
      },
    );

    it('无 Error 对象时应从 message 解析错误名，并使用 lineno/colno 构造栈帧', async () => {
      dispatchWindowError(
        createScriptErrorEvent({
          message: 'Uncaught TypeError: x is not a function',
          error: null,
          lineno: 42,
          colno: 7,
        }),
      );
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());

      const payload = sendSpy.mock.calls.at(-1)?.[0];
      expect(payload?.type).toBe(ErrorTypes.JAVASCRIPT_ERROR);
      expect(payload?.name).toBe('TypeError');
      expect(payload?.message).toBe('x is not a function');
      expect(payload?.stack?.[0]?.line).toBe(42);
      expect(payload?.stack?.[0]?.col).toBe(7);
      expect(payload?.stack?.[0]?.url).toContain('localhost');
    });

    it('跨域脚本 "Script error." 应降级为 UNKNOWN 且不丢失 message', async () => {
      dispatchWindowError(
        createScriptErrorEvent({
          message: 'Script error.',
          error: null,
          filename: '',
          lineno: 0,
          colno: 0,
        }),
      );
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());

      const payload = sendSpy.mock.calls.at(-1)?.[0];
      expect(payload?.type).toBe(ErrorTypes.JAVASCRIPT_ERROR);
      expect(payload?.name).toBe(ErrorTypes.UNKNOWN);
      expect(payload?.message).toBe('Script error.');
    });
  });

  describe('资源加载错误（RESOURCE_ERROR）', () => {
    it('img 加载失败应上报 RESOURCE_ERROR 且携带资源地址', async () => {
      const src = 'https://cdn.example.com/missing.png';
      const img = document.createElement('img');
      img.src = src;
      document.body.appendChild(img);

      img.dispatchEvent(createResourceErrorEvent('img', src));
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());

      const payload = sendSpy.mock.calls.at(-1)?.[0];
      expect(payload?.type).toBe(ErrorTypes.RESOURCE_ERROR);
      expect(payload?.name).toContain('图片');
      expect(payload?.message).toContain(src);
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: BreadCrumbTypes.RESOURCE }),
      );

      document.body.removeChild(img);
    });

    it('script 加载失败应上报 RESOURCE_ERROR 且 name 标注 js脚本', async () => {
      const src = 'https://cdn.example.com/bundle.js';
      dispatchWindowError(createResourceErrorEvent('script', src));
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalled());

      const payload = sendSpy.mock.calls.at(-1)?.[0];
      expect(payload?.type).toBe(ErrorTypes.RESOURCE_ERROR);
      expect(payload?.name).toContain('js脚本');
      expect(payload?.message).toContain(src);
    });
  });
});
