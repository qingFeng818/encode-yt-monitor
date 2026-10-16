import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HandleEvents } from 'encode-yt-monitor-browser/handleEvents';
import { breadcrumb, transportData } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, ErrorTypes } from 'encode-yt-monitor-shared';
import {
  createResourceErrorEvent,
  createScriptErrorEvent,
} from '../helpers/errorEvents';
import { SCRIPT_ERROR_FIXTURES, EXPECTED_REPORT_TYPE } from '../helpers/errorFixtures';

describe('window error → HandleEvents.handleError（单元）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  let pushSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  describe('资源加载错误（target.localName）', () => {
    it('img 加载失败应上报 RESOURCE_ERROR', () => {
      const event = createResourceErrorEvent('img', 'https://cdn.example.com/logo.png');
      HandleEvents.handleError(event);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = sendSpy.mock.calls[0][0];
      expect(payload.type).toBe(EXPECTED_REPORT_TYPE.resource);
      expect(payload.name).toContain('图片');
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: BreadCrumbTypes.RESOURCE }),
      );
    });

    it('script 加载失败应上报 RESOURCE_ERROR', () => {
      const event = createResourceErrorEvent('script', 'https://cdn.example.com/bundle.js');
      HandleEvents.handleError(event);

      const payload = sendSpy.mock.calls[0][0];
      expect(payload.type).toBe(ErrorTypes.RESOURCE_ERROR);
      expect(payload.name).toContain('js脚本');
    });
  });

  describe('脚本运行时错误（JAVASCRIPT_ERROR）', () => {
    it.each(SCRIPT_ERROR_FIXTURES)('$name 应上报且 name 与 Error 一致', ({ name, error, message }) => {
      const err = error();
      const event = createScriptErrorEvent({ message, error: err });
      HandleEvents.handleError(event);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = sendSpy.mock.calls[0][0];
      expect(payload.type).toBe(EXPECTED_REPORT_TYPE.script);
      expect(payload.name).toBe(name);
      expect(payload.message).toBeTruthy();
      expect(pushSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: BreadCrumbTypes.CODE_ERROR }),
      );
    });

    it('无 error 对象时从 message 解析 TypeError（兼容旧式 onerror 字符串）', () => {
      const event = createScriptErrorEvent({
        message: 'Uncaught TypeError: x is not a function',
        error: null,
        lineno: 42,
        colno: 7,
      });
      HandleEvents.handleError(event);

      const payload = sendSpy.mock.calls[0][0];
      expect(payload.type).toBe(ErrorTypes.JAVASCRIPT_ERROR);
      expect(payload.name).toBe('TypeError');
      expect(payload.message).toBe('x is not a function');
      expect(payload.stack?.[0]?.line).toBe(42);
      expect(payload.stack?.[0]?.col).toBe(7);
    });

    it('普通 Error 实例应走 extractErrorStack', () => {
      const err = new Error('custom failure');
      err.name = 'CustomError';
      const event = createScriptErrorEvent({
        message: 'Uncaught Error: custom failure',
        error: err,
      });
      HandleEvents.handleError(event);

      const payload = sendSpy.mock.calls[0][0];
      expect(payload.type).toBe(ErrorTypes.JAVASCRIPT_ERROR);
      expect(payload.message).toBe('custom failure');
    });
  });
});
