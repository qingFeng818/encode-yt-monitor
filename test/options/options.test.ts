import { describe, it, expect, vi } from 'vitest';
import { Options } from 'encode-yt-monitor-core';
import { logger } from 'encode-yt-monitor-utils';

describe('Options.isReportStatic（PV/UV 采集开关）', () => {
  it('默认关闭', () => {
    expect(new Options().isReportStatic).toBe(false);
  });

  it('init 传入布尔值时生效', () => {
    const options = new Options();

    options.bindOptions({ isReportStatic: true });
    expect(options.isReportStatic).toBe(true);

    options.bindOptions({ isReportStatic: false });
    expect(options.isReportStatic).toBe(false);
  });

  it('非布尔值会被忽略并保持默认值', () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const options = new Options();

    options.bindOptions({ isReportStatic: 'yes' as any });

    expect(options.isReportStatic).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});
