import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Divider, Empty, Space, Tag, Typography } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  LoadingOutlined,
  RobotOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type { AgentEvent } from '../types';
import { STAGE_LABEL } from '../types';

/** 会话直播：按 dsh session 分组渲染 思考 / 输出 / 工具调用（仅含有 sessionId 的事件） */

interface SessionGroup {
  sessionId: string;
  label: string;
  stageLabel: string;
  /** 会话当前是否仍在推进（未见 session_ended） */
  open: boolean;
  endNote?: string;
  items: AgentEvent[];
}

const TOOL_KINDS = new Set(['tool_started', 'tool_completed', 'tool_failed']);

function fmtDur(ms?: number): string {
  if (ms === undefined) return '';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function groupSessions(events: AgentEvent[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const e of events) {
    if (!e.sessionId) continue;
    const isSessionLifecycle =
      e.kind === 'session_started' || e.kind === 'session_ended' || e.kind === 'session_message';
    if (!isSessionLifecycle && !TOOL_KINDS.has(e.kind)) continue;
    let g = groups.get(e.sessionId);
    if (!g) {
      g = {
        sessionId: e.sessionId,
        label: e.sessionId,
        stageLabel: STAGE_LABEL[e.stage],
        open: true,
        items: [],
      };
      groups.set(e.sessionId, g);
    }
    if (e.kind === 'session_started') {
      g.label = e.title || e.sessionId;
      if (e.detail) g.stageLabel = e.detail;
    } else if (e.kind === 'session_ended') {
      g.open = false;
      g.endNote = e.title;
    } else {
      g.items.push(e);
    }
  }
  return [...groups.values()];
}

const MessageItem: React.FC<{ event: AgentEvent }> = ({ event }) => {
  if (!event.message) return null;
  if (event.message.part === 'thinking') {
    return (
      <div style={{ padding: '2px 0' }}>
        <Typography.Paragraph
          type="secondary"
          style={{ marginBottom: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}
          ellipsis={{ rows: 3, expandable: true, symbol: '展开思考' }}
        >
          <Tag style={{ marginRight: 6 }}>思考</Tag>
          {event.message.content}
        </Typography.Paragraph>
      </div>
    );
  }
  return (
    <Typography.Paragraph
      style={{ marginBottom: 4, whiteSpace: 'pre-wrap' }}
      ellipsis={{ rows: 6, expandable: true, symbol: '展开' }}
    >
      {event.message.content}
    </Typography.Paragraph>
  );
};

const ToolItem: React.FC<{ event: AgentEvent }> = ({ event }) => {
  const tool = event.tool;
  const name = tool?.name ?? 'unknown';
  const dur = fmtDur(tool?.durationMs);
  if (event.kind === 'tool_started') {
    return (
      <Space size={6} style={{ padding: '2px 0', fontSize: 12 }}>
        <LoadingOutlined spin style={{ color: '#1677ff' }} />
        <Typography.Text type="secondary">调用 {name}…</Typography.Text>
      </Space>
    );
  }
  if (event.kind === 'tool_failed') {
    return (
      <Space size={6} style={{ padding: '2px 0', fontSize: 12 }} wrap>
        <CloseCircleOutlined style={{ color: '#ff4d4f' }} />
        <Typography.Text type="danger">
          {name} 失败{dur ? `（${dur}）` : ''}
        </Typography.Text>
        {event.detail && <Typography.Text type="secondary">{event.detail}</Typography.Text>}
      </Space>
    );
  }
  return (
    <Space size={6} style={{ padding: '2px 0', fontSize: 12 }} wrap>
      <CheckCircleOutlined style={{ color: '#52c41a' }} />
      <Typography.Text>{name}</Typography.Text>
      {dur && <Typography.Text type="secondary">（{dur}）</Typography.Text>}
      {event.title && <Typography.Text type="secondary">· {event.title}</Typography.Text>}
    </Space>
  );
};

const SessionLive: React.FC<{ events: AgentEvent[]; playing: boolean }> = ({
  events,
  playing,
}) => {
  const groups = useMemo(() => groupSessions(events), [events]);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 直播时自动跟随滚动（用户上翻则暂停跟随）
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length, playing]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  if (groups.length === 0) {
    return (
      <div style={{ padding: 24 }}>
        <Empty description="当前区间暂无会话事件（该剧本未编排 dsh 会话流）" />
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      onScroll={onScroll}
      style={{ height: '100%', overflow: 'auto', padding: '10px 14px' }}
    >
      {groups.map((g) => (
        <div
          key={g.sessionId}
          style={{
            border: '1px solid',
            borderColor: 'rgba(128,128,128,0.25)',
            borderRadius: 8,
            padding: '8px 12px',
            marginBottom: 10,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              marginBottom: 4,
            }}
          >
            <RobotOutlined />
            <Typography.Text strong style={{ fontSize: 13 }}>
              {g.label}
            </Typography.Text>
            <Tag style={{ fontSize: 11 }}>{g.stageLabel}</Tag>
            {g.open ? (
              <Tag icon={<LoadingOutlined spin />} color="processing" style={{ fontSize: 11 }}>
                进行中
              </Tag>
            ) : (
              <Tag icon={<CheckCircleOutlined />} style={{ fontSize: 11 }}>
                已结束
              </Tag>
            )}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {g.sessionId}
            </Typography.Text>
          </div>
          {g.items.map((e) =>
            e.message ? (
              <MessageItem key={e.id} event={e} />
            ) : (
              <ToolItem key={e.id} event={e} />
            ),
          )}
          {!g.open && g.endNote && (
            <>
              <Divider style={{ margin: '6px 0' }} dashed>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {g.endNote}
                </Typography.Text>
              </Divider>
            </>
          )}
          {g.open && playing && (
            <Space size={6} style={{ fontSize: 11 }}>
              <ThunderboltOutlined style={{ color: '#faad14' }} />
              <Typography.Text type="secondary">会话进行中…</Typography.Text>
            </Space>
          )}
        </div>
      ))}
    </div>
  );
};

export default SessionLive;
