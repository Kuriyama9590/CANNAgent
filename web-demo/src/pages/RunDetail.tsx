import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntdApp, Button, Card, Menu, Space, Tag, Typography } from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  LoadingOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { useSim } from '../engine/store';
import { deriveRun } from '../engine/derive';
import type { AgentEvent, ArtifactTab, RunStatus, Stage } from '../types';
import { STAGE_LABEL } from '../types';
import StagePipeline, { type StageFilter } from '../components/StagePipeline';
import TraceTimeline from '../components/TraceTimeline';
import InspectorPanel from '../components/InspectorPanel';
import ReplayBar from '../components/ReplayBar';
import { nav } from '../util/nav';
import { pct } from '../util/format';

const STATUS_META: Record<RunStatus, { color: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  completed: { color: 'success', text: '已完成' },
  degraded: { color: 'warning', text: '已降级' },
  aborted: { color: 'error', text: '已终止' },
};

const stageMenuIcon = (status: string) => {
  switch (status) {
    case 'completed':
      return <CheckCircleOutlined style={{ color: '#52c41a' }} />;
    case 'running':
      return <LoadingOutlined style={{ color: '#1677ff' }} spin />;
    case 'failed':
      return <CloseCircleOutlined style={{ color: '#ff4d4f' }} />;
    case 'degraded':
      return <ExclamationCircleOutlined style={{ color: '#faad14' }} />;
    default:
      return <ClockCircleOutlined style={{ opacity: 0.45 }} />;
  }
};

