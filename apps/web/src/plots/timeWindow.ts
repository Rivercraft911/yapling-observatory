/** Display-only X-axis navigation over the returned sample timestamps. */
export type TimeRange = readonly [number, number];
export interface TimeDomain {
  bounds: TimeRange;
  minimumSpan: number;
}

export function sampleTimeDomain(times: readonly number[]): TimeDomain | null {
  if (times.length < 2 || !Number.isFinite(times[0])) return null;
  let minimumSpan = Infinity;
  for (let index = 1; index < times.length; index++) {
    const spacing = times[index] - times[index - 1];
    if (!Number.isFinite(times[index]) || spacing < 0) return null;
    if (spacing > 0) minimumSpan = Math.min(minimumSpan, spacing);
  }
  return Number.isFinite(minimumSpan)
    ? { bounds: [times[0], times[times.length - 1]], minimumSpan }
    : null;
}

export function clampTimeRange(range: TimeRange | null, domain: TimeDomain): TimeRange {
  const [start, end] = domain.bounds;
  if (!range || !range.every(Number.isFinite) || range[1] <= range[0]) return [start, end];
  const span = Math.min(end - start, Math.max(domain.minimumSpan, range[1] - range[0]));
  const left = Math.max(start, Math.min(end - span, (range[0] + range[1] - span) / 2));
  return [left, left + span];
}

export function zoomTimeRange(
  range: TimeRange | null,
  domain: TimeDomain,
  factor: number,
  anchorFraction = 0.5,
): TimeRange {
  const current = clampTimeRange(range, domain);
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(anchorFraction)) return current;
  const anchor = Math.max(0, Math.min(1, anchorFraction));
  const span = current[1] - current[0];
  const nextSpan = Math.min(
    domain.bounds[1] - domain.bounds[0],
    Math.max(domain.minimumSpan, span * factor),
  );
  const left = current[0] + anchor * (span - nextSpan);
  return clampTimeRange([left, left + nextSpan], domain);
}

export function panTimeRange(
  range: TimeRange | null,
  domain: TimeDomain,
  fraction: number,
): TimeRange {
  const current = clampTimeRange(range, domain);
  if (!Number.isFinite(fraction)) return current;
  const offset = (current[1] - current[0]) * fraction;
  return clampTimeRange([current[0] + offset, current[1] + offset], domain);
}

export function fullRangeOrNull(range: TimeRange, domain: TimeDomain): TimeRange | null {
  return range[0] === domain.bounds[0] && range[1] === domain.bounds[1] ? null : range;
}

export function keyTimeRange(
  range: TimeRange | null,
  domain: TimeDomain,
  key: string,
): TimeRange | undefined {
  if (key === '+' || key === '=') return zoomTimeRange(range, domain, 0.5);
  if (key === '-' || key === '_') return zoomTimeRange(range, domain, 2);
  if (key === 'ArrowLeft') return panTimeRange(range, domain, -0.2);
  if (key === 'ArrowRight') return panTimeRange(range, domain, 0.2);
  if (key === 'Home') return [...domain.bounds];
  return undefined;
}

export interface TimeNavigationContext {
  domain: TimeDomain;
  range: TimeRange | null;
}

export function attachTimeWindowNavigation(
  element: HTMLElement,
  read: () => TimeNavigationContext | null,
  onChange: (range: TimeRange | null) => void,
) {
  const apply = (next: TimeRange | undefined, context: TimeNavigationContext) => {
    if (!next) return false;
    const current = clampTimeRange(context.range, context.domain);
    if (current[0] === next[0] && current[1] === next[1]) return false;
    onChange(fullRangeOrNull(next, context.domain));
    return true;
  };
  const wheel = (event: WheelEvent) => {
    const context = read();
    if (!context || !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) return;
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
    const pan = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const delta = pan
      ? Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY
      : event.deltaY;
    if (!delta) return;
    const next = pan
      ? panTimeRange(context.range, context.domain, (delta * units) / bounds.width)
      : zoomTimeRange(
          context.range,
          context.domain,
          Math.exp(Math.max(-3, Math.min(3, (delta * units) / 300))),
          (event.clientX - bounds.left) / bounds.width,
        );
    // A wheel at a navigation limit may continue ordinary page scrolling.
    if (apply(next, context)) event.preventDefault();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const context = read();
    if (!context) return;
    const next = keyTimeRange(context.range, context.domain, event.key);
    if (next) {
      apply(next, context);
      event.preventDefault();
    }
  };
  element.addEventListener('wheel', wheel, { passive: false });
  element.addEventListener('keydown', keydown);
  return () => {
    element.removeEventListener('wheel', wheel);
    element.removeEventListener('keydown', keydown);
  };
}
