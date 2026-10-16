import { describe, it, expect, beforeEach, vi } from 'vitest';
import { errorBoundaryReport } from 'encode-yt-monitor-react/index';
import { breadcrumb, transportData } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, ErrorTypes } from 'encode-yt-monitor-shared';
import { SCRIPT_ERROR_FIXTURES, EXPECTED_REPORT_TYPE } from '../helpers/errorFixtures';

const SAMPLE_COMPONENT_STACK = `
    at BrokenButton (http://localhost/src/BrokenButton.tsx:12:5)
    at App (http://localhost/src/App.tsx:8:9)
`;

describe('React ErrorBoundary（errorBoundaryReport，非 window.onerror）', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sendSpy = vi.spyOn(transportData, 'send').mockImplementation(() => undefined);
    vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  it.each(SCRIPT_ERROR_FIXTURES)(
    '$name 应上报 REACT_ERROR 并带上 componentStack',
    ({ name, error }) => {
      const err = error();
      errorBoundaryReport(err, { componentStack: SAMPLE_COMPONENT_STACK });

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const payload = sendSpy.mock.calls[0][0] as any;
      expect(payload.type).toBe(EXPECTED_REPORT_TYPE.react);
      expect(payload.name).toBe(name);
      expect(payload.componentStack).toContain('BrokenButton');
    },
  );

  it('非 Error 对象应降级为 unknown 并仍上报', () => {
    errorBoundaryReport('string thrown from render');

    const payload = sendSpy.mock.calls[0][0] as any;
    expect(payload.type).toBe(ErrorTypes.REACT_ERROR);
    expect(payload.name).toBe('unknown');
    expect(String(payload.message)).toContain('string thrown');
  });

  it('应写入 REACT 面包屑', () => {
    const pushSpy = vi.mocked(breadcrumb.push);
    errorBoundaryReport(new TypeError('render crash'), { componentStack: SAMPLE_COMPONENT_STACK });

    expect(pushSpy).toHaveBeenCalledWith(expect.objectContaining({ type: BreadCrumbTypes.REACT }));
  });
});
