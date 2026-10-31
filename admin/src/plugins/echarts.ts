/**
 * ECharts 按需引入：只注册看板用到的图表与组件，减小打包体积。
 * 新增图表类型时记得在这里补注册，否则会报 "Series xxx is used but not imported"。
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  LabelLayout,
  CanvasRenderer,
]);

export default echarts;
export type { EChartsCoreOption } from 'echarts/core';
export type ChartInstance = ReturnType<typeof echarts.init>;
