/** 虚拟耗时 mm:ss */
export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 依据起始时间标签换算挂钟时间 HH:mm:ss */
export function wallClock(startLabel: string, tsMs: number): string {
  const [h, m] = startLabel.split(':').map((x) => Number(x) || 0);
  const total = h * 3600_000 + m * 60_000 + tsMs;
  const s = Math.floor(total / 1000);
  const hh = String(Math.floor(s / 3600) % 24).padStart(2, '0');
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export const pct = (v: number, digits = 1): string =>
  `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
