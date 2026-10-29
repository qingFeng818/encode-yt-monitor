import { describe, it, expect } from 'vitest';
import { QUANTILE_AT_VALUE, VALUE_AT_QUANTILE } from '../../packages/web-performance/src/utils/math';
import calcScore from '../../packages/web-performance/src/lib/calculateScore';
import { metricsName } from '../../packages/web-performance/src/constants';

/**
 * 性能分的计算完全依赖这条 log-normal 分位数曲线：
 * 曲线参数错了不会报错，只会让所有页面的得分「稳定地」偏大或偏小，
 * 属于最难在线上发现的一类问题，因此用数学性质（单调性、中位数、往返一致）来锁定。
 */

const fpCurve = { median: 3000, p10: 1800 };

describe('QUANTILE_AT_VALUE', () => {
  it('取值等于中位数时，分位数约等于 0.5', () => {
    // erf 是多项式近似，误差在 1e-10 量级，不能按「精确等于 0.5」断言
    expect(QUANTILE_AT_VALUE(fpCurve, 3000)).toBeCloseTo(0.5, 8);
  });

  it('耗时越小得分越高（单调递减）', () => {
    const fast = QUANTILE_AT_VALUE(fpCurve, 500);
    const normal = QUANTILE_AT_VALUE(fpCurve, 3000);
    const slow = QUANTILE_AT_VALUE(fpCurve, 5000);

    expect(fast).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(slow);
  });

  it('结果始终落在 (0, 1) 区间内（超出区间会被上层当成非法分数）', () => {
    [500, 1500, 3000, 5000].forEach((value) => {
      const score = QUANTILE_AT_VALUE(fpCurve, value);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });
  });

  it('显式传入 podr 时不再由 p10 推导，曲线形状随之改变', () => {
    const withPodr = QUANTILE_AT_VALUE({ median: 3000, podr: 1000 }, 1000);
    const withP10 = QUANTILE_AT_VALUE(fpCurve, 1000);

    expect(withPodr).not.toBeCloseTo(withP10, 3);
    expect(Number.isNaN(withPodr)).toBe(false);
  });
});

describe('VALUE_AT_QUANTILE', () => {
  it('0.5 分位对应中位数', () => {
    expect(VALUE_AT_QUANTILE(fpCurve, 0.5)).toBeCloseTo(3000, 6);
  });

  it('与 QUANTILE_AT_VALUE 互为逆运算', () => {
    [2000, 3000, 4000].forEach((value) => {
      const quantile = QUANTILE_AT_VALUE(fpCurve, value);
      const back = VALUE_AT_QUANTILE(fpCurve, quantile);
      expect(Math.abs(back - value) / value).toBeLessThan(0.02);
    });
  });

  it('分位数越高，需要的耗时越短（快页面对应高分位）', () => {
    expect(VALUE_AT_QUANTILE(fpCurve, 0.9)).toBeLessThan(VALUE_AT_QUANTILE(fpCurve, 0.5));
  });
});

describe('calcScore', () => {
  it.each([
    { metric: metricsName.FP, value: 3000 },
    { metric: metricsName.FCP, value: 3000 },
    { metric: metricsName.LCP, value: 4000 },
    { metric: metricsName.CCP, value: 4000 },
    { metric: metricsName.ACT, value: 3500 },
    { metric: metricsName.FID, value: 300 },
    { metric: metricsName.CLS, value: 0.25 },
  ])('$metric 取默认曲线中位数时得分约为 0.5', ({ metric, value }) => {
    expect(calcScore(metric, value)).toBeCloseTo(0.5, 8);
  });

  it('未配置曲线的指标返回 null（而不是 0，避免被当成最差成绩）', () => {
    expect(calcScore('unknown-metric', 100)).toBeNull();
    expect(calcScore(metricsName.NT, 100)).toBeNull();
  });

  it('自定义 scoreConfig 会覆盖默认曲线', () => {
    const custom = { [metricsName.FP]: { median: 6000, p10: 3000 } };
    // 同样 3000ms，在更宽松的曲线下得分更高
    expect(calcScore(metricsName.FP, 3000, custom)).toBeGreaterThan(0.5);
    expect(calcScore(metricsName.FP, 6000, custom)).toBeCloseTo(0.5, 8);
  });

  it('自定义配置只影响传入的指标，其它指标仍用默认曲线', () => {
    const custom = { [metricsName.FP]: { median: 6000, p10: 3000 } };
    expect(calcScore(metricsName.LCP, 4000, custom)).toBeCloseTo(0.5, 8);
  });
});
