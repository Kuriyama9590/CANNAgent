import React from 'react';
import { Tag, Tooltip } from 'antd';
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  ExclamationCircleFilled,
  LoadingOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons';
import type { Stage } from '../types';
import { STAGES } from '../types';
import type { StageState } from '../engine/derive';

export type StageFilter = Stage | 'all';

interface Props {
  stages: StageState[];
  selected: StageFilter;
  onSelect: (s: StageFilter) => void;
  titles: Partial<Record<Stage, string>>;
}

const STATUS_COLOR: Record<StageState['status'], string> = {
  completed: '#52c41a',
  running: '#1677ff',
  failed: '#ff4d4f',
  degraded: '#faad14',
  pending: '#b3bccc',
};

function StageIcon({ status }: { status: StageState['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircleFilled style={{ color: STATUS_COLOR.completed }} />;
    case 'running':
      return <LoadingOutlined style={{ color: STATUS_COLOR.running }} spin />;
    case 'failed':
      return <CloseCircleFilled style={{ color: STATUS_COLOR.failed }} />;
    case 'degraded':
      return <ExclamationCircleFilled style={{ color: STATUS_COLOR.degraded }} />;
    default:
      return <ClockCircleOutlined style={{ color: STATUS_COLOR.pending }} />;
  }
}

const StagePipeline: React.FC<Props> = ({ stages, selected, onSelect, titles }) => {
  const stateOf = (key: Stage) => stages.find((s) => s.key === key);
  return (
    <div className="pipe-row">
      <Tooltip title="显示全部事件">
        <div
          onClick={() => onSelect('all')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '5px 12px',
            borderRadius: 6,
            cursor: 'pointer',
            border: `1px solid ${selected === 'all' ? '#1677ff' : 'rgba(128,138,157,0.35)'}`,
            background: selected === 'all' ? 'rgba(22,119,255,0.1)' : 'transparent',
          }}
        >
          <MinusCircleOutlined />
          <span style={{ fontSize: 13 }}>全部</span>
        </div>
      </Tooltip>
      <span className="pipe-arrow">❯</span>
      {STAGES.map(({ key, label }, idx) => {
        const st = stateOf(key);
        const status = st?.status ?? 'pending';
        const iters = st?.iterations.length ?? 0;
        const active = selected === key;
        return (
          <React.Fragment key={key}>
            {idx > 0 && <span className="pipe-arrow">❯</span>}
            <Tooltip
              title={
                <div style={{ fontSize: 12 }}>
                  <div>
                    {idx + 1}/7 · {label}
                    {iters > 0 && `（${iters} 次迭代）`}
                  </div>
                  {titles[key] && <div style={{ opacity: 0.8 }}>{titles[key]}</div>}
                </div>
              }
            >
              <div
                onClick={() => onSelect(key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  border: `1px solid ${active ? '#1677ff' : 'rgba(128,138,157,0.35)'}`,
                  background: active
                    ? 'rgba(22,119,255,0.1)'
                    : status === 'running'
                      ? 'rgba(22,119,255,0.06)'
                      : 'transparent',
                }}
              >
                <span className={status === 'running' ? 'pulse' : undefined} style={{ borderRadius: '50%', display: 'inline-flex' }}>
                  <StageIcon status={status} />
                </span>
                <span style={{ fontSize: 13 }}>{label}</span>
                {iters > 1 && (
                  <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px' }}>
                    {iters}次
                  </Tag>
                )}
              </div>
            </Tooltip>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default StagePipeline;
