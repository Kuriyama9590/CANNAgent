import type {
  AgentEvent,
  Artifact,
  RunStatus,
  Scenario,
  Stage,
} from '../types';
import { STAGES } from '../types';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'degraded';

export interface StageState {
  key: Stage;
  status: StageStatus;
  /** 该阶段出现过的迭代标签（按首次出现顺序） */
  iterations: string[];
  title?: string;
}

export interface ArtifactItem {
  event: AgentEvent;
  artifact: Artifact;
}

export interface Derived {
  visible: AgentEvent[];
  stages: StageState[];
  currentStage: Stage | null;
  completedCount: number;
  status: RunStatus;
  degraded: boolean;
  gainPct?: number;
  artifacts: ArtifactItem[];
}

const STAGE_KEYS = STAGES.map((s) => s.key);

export function deriveRun(
  scenario: Scenario,
  cursor: number,
  terminated: boolean,
): Derived {
  const visible = scenario.events.filter((e) => e.ts <= cursor);

  // 逐阶段扫描可见事件，后者覆盖前者
  const stateMap = new Map<Stage, StageState>(
    STAGE_KEYS.map((k) => [k, { key: k, status: 'pending' as StageStatus, iterations: [] }]),
  );
  let currentStage: Stage | null = null;
  let degraded = false;

  for (const e of visible) {
    const st = stateMap.get(e.stage);
    if (!st) continue;
    if (e.iteration && !st.iterations.includes(e.iteration)) {
      st.iterations.push(e.iteration);
    }
    switch (e.kind) {
      case 'stage_started':
        st.status = 'running';
        currentStage = e.stage;
        break;
      case 'stage_completed':
        st.status = 'completed';
        if (currentStage === e.stage) currentStage = null;
        break;
      case 'stage_failed':
        st.status = 'failed';
        if (currentStage === e.stage) currentStage = null;
        break;
      case 'tool_failed':
        // 阶段内失败但仍在迭代，标记为 running（除非已降级）
        if (st.status !== 'degraded') st.status = 'running';
        break;
      case 'degrade':
        degraded = true;
        st.status = 'degraded';
        if (currentStage === e.stage) currentStage = null;
        break;
      default:
        break;
    }
  }

  // 迭代中若阶段尚未终结且未降级 → running（如 tool_failed 后 patch 继续）
  if (currentStage) {
    const st = stateMap.get(currentStage);
    if (st && st.status !== 'degraded') st.status = 'running';
  }

  const stages = STAGE_KEYS.map((k) => stateMap.get(k)!);
  const completedCount = stages.filter((s) => s.status === 'completed').length;

  const artifacts: ArtifactItem[] = [];
  for (const e of visible) {
    if (e.artifact) artifacts.push({ event: e, artifact: e.artifact });
  }

  const benchArtifacts = artifacts.filter((a) => a.artifact.tab === 'bench');
  const lastBench = benchArtifacts[benchArtifacts.length - 1];
  const gainPct =
    lastBench && lastBench.artifact.tab === 'bench'
      ? lastBench.artifact.data.gainPct
      : undefined;

  const atEnd = cursor >= scenario.durationMs;
  let status: RunStatus;
  if (terminated) status = 'aborted';
  else if (degraded) status = 'degraded';
  else if (atEnd) status = 'completed';
  else status = 'running';

  return {
    visible,
    stages,
    currentStage,
    completedCount,
    status,
    degraded,
    gainPct,
    artifacts,
  };
}

export function stageIndexOf(key: Stage | null): number {
  if (!key) return -1;
  return STAGE_KEYS.indexOf(key);
}
