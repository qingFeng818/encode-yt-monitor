import type { EChartsCoreOption } from 'echarts/core';
import type { ErrorTypeStat, PvDaily, PvRoute } from '@/types/monitor';
import { formatDayLabel } from './format';

/**
 * ECharts option 构造器（纯函数）。
 *
 * 颜色固定为「亮色/暗色都可用」的中高饱和色板；文字、坐标轴、分割线颜色
 * 交给 ECharts 内置的 dark 主题处理，所以这里不读取 CSS 变量。
 */
const PALETTE = ['#ef4444', '#f59e0b', '#8b5cf6', '#3b82f6', '#10b981', '#06b6d4', '#ec4899', '#84cc16'];

const baseTextStyle = {
  fontFamily: "'Inter', 'PingFang SC', 'Microsoft YaHei', sans-serif",
};

/** PV / UV 日趋势（双折线） */
export function buildPvTrendOption(daily: PvDaily[]): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    color: ['#3b82f6', '#8b5cf6'],
    textStyle: baseTextStyle,
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    legend: {
      right: 4,
      top: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
    },
    grid: { left: 8, right: 18, top: 44, bottom: 6, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: daily.map((item) => item.day),
      axisTick: { show: false },
      // 轴标签只留 MM-DD，tooltip 里仍然是完整日期
      axisLabel: { hideOverlap: true, fontSize: 11, formatter: (value: string) => formatDayLabel(value) },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { type: 'dashed' } },
      axisLabel: { fontSize: 11 },
    },
    series: [
      {
        name: 'PV',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: daily.length <= 14,
        data: daily.map((item) => item.pv),
        lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.12 },
      },
      {
        name: 'UV',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: daily.length <= 14,
        data: daily.map((item) => item.uv),
        lineStyle: { width: 2.5 },
      },
    ],
  };
}

/** 错误类型分布（环形图） */
export function buildErrorTypeOption(stats: ErrorTypeStat[]): EChartsCoreOption {
  return {
    backgroundColor: 'transparent',
    color: PALETTE,
    textStyle: baseTextStyle,
    tooltip: {
      trigger: 'item',
      formatter: '{b}<br/>错误数：{c}（{d}%）',
    },
    legend: {
      type: 'scroll',
      orient: 'vertical',
      right: 0,
      top: 'middle',
      icon: 'circle',
      itemWidth: 9,
      itemHeight: 9,
      itemGap: 12,
      formatter: (name: string) => (name.length > 18 ? `${name.slice(0, 17)}…` : name),
    },
    series: [
      {
        name: '错误类型',
        type: 'pie',
        radius: ['48%', '72%'],
        center: ['32%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderWidth: 3, borderColor: 'transparent', borderRadius: 6 },
        label: { show: false },
        labelLine: { show: false },
        emphasis: {
          scale: true,
          scaleSize: 6,
          label: { show: true, fontWeight: 600, formatter: '{b}\n{d}%' },
        },
        data: stats.map((item) => ({ name: item.type, value: item.count })),
      },
    ],
  };
}

/** 路由 PV / UV 排行（横向分组柱状图） */
export function buildTopRouteOption(routes: PvRoute[]): EChartsCoreOption {
  const reversed = [...routes].reverse();

  return {
    backgroundColor: 'transparent',
    color: ['#3b82f6', '#a78bfa'],
    textStyle: baseTextStyle,
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: {
      right: 4,
      top: 0,
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
      itemGap: 16,
    },
    grid: { left: 8, right: 30, top: 40, bottom: 6, containLabel: true },
    xAxis: {
      type: 'value',
      splitLine: { lineStyle: { type: 'dashed' } },
      axisLabel: { fontSize: 11 },
    },
    yAxis: {
      type: 'category',
      data: reversed.map((item) => item.route),
      axisTick: { show: false },
      axisLabel: { fontSize: 11, width: 160, overflow: 'truncate' },
    },
    series: [
      {
        name: 'PV',
        type: 'bar',
        barMaxWidth: 12,
        itemStyle: { borderRadius: [0, 5, 5, 0] },
        data: reversed.map((item) => item.pv),
      },
      {
        name: 'UV',
        type: 'bar',
        barMaxWidth: 12,
        itemStyle: { borderRadius: [0, 5, 5, 0] },
        data: reversed.map((item) => item.uv),
      },
    ],
  };
}
