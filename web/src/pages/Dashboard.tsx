import React, { useMemo } from 'react';
import {
  Badge,
  Button,
  Popconfirm,
  Typography,
} from 'antd';
import {
  RedoOutlined,
  StopOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { useSim } from '../engine/store';
import { deriveRun } from '../engine/derive';
import type { RunStatus } from '../types';
import { STAGES } from '../types';
import { nav } from '../util/nav';
import { pct } from '../util/format';

const STATUS_META: Record<RunStatus, { color: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  completed: { color: 'success', text: '已完成' },
  degraded: { color: 'warning', text: '已降级' },
  aborted: { color: 'error', text: '已终止' },
};

const STATUS_DOT: Record<RunStatus, string> = {
  running: '#06b6d4',
  completed: '#52c41a',
  degraded: '#faad14',
  aborted: '#ff4d4f',
};

const SEG_COLOR: Record<string, string> = {
  completed: '#52c41a',
  running: '#06b6d4',
  failed: '#ff4d4f',
  degraded: '#faad14',
  pending: 'rgba(128,138,157,0.24)',
};

const StageBar: React.FC<{ segs: { status: string }[] }> = ({ segs }) => (
  <div style={{ display: 'flex', gap: 3, marginTop: 8 }}>
    {segs.map((s, i) => (
      <div
        key={i}
        title={STAGES[i].label}
        style={{
          flex: 1,
          height: 4,
          borderRadius: 2,
          background: SEG_COLOR[s.status] ?? SEG_COLOR.pending,
        }}
      />
    ))}
  </div>
);

const Dashboard: React.FC = () => {
  const { runs, terminate, restart, serverStatus, refresh } = useSim();

  const derivedList = useMemo(
    () =>
      runs.map((r) => ({
        run: r,
        d: deriveRun(r.scenario, r.cursor, r.terminated),
      })),
    [runs],
  );

  const running = derivedList.filter((x) => x.d.status === 'running').length;
  const completed = derivedList.filter((x) => x.d.status === 'completed').length;
  const degraded = derivedList.filter((x) => x.d.status === 'degraded' || x.d.status === 'aborted').length;
  const gains = derivedList.filter((x) => x.d.status === 'completed' && x.d.gainPct !== undefined).map((x) => x.d.gainPct!);
  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / gains.length : null;

  const stats: { label: string; value: string; color?: string }[] = [
    { label: '运行中', value: String(running), color: running > 0 ? '#06b6d4' : undefined },
    { label: '已完成', value: String(completed), color: completed > 0 ? '#52c41a' : undefined },
    { label: '降级 / 终止', value: String(degraded), color: degraded > 0 ? '#faad14' : undefined },
    { label: '平均提升（已完成）', value: avgGain === null ? '—' : pct(avgGain), color: avgGain === null ? undefined : '#52c41a' },
  ];

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0, fontWeight: 600 }}>
          任务总览
        </Typography.Title>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Badge
            status={serverStatus === 'up' ? 'processing' : serverStatus === 'down' ? 'error' : 'warning'}
            text={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {serverStatus === 'up' ? '观测服务已连接' : serverStatus === 'down' ? '观测服务不可达（python -m cannagent.server）' : '连接中…'}
              </Typography.Text>
            }
          />
          <Button size="small" icon={<SyncOutlined />} onClick={refresh}>
            刷新
          </Button>
        </div>
      </div>

      <div className="stat-strip">
        {stats.map((s) => (
          <div key={s.label} className="stat-item">
            <div className="stat-value" style={s.color ? { color: s.color } : undefined}>
              {s.value}
            </div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="run-list">
        {derivedList.map(({ run, d }) => {
          const meta = STATUS_META[d.status];
          const currentLabel = d.currentStage
            ? STAGES.find((s) => s.key === d.currentStage)?.label
            : null;
          const sub =
            run.meta.taskType === 'model' ? '整网模型' : '单算子规格';
          return (
            <div
              key={run.id}
              className="run-row"
              onClick={() => nav(`#/run/${run.id}`)}
            >
              <div className="run-accent" style={{ background: STATUS_DOT[d.status] }} />
              <div style={{ flex: 1, minWidth: 0, padding: '13px 18px 13px 14px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 10,
                    flexWrap: 'wrap',
                  }}
                >
                  <Typography.Text strong style={{ fontSize: 14 }}>
                    {run.meta.name}
                  </Typography.Text>
                  <span
                    style={{
                      fontSize: 11,
                      color: STATUS_DOT[d.status],
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: STATUS_DOT[d.status],
                        display: 'inline-block',
                      }}
                    />
                    {meta.text}
                  </span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {sub} · {run.meta.model ?? run.meta.operator ?? ''}
                    {run.meta.shapeNote ? ` · ${run.meta.shapeNote}` : ''}
                  </Typography.Text>
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  开始于 {run.meta.startTimeLabel} · 阶段进度 {d.completedCount}/7
                  {run.meta.targetGainPct !== undefined
                    ? ` · 目标 +${run.meta.targetGainPct}%`
                    : ''}
                  {d.status === 'degraded' ? ' · 等待人工介入' : ''}
                </Typography.Text>
                <StageBar segs={d.stages.map((s) => ({ status: s.status }))} />
              </div>
              <div
                style={{
                  flexShrink: 0,
                  textAlign: 'right',
                  padding: '0 16px 0 10px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-end',
                  gap: 6,
                }}
              >
                {d.gainPct !== undefined ? (
                  <span
                    className="mono"
                    style={{ fontSize: 20, fontWeight: 650, color: '#52c41a' }}
                  >
                    {pct(d.gainPct)}
                  </span>
                ) : (
                  <span
                    className="mono"
                    style={{ fontSize: 12, opacity: 0.6 }}
                  >
                    {d.status === 'running' && currentLabel
                      ? `→ ${currentLabel}`
                      : d.status === 'running'
                        ? '· · ·'
                        : '—'}
                  </span>
                )}
                <div style={{ display: 'flex', gap: 2 }} onClick={(e) => e.stopPropagation()}>
                  {(d.status === 'running' || d.status === 'degraded') && (
                    <Popconfirm
                      title="终止该任务？"
                      description="终止后保留现场"
                      okText="终止"
                      cancelText="取消"
                      onConfirm={() => terminate(run.id)}
                      onCancel={(e) => e?.stopPropagation()}
                    >
                      <Button size="small" type="text" danger icon={<StopOutlined />}>
                        终止
                      </Button>
                    </Popconfirm>
                  )}
                  {(d.status === 'degraded' || d.status === 'aborted') && (
                    <Button
                      size="small"
                      type="text"
                      icon={<RedoOutlined />}
                      onClick={() => {
                        restart(run.id);
                        nav(`#/run/${run.id}`);
                      }}
                    >
                      重试
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {derivedList.length === 0 && (
        <div
          style={{
            padding: '48px 0',
            textAlign: 'center',
            opacity: 0.65,
          }}
        >
          <Typography.Text type="secondary">
            {serverStatus === 'down'
              ? '无法连接观测服务——先启动：python -m cannagent.server（C7）'
              : '暂无 run——创建任务见 python CLI：python -m cannagent runs'}
          </Typography.Text>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
