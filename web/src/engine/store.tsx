/**
 * C8：服务器版 run 状态（替代 demo 的剧本引擎——组件契约不变）。
 * - 列表轮询 /api/runs；打开 run 拉全量事件 → 伪 scenario 喂 derive.ts（组件零改动）
 * - 回放：本地 cursor 在已取事件上游走；实时：SSE 追加（cursor 跟随尾部）
 * - createRun/terminate 无服务端端点（v1）：terminate=断开实时订阅
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AgentEvent, RunMeta, Scenario } from '../types';
import {
  fetchEvents,
  fetchRunDetail,
  fetchRuns,
  mapEvent,
  subscribeEvents,
} from '../api/client';
import type { ServerEvent } from '../api/client';

export interface SimRun {
  id: string;
  meta: RunMeta;
  scenario: Scenario;
  /** 回放游标（ms，相对首事件） */
  cursor: number;
  playing: boolean;
  speed: number;
  terminated: boolean;
  connected: boolean;
  lastSeq: number;
}

interface SimCtx {
  runs: SimRun[];
  serverStatus: 'connecting' | 'up' | 'down';
  getRun: (id: string | undefined) => SimRun | undefined;
  play: (id: string) => void;
  pause: (id: string) => void;
  seek: (id: string, ts: number) => void;
  setSpeed: (id: string, speed: number) => void;
  restart: (id: string) => void;
  terminate: (id: string) => void;
  refresh: () => void;
}

const Ctx = createContext<SimCtx | null>(null);

function buildMeta(rid: string, name: string, taskType: string): RunMeta {
  const hhmm = rid.length >= 14 ? `${rid.slice(10, 12)}:${rid.slice(12, 14)}` : '--:--';
  return {
    id: rid,
    name,
    taskType: taskType === 'model' ? 'model' : 'operator',
    startTimeLabel: hhmm,
  };
}

function toScenario(meta: RunMeta, events: AgentEvent[]): Scenario {
  const last = events[events.length - 1];
  return {
    id: meta.id,
    templateName: 'live',
    templateDesc: '',
    meta,
    durationMs: Math.max(1, last?.ts ?? 1),
    events,
  };
}

export const SimProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [runs, setRuns] = useState<SimRun[]>([]);
  const [serverStatus, setServerStatus] = useState<'connecting' | 'up' | 'down'>('connecting');
  const runsRef = useRef<SimRun[]>([]);
  const subsRef = useRef(new Map<string, () => void>());
  const openedRef = useRef(new Set<string>());

  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  const openRun = useCallback(async (rid: string) => {
    if (openedRef.current.has(rid)) return;
    openedRef.current.add(rid);
    try {
      const [{ events: serverEvents, last_seq: lastSeq }, detail] = await Promise.all([
        fetchEvents(rid, 0),
        fetchRunDetail(rid).catch(() => undefined),
      ]);
      const base = serverEvents.length ? Date.parse(serverEvents[0]?.wall_ts ?? '') : 0;
      const mapped = serverEvents.map((e) => mapEvent(e, base)) as unknown as AgentEvent[];
      const meta = buildMeta(rid, detail?.task.task_name ?? rid, detail?.task.task_type ?? 'operator');
      if (detail) meta.targetGainPct = detail.task.target_gain_pct;
      const live = detail?.status === 'running';
      const scenario = toScenario(meta, mapped);
      setRuns((prev) => [
        ...prev.filter((r) => r.id !== rid),
        {
          id: rid,
          meta,
          scenario,
          cursor: live ? scenario.durationMs : scenario.durationMs,
          playing: live,
          speed: 1,
          terminated: false,
          connected: false,
          lastSeq: lastSeq ?? serverEvents.length,
        },
      ]);
    } catch {
      openedRef.current.delete(rid);
    }
  }, []);

  const refresh = useCallback(() => {
    fetchRuns()
      .then((list) => {
        setServerStatus('up');
        for (const item of list) {
          if (!openedRef.current.has(item.run_id)) void openRun(item.run_id);
        }
      })
      .catch(() => setServerStatus('down'));
  }, [openRun]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // 实时订阅：未断开的 run 各一条 SSE（增量追加）
  useEffect(() => {
    for (const run of runs) {
      if (run.terminated || subsRef.current.has(run.id)) continue;
      const rid = run.id;
      const stop = subscribeEvents(
        rid,
        run.lastSeq,
        (e: ServerEvent) => {
          setRuns((prev) =>
            prev.map((r) => {
              if (r.id !== rid) return r;
              const mapped = mapEvent(e, 0) as unknown as AgentEvent;
              const events = [...r.scenario.events, mapped];
              const durationMs = Math.max(r.scenario.durationMs, mapped.ts);
              const atTail = r.cursor >= r.scenario.durationMs - 1;
              return {
                ...r,
                lastSeq: Math.max(r.lastSeq, Number(e.seq ?? r.lastSeq)),
                scenario: { ...r.scenario, events, durationMs },
                cursor: r.playing && atTail ? durationMs : r.cursor,
              };
            }),
          );
        },
        (connected) => {
          setRuns((prev) => prev.map((r) => (r.id === rid ? { ...r, connected } : r)));
        },
      );
      subsRef.current.set(rid, stop);
    }
  }, [runs]);

  // 回放游标推进（500ms 心跳 × speed）
  useEffect(() => {
    if (!runs.some((r) => r.playing)) return;
    const timer = window.setInterval(() => {
      setRuns((prev) =>
        prev.map((r) => {
          if (!r.playing) return r;
          const next = r.cursor + 500 * r.speed;
          const done = next >= r.scenario.durationMs;
          return { ...r, cursor: Math.min(next, r.scenario.durationMs), playing: !done || r.connected };
        }),
      );
    }, 500);
    return () => window.clearInterval(timer);
  }, [runs]);

  useEffect(
    () => () => {
      for (const stop of subsRef.current.values()) stop();
      subsRef.current.clear();
    },
    [],
  );

  const getRun = useCallback((id: string | undefined) => (id ? runs.find((r) => r.id === id) : undefined), [runs]);

  const patch = useCallback((id: string, part: Partial<SimRun>) => {
    setRuns((prev) => prev.map((r) => (r.id === id ? { ...r, ...part } : r)));
  }, []);

  const value = useMemo<SimCtx>(
    () => ({
      runs,
      serverStatus,
      getRun,
      play: (id) => patch(id, { playing: true }),
      pause: (id) => patch(id, { playing: false }),
      seek: (id, ts) => patch(id, { cursor: ts, playing: false }),
      setSpeed: (id, speed) => patch(id, { speed }),
      restart: (id) => patch(id, { cursor: 0, playing: true }),
      terminate: (id) => {
        subsRef.current.get(id)?.();
        subsRef.current.delete(id);
        patch(id, { terminated: true, playing: false, connected: false });
      },
      refresh,
    }),
    [runs, serverStatus, getRun, patch, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useSim(): SimCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('SimProvider missing');
  return ctx;
}
