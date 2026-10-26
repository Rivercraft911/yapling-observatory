import type { Quaternion } from '../types';

/** Graphics clock only. Numerical histories and quantitative sample selection stay discrete. */
export interface DisplayTimeSource {
  readonly current: number;
}
export interface DisplayBracket {
  lower: number;
  upper: number;
  alpha: number;
  time: number;
  nearest: number;
}

export function displayBracket(
  times: readonly number[],
  requestedTime: number,
): DisplayBracket | null {
  if (!times.length) return null;
  const time = Math.max(
    times[0],
    Math.min(times[times.length - 1], Number.isFinite(requestedTime) ? requestedTime : times[0]),
  );
  let lo = 0,
    hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  if (times[lo] === time || lo === 0) return { lower: lo, upper: lo, alpha: 0, time, nearest: lo };
  const lower = lo - 1;
  const alpha = (time - times[lower]) / (times[lo] - times[lower]);
  return { lower, upper: lo, alpha, time, nearest: alpha < 0.5 ? lower : lo };
}

export function interpolateVector3(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
  alpha: number,
): [number, number, number] | null {
  if (!Number.isFinite(alpha) || a?.length !== 3 || !a.every(Number.isFinite)) return null;
  if (alpha <= 0) return [a[0], a[1], a[2]];
  if (b?.length !== 3 || !b.every(Number.isFinite)) return null;
  if (alpha >= 1) return [b[0], b[1], b[2]];
  return [a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha, a[2] + (b[2] - a[2]) * alpha];
}

/** Scalar-first shortest-arc SLERP. q and -q describe the same orientation. */
export function interpolateQuaternion(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
  alpha: number,
): Quaternion | null {
  if (
    !Number.isFinite(alpha) ||
    a?.length !== 4 ||
    !a.every(Number.isFinite) ||
    Math.hypot(...a) < 1e-14
  )
    return null;
  if (alpha <= 0) return [...a] as Quaternion;
  if (b?.length !== 4 || !b.every(Number.isFinite) || Math.hypot(...b) < 1e-14) return null;
  if (alpha >= 1) return [...b] as Quaternion;
  const an = Math.hypot(...a),
    bn = Math.hypot(...b);
  const qa = a.map((value) => value / an),
    qb = b.map((value) => value / bn);
  let dot = qa.reduce((sum, value, i) => sum + value * qb[i], 0);
  if (dot < 0) {
    dot = -dot;
    for (let i = 0; i < 4; i++) qb[i] = -qb[i];
  }
  dot = Math.min(1, dot);
  let first = 1 - alpha,
    second = alpha;
  if (dot < 0.9995) {
    const theta = Math.acos(dot),
      sine = Math.sin(theta);
    first = Math.sin((1 - alpha) * theta) / sine;
    second = Math.sin(alpha * theta) / sine;
  }
  const result = qa.map((value, i) => value * first + qb[i] * second);
  const length = Math.hypot(...result);
  return result.map((value) => value / length) as Quaternion;
}

export function advanceDisplayTime(current: number, wallDeltaS: number, rate: number, end: number) {
  return Math.min(end, current + Math.max(0, Math.min(wallDeltaS, 0.2)) * rate);
}