const RunDetail: React.FC<{ id: string }> = ({ id }) => {
  const { getRun, play, pause, seek, setSpeed, restart, terminate } = useSim();
  const { notification, message } = AntdApp.useApp();

  const run = getRun(id);
  const derived = useMemo(
    () => (run ? deriveRun(run.scenario, run.cursor, run.terminated) : null),
    [run],
  );

  const [selectedStage, setSelectedStage] = useState<StageFilter>('all');
  const [activeTab, setActiveTab] = useState<ArtifactTab | null>(null);
  const [focusEventId, setFocusEventId] = useState<string | null>(null);

  const notifiedRef = useRef<Set<string>>(new Set());
  const doneNotifiedRef = useRef(false);
  const autoPlayedRef = useRef(false);

  // 打开一个进行中的 run 时自动继续直播
  useEffect(() => {
    if (!run || !derived || autoPlayedRef.current) return;
    autoPlayedRef.current = true;
    if (derived.status === 'running' && !run.playing && !run.terminated) {
      play(id);
    }
  }, [run, derived, id, play]);

  // 降级事件 → 通知
  useEffect(() => {
    if (!derived) return;
    for (const e of derived.visible) {
      if (e.kind === 'degrade' && !notifiedRef.current.has(e.id)) {
        notifiedRef.current.add(e.id);
        notification.warning({
          message: '任务已降级，等待人工介入',
          description: e.detail ?? e.title,
          placement: 'bottomRight',
          duration: 0,
        });
      }
    }
    if (
      derived.status === 'completed' &&
      derived.gainPct !== undefined &&
      !doneNotifiedRef.current
    ) {
      doneNotifiedRef.current = true;
      message.success(`任务完成：${pct(derived.gainPct)} vs 官方基线，交付包已生成`);
    }
  }, [derived, notification, message]);

  if (!run || !derived) {
    return (
      <div style={{ padding: 40 }}>
        <Typography.Text type="secondary">任务不存在或已被移除</Typography.Text>
        <Button style={{ marginLeft: 12 }} onClick={() => nav('#/')}>
          返回总览
        </Button>
      </div>
    );
  }

  const meta = STATUS_META[derived.status];
  const stageTitles: Partial<Record<Stage, string>> = {};
  for (const e of derived.visible) {
    if (
      e.kind === 'stage_completed' ||
      e.kind === 'stage_failed' ||
      e.kind === 'stage_started' ||
      e.kind === 'degrade'
    ) {
      stageTitles[e.stage] = e.title;
    }
  }

  const filtered = derived.visible.filter(
    (e) => selectedStage === 'all' || e.stage === selectedStage,
  );

  const onOpenArtifact = (e: AgentEvent) => {
    if (!e.artifact) return;
    setActiveTab(e.artifact.tab);
    setFocusEventId(e.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100vh - 96px)' }}>
      {/* 头部 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => nav('#/')}>
          总览
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {run.meta.name}
        </Typography.Title>
        <Tag color={meta.color}>{meta.text}</Tag>
        {derived.gainPct !== undefined && (
          <Tag color="green" style={{ fontSize: 13 }}>
            {pct(derived.gainPct)} vs 官方
          </Tag>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {run.meta.taskType === 'model' ? '整网模型' : '单算子规格'} ·{' '}
          {run.meta.model ?? `${run.meta.operator ?? ''} ${run.meta.shapeNote ?? ''}`} · 开始于{' '}
          {run.meta.startTimeLabel}
          {run.meta.targetGainPct !== undefined ? ` · 目标 +${run.meta.targetGainPct}%` : ''}
        </Typography.Text>
      </div>

      {/* 七阶段管道 */}
      <Card size="small">
        <StagePipeline
          stages={derived.stages}
          selected={selectedStage}
          onSelect={setSelectedStage}
          titles={stageTitles}
        />
      </Card>

      {/* 直播 / 回放控制 */}
      <Card size="small">
        <ReplayBar
          playing={run.playing}
          speed={run.speed}
          cursor={run.cursor}
          duration={run.scenario.durationMs}
          status={derived.status}
          onPlay={() => play(id)}
          onPause={() => pause(id)}
          onSeek={(ts) => {
            pause(id);
            seek(id, ts);
          }}
          onSpeed={(s) => setSpeed(id, s)}
          onRestart={() => {
            restart(id);
            notifiedRef.current.clear();
            doneNotifiedRef.current = false;
          }}
          onTerminate={() => {
            terminate(id);
            message.warning('任务已终止，现场已保留');
          }}
        />
      </Card>

      {/* 三栏：阶段树 / 轨迹 / 检视 */}
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <Card size="small" title="阶段" style={{ width: 190, flexShrink: 0 }}>
          <Menu
            mode="inline"
            style={{ border: 'none', padding: 0 }}
            selectedKeys={[selectedStage]}
            onClick={({ key }) => setSelectedStage(key as StageFilter)}
            items={[
              { key: 'all', icon: <UnorderedListOutlined />, label: '全部事件' },
              ...derived.stages.map((s) => ({
                key: s.key,
                icon: stageMenuIcon(s.status),
                label: (
                  <Space size={4}>
                    <span>{STAGE_LABEL[s.key]}</span>
                    {s.iterations.length > 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        {s.iterations.length > 1
                          ? `${s.iterations.length}次`
                          : s.iterations[0]}
                      </Typography.Text>
                    )}
                  </Space>
                ),
              })),
            ]}
          />
        </Card>

        <Card
          size="small"
          title={`操作轨迹${selectedStage !== 'all' ? ` · ${STAGE_LABEL[selectedStage as Stage]}` : ''}（${filtered.length} 条）`}
          style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
          styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' } }}
        >
          <TraceTimeline
            events={filtered}
            startTimeLabel={run.meta.startTimeLabel}
            onOpenArtifact={onOpenArtifact}
          />
        </Card>

        <Card
          size="small"
          title="产物检视"
          style={{ width: '38%', minWidth: 340, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
          styles={{ body: { flex: 1, minHeight: 0, overflow: 'auto' } }}
        >
          <InspectorPanel
            artifacts={derived.artifacts}
            activeTab={activeTab}
            onTabChange={(t) => setActiveTab(t)}
            focusEventId={focusEventId}
          />
        </Card>
      </div>
    </div>
  );
};

export default RunDetail;
