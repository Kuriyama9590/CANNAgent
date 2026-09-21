/**
 * C8：观测服务（C7 FastAPI）客户端——契约 = observability.md §5 消费面。
 * 事件 snake_case → 前端 AgentEvent 映射在此收敛（types.ts 保持 demo 同构）。
 */

export interface ServerRunListItem {
  run_id: string;
  task_name: string;
  task_type: 'model' | 'operator';
  created: string;
  status: string;
  event_count: number;
}

export interface ServerRunDetail {
  run_id: string;
  task: {
    task_name: string;
    task_type: 'model' | 'operator';
    target_gain_pct: number;
    budgets: { max_wall_min: number; max_tokens: number };
  };
  status: string;
  stages: Record<string, string>;
  artifacts: { path: string; tab: string; size: string }[];
  event_count: number;
}

/** 服务器事件（observability §5.1 骨架）——SSE 回调对外暴露 */
export interface ServerEvent {
  seq: number;
  ts?: number;
  wall_ts?: string;
  stage?: string;
  kind: string;
  title?: string;
  detail?: string;
  severity?: string;
  iteration?: string;
  sessionId?: string;
  message?: { part: 'thinking' | 'text'; content: string };
  tool?: {
    invocation_id?: string;
    name: string;
    input?: unknown;
    output?: unknown;
    duration_ms?: number;
  };
  artifact?: unknown;
}

/** 服务器事件 → 前端事件（id=seq；ts 用 wall_ts 距首事件的毫秒） */
export interface MappedEvent {
  id: string;
  ts: number;
  wallTs: number;
  stage: string;
  kind: string;
  title: string;
  detail?: string;
  severity?: string;
  iteration?: string;
  sessionId?: string;
  message?: { part: 'thinking' | 'text'; content: string };
  tool?: { name: string; input?: unknown; output?: unknown; durationMs?: number };
  artifact?: unknown;
}

const epochOf = (iso?: string): number =>
  iso ? Date.parse(iso) : 0;

export function mapEvent(e: ServerEvent, baseWallMs: number): MappedEvent {
  const wallTs = epochOf(e.wall_ts);
  return {
    id: String(e.seq),
    ts: Math.max(0, wallTs - baseWallMs),
    wallTs,
    stage: e.stage ?? 'identify',
    kind: e.kind,
    title: e.title ?? `${e.kind}`,
    detail: e.detail,
    severity: e.severity,
    iteration: e.iteration,
    sessionId: e.sessionId,
    message: e.message,
    tool: e.tool
      ? {
          name: e.tool.name,
          input: e.tool.input,
          output: e.tool.output,
          durationMs: e.tool.duration_ms,
        }
      : undefined,
    artifact: e.artifact,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
  return resp.json() as Promise<T>;
}

export function fetchRuns(): Promise<ServerRunListItem[]> {
  return getJson('/api/runs');
}

export function fetchRunDetail(rid: string): Promise<ServerRunDetail> {
  return getJson(`/api/runs/${encodeURIComponent(rid)}`);
}

export async function fetchEvents(rid: string, afterSeq = 0): Promise<{ events: ServerEvent[]; last_seq: number }> {
  return getJson(`/api/runs/${encodeURIComponent(rid)}/events?after_seq=${afterSeq}`);
}

/** SSE 订阅（observability §5 tail）；返回断开函数 */
export function subscribeEvents(
  rid: string,
  afterSeq: number,
  onEvent: (e: ServerEvent) => void,
  onState: (connected: boolean) => void,
): () => void {
  const url = `/api/runs/${encodeURIComponent(rid)}/events/stream?after_seq=${afterSeq}`;
  const es = new EventSource(url);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as ServerEvent);
    } catch {
      /* 非 JSON 行忽略（keepalive 注释不进 onmessage） */
    }
  };
  es.onopen = () => onState(true);
  es.onerror = () => onState(false);
  return () => es.close();
}
