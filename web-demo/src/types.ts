/** 七阶段定义（与未来 observability 事件流契约同构） */
export type Stage =
  | 'identify'
  | 'strategy'
  | 'implement'
  | 'verify'
  | 'bench'
  | 'summarize'
  | 'deliver';

export const STAGES: { key: Stage; label: string }[] = [
  { key: 'identify', label: '识别' },
  { key: 'strategy', label: '策略' },
  { key: 'implement', label: '编码' },
  { key: 'verify', label: '测试' },
  { key: 'bench', label: '基准' },
  { key: 'summarize', label: '总结' },
  { key: 'deliver', label: '交付' },
];

export const STAGE_LABEL: Record<Stage, string> = Object.fromEntries(
  STAGES.map((s) => [s.key, s.label]),
) as Record<Stage, string>;

export type RunStatus = 'running' | 'completed' | 'degraded' | 'aborted';

export type Severity = 'info' | 'success' | 'warning' | 'error';

export type EventKind =
  | 'stage_started'
  | 'stage_completed'
  | 'stage_failed'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'iteration_started'
  | 'decision'
  | 'checkpoint'
  | 'degrade'
  | 'note'
  | 'session_started'
  | 'session_message'
  | 'session_ended';

/** 会话边界/消息类事件（前端"会话直播"视图消费；与 observability.md §3 同构） */
export const SESSION_EVENT_KINDS: readonly EventKind[] = [
  'session_started',
  'session_message',
  'session_ended',
];

/** 模型消息增量：思考流 / 文本输出 */
export interface SessionMessage {
  part: 'thinking' | 'text';
  content: string;
}

export type ArtifactTab =
  | 'bench'
  | 'accuracy'
  | 'diff'
  | 'strategy'
  | 'experience'
  | 'report'
  | 'meta';

/** 检视面板的固定页签顺序（短标签，避免窄面板溢出） */
export const ARTIFACT_TABS: { key: ArtifactTab; label: string }[] = [
  { key: 'bench', label: '图表' },
  { key: 'accuracy', label: '精度' },
  { key: 'diff', label: '代码' },
  { key: 'strategy', label: '策略' },
  { key: 'experience', label: '经验' },
  { key: 'report', label: '报告' },
  { key: 'meta', label: '清单' },
];

export interface BenchData {
  baselineName: string;
  optimizedName: string;
  unit: string;
  baseline: { p50: number; p99: number };
  optimized: { p50: number; p99: number };
  gainPct: number;
  note?: string;
}

export interface DiffData {
  file: string;
  summary: string;
  diff: string;
}

export interface DocData {
  content: string;
}

export type Artifact =
  | { tab: 'bench'; title: string; data: BenchData }
  | { tab: 'accuracy'; title: string; data: unknown }
  | { tab: 'diff'; title: string; data: DiffData }
  | { tab: 'strategy'; title: string; data: DocData }
  | { tab: 'experience'; title: string; data: unknown }
  | { tab: 'report'; title: string; data: DocData }
  | { tab: 'meta'; title: string; data: unknown };

export interface ToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
}

export interface AgentEvent {
  id: string;
  /** 虚拟时间：距 run 开始的毫秒数 */
  ts: number;
  stage: Stage;
  kind: EventKind;
  title: string;
  detail?: string;
  severity?: Severity;
  /** 迭代标签，如 v1 / v2 / v3 */
  iteration?: string;
  /** 会话归属：session_* 与 tool_* 事件均可携带（无 sessionId 的事件不进会话直播视图） */
  sessionId?: string;
  /** 模型消息增量（kind=session_message 时必填） */
  message?: SessionMessage;
  tool?: ToolCall;
  artifact?: Artifact;
}

export interface RunMeta {
  id: string;
  name: string;
  /** 整网模型 / 单算子规格 */
  taskType: 'model' | 'operator';
  model?: string;
  operator?: string;
  shapeNote?: string;
  targetGainPct?: number;
  /** 展示用起始时间 HH:mm */
  startTimeLabel: string;
}

export interface Scenario {
  id: string;
  /** 模板展示名 */
  templateName: string;
  templateDesc: string;
  meta: RunMeta;
  /** 剧本总时长（虚拟毫秒） */
  durationMs: number;
  /** 按 ts 升序 */
  events: AgentEvent[];
}

/** 剧本编写辅助：以“分钟”书写时间，最终换算为毫秒；id 由 buildScenario 统一分配 */
export interface RawEvent extends Omit<AgentEvent, 'ts' | 'id'> {
  tsMin: number;
}

export const min = (v: number): number => Math.round(v * 60_000);

export function buildScenario(
  base: Omit<Scenario, 'events' | 'durationMs'>,
  raw: RawEvent[],
  durationMs: number,
): Scenario {
  const events = raw
    .map((e, i) => ({ ...e, ts: min(e.tsMin), id: `${base.id}-e${i + 1}` }))
    .sort((a, b) => a.ts - b.ts);
  return { ...base, events, durationMs };
}
