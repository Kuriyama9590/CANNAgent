import React, { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntdApp, Button, Segmented, Tag, Typography } from 'antd';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { useSim } from '../engine/store';
import { deriveRun } from '../engine/derive';
import type { AgentEvent, ArtifactTab, RunStatus, Stage } from '../types';
import { STAGE_LABEL } from '../types';
import StagePipeline, { type StageFilter } from '../components/StagePipeline';
import TraceTimeline from '../components/TraceTimeline';
import SessionLive from '../components/SessionLive';
import InspectorPanel from '../components/InspectorPanel';
import ReplayBar from '../components/ReplayBar';
import { nav } from '../util/nav';
import { pct } from '../util/format';
import { SESSION_EVENT_KINDS } from '../types';

const STATUS_META: Record<RunStatus, { color: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  completed: { color: 'success', text: '已完成' },
  degraded: { color: 'warning', text: '已降级' },
  aborted: { color: 'error', text: '已终止' },
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
  const [middleView, setMiddleView] = useState<'trace' | 'session'>('trace');

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
  // 轨迹视图：会话消息流不混入操作时间线（在"会话直播"视图单独呈现）
  const traceEvents = filtered.filter(
    (e) => !SESSION_EVENT_KINDS.includes(e.kind),
  );
  // 会话视图：会话边界/消息 + 带会话归属的工具调用
  const sessionEvents = filtered.filter(
    (e) => SESSION_EVENT_KINDS.includes(e.kind) || (e.sessionId !== undefined && e.kind.startsWith('tool_')),
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
        <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.text}</Tag>
        {derived.gainPct !== undefined && (
          <span className="mono" style={{ fontSize: 14, fontWeight: 650, color: '#52c41a' }}>
            {pct(derived.gainPct)}
            <span style={{ fontWeight: 400, fontSize: 11.5, opacity: 0.65, marginLeft: 4 }}>
              vs 官方
            </span>
          </span>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {run.meta.taskType === 'model' ? '整网模型' : '单算子规格'} ·{' '}
          {run.meta.model ?? `${run.meta.operator ?? ''} ${run.meta.shapeNote ?? ''}`} · 开始于{' '}
          {run.meta.startTimeLabel}
          {run.meta.targetGainPct !== undefined ? ` · 目标 +${run.meta.targetGainPct}%` : ''}
        </Typography.Text>
      </div>

      {/* 七阶段管道（点选即过滤事件） */}
      <div className="panel" style={{ padding: '10px 14px' }}>
        <StagePipeline
          stages={derived.stages}
          selected={selectedStage}
          onSelect={setSelectedStage}
          titles={stageTitles}
        />
      </div>

      {/* 直播 / 回放控制 */}
      <div className="panel" style={{ padding: '8px 14px' }}>
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
      </div>

      {/* 两区：轨迹/会话 + 产物检视 */}
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div
          className="panel"
          style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
        >
          <div className="panel-head">
            <Segmented
              size="small"
              value={middleView}
              onChange={(v) => setMiddleView(v as 'trace' | 'session')}
              options={[
                { label: '操作轨迹', value: 'trace' },
                { label: '会话直播', value: 'session' },
              ]}
            />
            {middleView === 'trace' && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {selectedStage !== 'all' ? `${STAGE_LABEL[selectedStage as Stage]} · ` : ''}
                {traceEvents.length} 条
              </Typography.Text>
            )}
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            }}
          >
            {middleView === 'trace' ? (
              <TraceTimeline
                events={traceEvents}
                startTimeLabel={run.meta.startTimeLabel}
                onOpenArtifact={onOpenArtifact}
              />
            ) : (
              <SessionLive events={sessionEvents} playing={run.playing} />
            )}
          </div>
        </div>

        <div
          className="panel"
          style={{
            width: '40%',
            minWidth: 340,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="panel-head">
            <span className="panel-title">产物检视</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 12px 12px' }}>
            <InspectorPanel
              artifacts={derived.artifacts}
              activeTab={activeTab}
              onTabChange={(t) => setActiveTab(t)}
              focusEventId={focusEventId}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default RunDetail;
