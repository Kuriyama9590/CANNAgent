import React, { useEffect, useMemo, useState } from 'react';
import { Empty, Segmented, Tabs, Typography } from 'antd';
import type { ArtifactTab } from '../types';
import { ARTIFACT_TABS } from '../types';
import type { ArtifactItem } from '../engine/derive';
import BenchChart from './BenchChart';
import DiffView from './DiffView';
import DocsView from './DocsView';
import JsonView from './JsonView';

interface Props {
  artifacts: ArtifactItem[];
  activeTab: ArtifactTab | null;
  onTabChange: (tab: ArtifactTab) => void;
  focusEventId: string | null;
}

const InspectorPanel: React.FC<Props> = ({
  artifacts,
  activeTab,
  onTabChange,
  focusEventId,
}) => {
  // 各页签内当前查看的产物索引（默认最新）
  const [selIdx, setSelIdx] = useState<Partial<Record<ArtifactTab, number>>>({});

  const grouped = useMemo(() => {
    const map = new Map<ArtifactTab, ArtifactItem[]>();
    for (const item of artifacts) {
      const list = map.get(item.artifact.tab) ?? [];
      list.push(item);
      map.set(item.artifact.tab, list);
    }
    return map;
  }, [artifacts]);

  const availableTabs = ARTIFACT_TABS.filter((t) => grouped.has(t.key));
  const currentTab: ArtifactTab | null =
    activeTab && grouped.has(activeTab) ? activeTab : (availableTabs[0]?.key ?? null);

  // 从时间线点击“查看产物”时，切换到对应页签并定位到该产物
  useEffect(() => {
    if (!focusEventId) return;
    for (const [tab, list] of grouped) {
      const idx = list.findIndex((a) => a.event.id === focusEventId);
      if (idx >= 0) {
        setSelIdx((prev) => ({ ...prev, [tab]: idx }));
        break;
      }
    }
  }, [focusEventId, grouped]);

  if (availableTabs.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Empty description="暂无产物，agent 产出后在此展示" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      </div>
    );
  }

  const renderTab = (tab: ArtifactTab) => {
    const list = grouped.get(tab) ?? [];
    const idx = Math.min(selIdx[tab] ?? list.length - 1, list.length - 1);
    const item = list[idx] ?? list[list.length - 1];
    if (!item) return null;

    const selector =
      list.length > 1 ? (
        <div style={{ marginBottom: 10 }}>
          <Segmented
            size="small"
            value={idx}
            onChange={(v) => setSelIdx((prev) => ({ ...prev, [tab]: v as number }))}
            options={list.map((a, i) => ({ label: a.artifact.title.split('·')[0].trim() + (list.length > 1 ? ` #${i + 1}` : ''), value: i }))}
          />
        </div>
      ) : null;

    let body: React.ReactNode = null;
    switch (item.artifact.tab) {
      case 'bench':
        body = <BenchChart data={item.artifact.data} />;
        break;
      case 'diff':
        body = <DiffView data={item.artifact.data} />;
        break;
      case 'strategy':
      case 'report':
        body = <DocsView content={item.artifact.data.content} />;
        break;
      default:
        body = <JsonView data={item.artifact.data} />;
    }

    return (
      <div>
        {selector}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {item.artifact.title}
        </Typography.Text>
        <div style={{ marginTop: 8 }}>{body}</div>
      </div>
    );
  };

  return (
    <Tabs
      size="small"
      activeKey={currentTab ?? undefined}
      onChange={(k) => onTabChange(k as ArtifactTab)}
      items={availableTabs.map((t) => ({
        key: t.key,
        label: (
          <span>
            {t.label}
            {(grouped.get(t.key)?.length ?? 0) > 1 && (
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {' '}
                ×{grouped.get(t.key)!.length}
              </Typography.Text>
            )}
          </span>
        ),
        children: renderTab(t.key),
      }))}
    />
  );
};

export default InspectorPanel;
