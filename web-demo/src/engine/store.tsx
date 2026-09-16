import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { RunMeta, Scenario } from '../types';
import { min } from '../types';
import {
  conv3x3Scenario,
  resnet50Scenario,
  scenarioById,
  swinv2Scenario,
} from '../scenarios';
import { RESNET_INITIAL_CURSOR_MIN } from '../scenarios/resnet50';

export interface SimRun {
  id: string;
  meta: RunMeta;
  scenario: Scenario;
  /** 虚拟时间光标（ms） */
  cursor: number;
  playing: boolean;
  speed: number;
  terminated: boolean;
  templateId?: string;
}

interface SimCtx {
  runs: SimRun[];
  getRun: (id: string | undefined) => SimRun | undefined;
  play: (id: string) => void;
  pause: (id: string) => void;
  seek: (id: string, ts: number) => void;
  setSpeed: (id: string, speed: number) => void;
  restart: (id: string) => void;
  terminate: (id: string) => void;
  createRun: (templateId: string, name?: string) => string;
}

const Ctx = createContext<SimCtx | null>(null);
const TICK_MS = 250;

function makeRun(
  scenario: Scenario,
  cursor: number,
  playing = false,
  id?: string,
): SimRun {
  const runId = id ?? scenario.id;
  return {
    id: runId,
    meta: { ...scenario.meta, id: runId },
    scenario,
    cursor: Math.min(cursor, scenario.durationMs),
    playing,
    speed: 60,
    terminated: false,
    templateId: scenario.id,
  };
}

function initialRuns(): SimRun[] {
  return [
    // resnet50：停在 v3 复测前，仪表盘呈现“运行中 · 测试 4/7”，进入详情可继续直播
    makeRun(resnet50Scenario, min(RESNET_INITIAL_CURSOR_MIN)),
    makeRun(swinv2Scenario, swinv2Scenario.durationMs),
    makeRun(conv3x3Scenario, conv3x3Scenario.durationMs),
  ];
}

export const SimProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [runs, setRuns] = useState<SimRun[]>(initialRuns);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRuns((prev) => {
        let changed = false;
        const next = prev.map((r) => {
          if (!r.playing) return r;
          changed = true;
          const cursor = Math.min(r.cursor + TICK_MS * r.speed, r.scenario.durationMs);
          return { ...r, cursor, playing: cursor < r.scenario.durationMs };
        });
        return changed ? next : prev;
      });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const update = useCallback(
    (id: string, patch: (r: SimRun) => SimRun) => {
      setRuns((prev) => prev.map((r) => (r.id === id ? patch(r) : r)));
    },
    [],
  );

  const play = useCallback((id: string) => update(id, (r) => ({ ...r, playing: r.cursor < r.scenario.durationMs && !r.terminated })), [update]);
  const pause = useCallback((id: string) => update(id, (r) => ({ ...r, playing: false })), [update]);
  const seek = useCallback(
    (id: string, ts: number) =>
      update(id, (r) => ({
        ...r,
        cursor: Math.max(0, Math.min(ts, r.scenario.durationMs)),
        terminated: false,
      })),
    [update],
  );
  const setSpeed = useCallback((id: string, speed: number) => update(id, (r) => ({ ...r, speed })), [update]);
  const restart = useCallback(
    (id: string) => update(id, (r) => ({ ...r, cursor: 0, playing: true, terminated: false })),
    [update],
  );
  const terminate = useCallback(
    (id: string) => update(id, (r) => ({ ...r, playing: false, terminated: true })),
    [update],
  );

  const createRun = useCallback((templateId: string, name?: string) => {
    const tpl = scenarioById(templateId);
    if (!tpl) return '';
    const id = `run-${Date.now().toString(36)}`;
    const meta: RunMeta = name ? { ...tpl.meta, id, name } : { ...tpl.meta, id };
    const run: SimRun = {
      id,
      meta,
      scenario: tpl,
      cursor: 0,
      playing: true,
      speed: 60,
      terminated: false,
      templateId,
    };
    setRuns((prev) => [run, ...prev]);
    return id;
  }, []);

  const getRun = useCallback(
    (id: string | undefined) => (id ? runs.find((r) => r.id === id) : undefined),
    [runs],
  );

  const value = useMemo(
    () => ({ runs, getRun, play, pause, seek, setSpeed, restart, terminate, createRun }),
    [runs, getRun, play, pause, seek, setSpeed, restart, terminate, createRun],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useSim(): SimCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSim 必须在 SimProvider 内使用');
  return ctx;
}
