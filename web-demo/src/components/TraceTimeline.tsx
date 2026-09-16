import React, { useEffect, useRef, useState } from 'react';
import { Button, Empty, Tag, Typography } from 'antd';
import {
  BulbOutlined,
  CheckCircleFilled,
  ExclamationCircleFilled,
  FlagOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  StopOutlined,
  SyncOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type { AgentEvent, EventKind } from '../types';
import { wallClock } from '../util/format';

interface Props {
  events: AgentEvent[];
  startTimeLabel: string;
  onOpenArtifact: (e: AgentEvent) => void;
}

const KIND_META: Record<
  EventKind,
  { icon: React.ReactNode; label: string }
> = {
  stage_started: { icon: <PlayCircleOutlined />, label: '阶段' },
  stage_completed: { icon: <CheckCircleFilled />, label: '阶段' },
  stage_failed: { icon: <StopOutlined />, label: '阶段' },
  tool_started: { icon: <ToolOutlined />, label: '工具' },
  tool_completed: { icon: <ToolOutlined />, label: '工具' },
  tool_failed: { icon: <ToolOutlined />, label: '工具' },
  iteration_started: { icon: <SyncOutlined />, label: '迭代' },
  decision: { icon: <BulbOutlined />, label: '决策' },
  checkpoint: { icon: <FlagOutlined />, label: '检查点' },
  degrade: { icon: <ExclamationCircleFilled />, label: '降级' },
  note: { icon: <InfoCircleOutlined />, label: '备注' },
};

const SEV_COLOR: Record<string, string> = {
  success: '#52c41a',
  error: '#ff4d4f',
  warning: '#faad14',
  info: '#1677ff',
};

const EventItem: React.FC<{
  e: AgentEvent;
  startTimeLabel: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenArtifact: (e: AgentEvent) => void;
}> = ({ e, startTimeLabel, expanded, onToggle, onOpenArtifact }) => {
  const meta = KIND_META[e.kind];
  const sev = e.severity ?? 'info';
  const color = SEV_COLOR[sev] ?? 'gray';
  const hasBody = Boolean(e.tool || e.artifact);
  return (
    <div style={{ paddingBottom: 2 }}>
      <div
        onClick={hasBody ? onToggle : undefined}
        style={{ cursor: hasBody ? 'pointer' : 'default' }}
      >
        <span className="mono" style={{ fontSize: 11, opacity: 0.65, marginRight: 8 }}>
          {wallClock(startTimeLabel, e.ts)}
        </span>
        <span style={{ color, fontSize: 12, marginRight: 6 }}>{meta.icon}</span>
        {e.iteration && (
          <Tag color="geekblue" style={{ marginInlineEnd: 6, fontSize: 11, lineHeight: '16px' }}>
            {e.iteration}
          </Tag>
        )}
        <Typography.Text
          strong={e.kind.startsWith('stage') || e.kind === 'degrade'}
          style={{ fontSize: 13 }}
          type={e.severity === 'error' ? 'danger' : undefined}
        >
          {e.title}
        </Typography.Text>
      </div>
      {e.detail && (
        <div style={{ fontSize: 12, opacity: 0.78, marginTop: 2, lineHeight: 1.5 }}>
          {e.detail}
        </div>
      )}
      {expanded && e.tool && (
        <div style={{ marginTop: 6 }}>
          <Tag style={{ fontSize: 11 }}>{meta.label} · {e.tool.name}{e.tool.durationMs ? ` · ${(e.tool.durationMs / 1000).toFixed(0)}s` : ''}</Tag>
          <pre className="mono json-pre" style={{ maxHeight: 200 }}>
            {JSON.stringify(
              { 输入: e.tool.input ?? '—', 输出: e.tool.output ?? '—' },
              null,
              2,
            )}
          </pre>
        </div>
      )}
      {e.artifact && (
        <Button
          size="small"
          type="link"
          style={{ padding: 0, height: 22, fontSize: 12 }}
          onClick={(ev) => {
            ev.stopPropagation();
            onOpenArtifact(e);
          }}
        >
          查看产物 →
        </Button>
      )}
    </div>
  );
};

const TraceTimeline: React.FC<Props> = ({ events, startTimeLabel, onOpenArtifact }) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (el && followRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (events.length === 0) {
    return (
      <div className="timeline-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description="该阶段暂无事件" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  return (
    <div className="timeline-box" ref={boxRef} onScroll={onScroll}>
      {events.map((e) => {
        const sev = e.severity ?? (e.kind.endsWith('_failed') ? 'error' : 'info');
        const isStage = e.kind.startsWith('stage');
        return (
          <div
            key={e.id}
            style={{
              display: 'flex',
              gap: 10,
              padding: '7px 6px',
              borderRadius: 6,
              borderLeft: `3px solid ${isStage ? (sev === 'success' ? '#52c41a' : '#1677ff') : (SEV_COLOR[sev] ?? 'rgba(128,138,157,0.5)')}`,
              background: isStage ? 'rgba(22,119,255,0.05)' : 'transparent',
              marginBottom: 4,
            }}
          >
            <EventItem
              e={e}
              startTimeLabel={startTimeLabel}
              expanded={expandedId === e.id}
              onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
              onOpenArtifact={onOpenArtifact}
            />
          </div>
        );
      })}
    </div>
  );
};

export default TraceTimeline;
