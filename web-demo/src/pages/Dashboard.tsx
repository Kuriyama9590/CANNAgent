import React, { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Col,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  PlusOutlined,
  RedoOutlined,
  RightOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useSim } from '../engine/store';
import { deriveRun } from '../engine/derive';
import type { RunStatus, Stage } from '../types';
import { STAGES } from '../types';
import { nav } from '../util/nav';
import { pct } from '../util/format';

const STATUS_META: Record<RunStatus, { color: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  completed: { color: 'success', text: '已完成' },
  degraded: { color: 'warning', text: '已降级' },
  aborted: { color: 'error', text: '已终止' },
};

const SEG_COLOR: Record<string, string> = {
  completed: '#52c41a',
  running: '#1677ff',
  failed: '#ff4d4f',
  degraded: '#faad14',
  pending: 'rgba(128,138,157,0.28)',
};

const StageBar: React.FC<{ segs: { status: string }[] }> = ({ segs }) => (
  <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
    {segs.map((s, i) => (
      <Tooltip key={i} title={STAGES[i].label} placement="top">
        <div
          style={{
            flex: 1,
            height: 6,
            borderRadius: 3,
            background: SEG_COLOR[s.status] ?? SEG_COLOR.pending,
          }}
        />
      </Tooltip>
    ))}
  </div>
);

const Dashboard: React.FC = () => {
  const { runs, terminate, restart, createRun } = useSim();
  const [open, setOpen] = useState(false);
  const [tplId, setTplId] = useState('run-resnet50');
  const [name, setName] = useState('');

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

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          任务总览
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          新建模拟任务
        </Button>
      </div>

      <Row gutter={[12, 12]} style={{ marginBottom: 14 }}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="运行中"
              value={running}
              prefix={running > 0 ? <Badge status="processing" /> : undefined}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="已完成" value={completed} valueStyle={{ color: completed > 0 ? '#52c41a' : undefined }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="已降级 / 终止" value={degraded} valueStyle={{ color: degraded > 0 ? '#faad14' : undefined }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="平均提升（已完成）"
              value={avgGain === null ? '—' : pct(avgGain)}
              valueStyle={{ color: avgGain === null ? undefined : '#52c41a' }}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[12, 12]}>
        {derivedList.map(({ run, d }) => {
          const meta = STATUS_META[d.status];
          const currentLabel = d.currentStage
            ? STAGES.find((s) => s.key === d.currentStage)?.label
            : null;
          return (
            <Col xs={24} sm={12} lg={8} key={run.id}>
              <Card
                size="small"
                hoverable
                onClick={() => nav(`#/run/${run.id}`)}
                title={
                  <Space>
                    <span style={{ fontSize: 14 }}>{run.meta.name}</span>
                    <Tag color={meta.color}>{meta.text}</Tag>
                  </Space>
                }
                extra={
                  d.gainPct !== undefined ? (
                    <Typography.Text strong style={{ color: '#52c41a' }}>
                      {pct(d.gainPct)}
                    </Typography.Text>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {d.status === 'running' && currentLabel ? `进行中 · ${currentLabel}` : d.status === 'degraded' ? '等待人工介入' : '—'}
                    </Typography.Text>
                  )
                }
                actions={[
                  <Space key="ops" split={<span style={{ opacity: 0.3 }}>/</span>}>
                    <Button
                      size="small"
                      type="link"
                      icon={<RightOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        nav(`#/run/${run.id}`);
                      }}
                    >
                      查看
                    </Button>
                    {(d.status === 'running' || d.status === 'degraded') && (
                      <Popconfirm
                        title="终止该任务？"
                        description="终止后保留现场"
                        okText="终止"
                        cancelText="取消"
                        onConfirm={(e) => {
                          e?.stopPropagation();
                          terminate(run.id);
                        }}
                        onCancel={(e) => e?.stopPropagation()}
                      >
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<StopOutlined />}
                          onClick={(e) => e.stopPropagation()}
                        >
                          终止
                        </Button>
                      </Popconfirm>
                    )}
                    {(d.status === 'degraded' || d.status === 'aborted') && (
                      <Button
                        size="small"
                        type="text"
                        icon={<RedoOutlined />}
                        onClick={(e) => {
                          e.stopPropagation();
                          restart(run.id);
                          nav(`#/run/${run.id}`);
                        }}
                      >
                        重试
                      </Button>
                    )}
                  </Space>,
                ]}
              >
                <Space size={6} wrap style={{ marginBottom: 6 }}>
                  <Tag>{run.meta.taskType === 'model' ? '整网模型' : '单算子规格'}</Tag>
                  {run.meta.model && <Tag color="blue">{run.meta.model}</Tag>}
                  {run.meta.operator && <Tag color="blue">{run.meta.operator}</Tag>}
                  {run.meta.targetGainPct !== undefined && (
                    <Tag color="green">{`目标 +${run.meta.targetGainPct}%`}</Tag>
                  )}
                </Space>
                <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 2 }}>
                  开始于 {run.meta.startTimeLabel} · 阶段进度 {d.completedCount}/7
                  {run.meta.shapeNote ? ` · ${run.meta.shapeNote}` : ''}
                </div>
                <StageBar segs={d.stages.map((s) => ({ status: s.status }))} />
              </Card>
            </Col>
          );
        })}
      </Row>

      <Modal
        title="新建模拟任务"
        open={open}
        okText="创建并进入直播"
        cancelText="取消"
        onOk={() => {
          const id = createRun(tplId, name.trim() || undefined);
          setOpen(false);
          setName('');
          if (id) nav(`#/run/${id}`);
        }}
        onCancel={() => setOpen(false)}
      >
        <Radio.Group
          value={tplId}
          onChange={(e) => setTplId(e.target.value as string)}
          style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: '12px 0' }}
        >
          {[
            { id: 'run-resnet50', name: '整网模型 · resnet50', desc: 'Conv2D+BN+ReLU 融合全流程（3 轮迭代，+6.2% 达标交付）' },
            { id: 'run-swinv2', name: '整网模型 · swinv2', desc: 'SW-MHA 窗口注意力融合（2 轮迭代，+5.1%）' },
            { id: 'run-conv3x3', name: '单算子规格 · Conv3x3+BN+ReLU', desc: '小尺寸融合连续编译失败 → 降级等待人工' },
          ].map((t) => (
            <Radio key={t.id} value={t.id}>
              <div>
                <Typography.Text strong>{t.name}</Typography.Text>
                <div style={{ fontSize: 12, opacity: 0.65 }}>{t.desc}</div>
              </div>
            </Radio>
          ))}
        </Radio.Group>
        <Input
          placeholder="任务名称（可选，默认使用模板名）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Modal>
    </div>
  );
};

export default Dashboard;
