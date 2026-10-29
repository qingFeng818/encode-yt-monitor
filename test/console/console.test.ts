import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleConsole, breadcrumb } from 'encode-yt-monitor-core';
import { BreadCrumbTypes, BreadCrumbCategory, BreadCrumbItem } from 'encode-yt-monitor-shared';
import { Severity } from 'encode-yt-monitor-utils';

describe('console 行为采集（仅面包屑，不上报）', () => {
  let pushSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    pushSpy = vi.spyOn(breadcrumb, 'push').mockImplementation(() => undefined);
  });

  it.each([
    { level: 'log', severity: Severity.Info },
    { level: 'info', severity: Severity.Info },
    { level: 'warn', severity: Severity.Warning },
    { level: 'error', severity: Severity.Error },
  ])('console.$level 应映射到正确 Severity 并记为 DEBUG 类面包屑', ({ level, severity }) => {
    handleConsole({ args: ['hello', { a: 1 }], level });

    expect(pushSpy).toHaveBeenCalledTimes(1);
    const crumb = pushSpy.mock.calls[0][0] as BreadCrumbItem;
    expect(crumb.type).toBe(BreadCrumbTypes.CONSOLE);
    expect(crumb.category).toBe(BreadCrumbCategory.DEBUG);
    expect(crumb.level).toBe(severity);
    expect(crumb.data.args).toEqual(['hello', { a: 1 }]);
  });
});
