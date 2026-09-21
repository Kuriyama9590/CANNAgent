import React, { useEffect, useRef } from 'react';
// 按需引入（替代 echarts 全量 ~1MB）：本图只用 bar + grid/tooltip/legend + canvas
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { Statistic, Typography } from 'antd';
import type { BenchData } from '../types';
import { pct } from '../util/format';
import { useDark } from '../theme';

echarts.use([BarChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

interface Props {
  data: BenchData;
}

const BenchChart: React.FC<Props> = ({ data }) => {
  const dark = useDark();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    const labelColor = dark ? 'rgba(255,255,255,0.82)' : 'rgba(0,0,0,0.82)';
    const axisColor = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.4)';
    const splitColor = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)';
    const unit = data.unit;
    chart.setOption({
      grid: { left: 52, right: 20, top: 44, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => `${v} ${unit}`,
      },
      legend: { top: 4, textStyle: { color: labelColor, fontSize: 12 } },
      xAxis: {
        type: 'category',
        data: ['p50', 'p99'],
        axisLabel: { color: labelColor },
        axisLine: { lineStyle: { color: axisColor } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        name: unit,
        nameTextStyle: { color: labelColor },
        axisLabel: { color: labelColor },
        splitLine: { lineStyle: { color: splitColor } },
      },
      series: [
        {
          name: data.baselineName,
          type: 'bar',
          data: [data.baseline.p50, data.baseline.p99],
          itemStyle: { color: '#8c9bb5', borderRadius: [3, 3, 0, 0] },
          barWidth: 34,
          label: { show: true, position: 'top', color: labelColor, formatter: `{c} ${unit}` },
        },
        {
          name: data.optimizedName,
          type: 'bar',
          data: [data.optimized.p50, data.optimized.p99],
          itemStyle: { color: '#52c41a', borderRadius: [3, 3, 0, 0] },
          barWidth: 34,
          label: { show: true, position: 'top', color: labelColor, formatter: `{c} ${unit}` },
        },
      ],
    });
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [data, dark]);

  return (
    <div>
      <Statistic
        title="相对官方基线提升"
        value={pct(data.gainPct)}
        valueStyle={{ color: '#52c41a', fontWeight: 700, fontSize: 30 }}
      />
      <div ref={ref} style={{ width: '100%', height: 230, marginTop: 4 }} />
      {data.note && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {data.note}
        </Typography.Text>
      )}
    </div>
  );
};

export default BenchChart;
