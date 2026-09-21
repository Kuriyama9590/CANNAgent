import React from 'react';
import { Button, Popconfirm, Radio, Slider, Space, Tag } from 'antd';
import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { RunStatus } from '../types';
import { fmtElapsed } from '../util/format';

interface Props {
  playing: boolean;
  speed: number;
  cursor: number;
  duration: number;
  status: RunStatus;
  onPlay: () => void;
  onPause: () => void;
  onSeek: (ts: number) => void;
  onSpeed: (s: number) => void;
  onRestart: () => void;
  onTerminate: () => void;
}

const SPEEDS = [1, 10, 60, 300];

const ReplayBar: React.FC<Props> = ({
  playing,
  speed,
  cursor,
  duration,
  status,
  onPlay,
  onPause,
  onSeek,
  onSpeed,
  onRestart,
  onTerminate,
}) => {
  const atEnd = cursor >= duration;
  const modeTag = playing ? (
    <Tag color="processing" style={{ marginInlineEnd: 0 }}>
      <span className="pulse" style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#1677ff', marginRight: 4 }} />
      直播中
    </Tag>
  ) : status === 'degraded' ? (
    <Tag color="warning" style={{ marginInlineEnd: 0 }}>已降级</Tag>
  ) : status === 'aborted' ? (
    <Tag color="error" style={{ marginInlineEnd: 0 }}>已终止</Tag>
  ) : atEnd ? (
    <Tag color="success" style={{ marginInlineEnd: 0 }}>已结束</Tag>
  ) : (
    <Tag style={{ marginInlineEnd: 0 }}>已暂停</Tag>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      {playing ? (
        <Button icon={<PauseCircleOutlined />} onClick={onPause}>暂停</Button>
      ) : (
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          disabled={atEnd && status !== 'degraded' && status !== 'aborted'}
          onClick={onPlay}
        >
          {atEnd || status === 'degraded' || status === 'aborted' ? '重播' : '继续'}
        </Button>
      )}

      <Radio.Group
        size="small"
        optionType="button"
        buttonStyle="solid"
        value={speed}
        onChange={(e) => onSpeed(e.target.value as number)}
        options={SPEEDS.map((s) => ({ label: `${s}×`, value: s }))}
      />

      <span className="mono" style={{ fontSize: 12, opacity: 0.75, whiteSpace: 'nowrap' }}>
        {fmtElapsed(cursor)} / {fmtElapsed(duration)}
      </span>

      <div style={{ flex: 1, minWidth: 220 }}>
        <Slider
          min={0}
          max={duration}
          step={1000}
          value={cursor}
          tooltip={{ formatter: (v) => fmtElapsed(v ?? 0) }}
          onChange={(v) => onSeek(v as number)}
        />
      </div>

      <Space size={4}>
        {modeTag}
        <Button size="small" icon={<RedoOutlined />} onClick={onRestart}>
          从头播放
        </Button>
        {(status === 'running' || status === 'degraded') && (
          <Popconfirm
            title="终止该任务？"
            description="终止后保留现场，可随时从头重播"
            okText="终止"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={onTerminate}
          >
            <Button size="small" danger icon={<StopOutlined />}>
              终止
            </Button>
          </Popconfirm>
        )}
      </Space>
    </div>
  );
};

export default ReplayBar;
