import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import uPlot from 'uplot';
import {
  formatAxisValues,
  formatElapsedSeconds,
  formatRateAxisValues,
  formatRateValue,
  formatValue,
  selectRateUnit,
} from './traceFormatting';
import {
  attachTimeWindowNavigation,
  clampTimeRange,
  sampleTimeDomain,
  type TimeRange,
} from './timeWindow';
export { formatValue } from './traceFormatting';

export interface Trace {
  label: string;
  color: string;
  values: (number | null)[];
  dash?: number[];
}
export function TracePlot({
  title,
  unit,
  description,
  times,
  traces,
  cursorTime,
  onScrub,
  baseline,
  minimumSpan = 0,
  stepped = false,
  titleControl,
  timeRange = null,
  onTimeRangeChange,
}: {
  title: string;
  unit: string;
  description?: string;
  times: number[];
  traces: Trace[];
  cursorTime: number;
  onScrub: (time: number) => void;
  baseline?: { times: number[]; traces: Trace[] };
  minimumSpan?: number;
  stepped?: boolean;
  titleControl?: ReactNode;
  timeRange?: TimeRange | null;
  onTimeRangeChange?: (range: TimeRange | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const scrub = useRef(onScrub);
  scrub.current = onScrub;
  const domain = useMemo(() => sampleTimeDomain(times), [times]);
  const rateUnit = useMemo(
    () =>
      selectRateUnit(
        unit,
        [...traces, ...(baseline?.traces || [])].map((trace) => trace.values),
      ),
    [unit, traces, baseline],
  );
  const displayUnit = rateUnit?.unit ?? unit;
  const navigation = useRef({ domain, range: timeRange, onChange: onTimeRangeChange });
  navigation.current = { domain, range: timeRange, onChange: onTimeRangeChange };
  const hovering = useRef(false);
  const hoverX = useRef<number | null>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const cursor = useRef(cursorTime);
  cursor.current = cursorTime;
  useEffect(() => {
    const element = host.current;
    if (!element || !domain) return;
    const initialRange = clampTimeRange(navigation.current.range, domain);
    const allTraces = [...traces, ...(baseline?.traces || [])];
    const own: uPlot.AlignedData = [times, ...traces.map((trace) => trace.values)];
    const data: uPlot.AlignedData = baseline
      ? uPlot.join([own, [baseline.times, ...baseline.traces.map((trace) => trace.values)]])
      : own;
    const options: uPlot.Options = {
      width: Math.max(element.clientWidth, 100),
      height: Math.max(element.clientHeight, 65),
      padding: [9, 15, 0, 0],
      legend: { show: false },
      cursor: { y: false, points: { show: false }, drag: { x: false, y: false, setScale: false } },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      scales: {
        x: { time: false, auto: false, min: initialRange[0], max: initialRange[1] },
        y: {
          auto: true,
          ...(minimumSpan
            ? {
                range: (_u: uPlot, _min: number, max: number) =>
                  [0, Math.max(minimumSpan, Number.isFinite(max) ? max : 0) * 1.05] as [
                    number,
                    number,
                  ],
              }
            : {}),
        },
      },
      axes: [
        {
          stroke: '#758287',
          size: 24,
          gap: 5,
          font: '10px IBM Plex Mono',
          grid: { show: true, stroke: '#2a3337', width: 1 },
          ticks: { show: false },
          values: (_u, values) => values.map((value) => `${value}`),
        },
        {
          stroke: '#849195',
          size: (_u, labels) =>
            Math.max(49, 7 + 6.1 * Math.max(0, ...(labels ?? []).map((label) => label.length))),
          gap: 7,
          font: '10px IBM Plex Mono',
          grid: { show: true, stroke: '#2a3337', width: 1 },
          ticks: { show: false },
          values: (_u, values) =>
            rateUnit
              ? formatRateAxisValues(values.map((value) => value / rateUnit.divisor))
              : formatAxisValues(values),
        },
      ],
      series: [
        {},
        ...allTraces.map((trace) => ({
          label: trace.label,
          stroke: trace.color,
          width: trace.dash ? 1 : 1.4,
          dash: trace.dash,
          spanGaps: false,
          points: { show: false },
          ...(stepped ? { paths: uPlot.paths.stepped?.({ align: 1, ascDesc: false }) } : {}),
        })),
      ],
    };
    const instance = new uPlot(options, data, element);
    plot.current = instance;
    let activePointer: number | null = null;
    const scrubAt = (event: PointerEvent) => {
      const bounds = instance.over.getBoundingClientRect();
      const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
      scrub.current(instance.posToVal(x, 'x'));
    };
    const beginScrub = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      activePointer = event.pointerId;
      instance.over.focus({ preventScroll: true });
      instance.over.setPointerCapture(event.pointerId);
      scrubAt(event);
    };
    const inspectAt = (event: PointerEvent) => {
      hovering.current = true;
      const bounds = instance.over.getBoundingClientRect();
      const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
      hoverX.current = x;
      setHoverTime(instance.posToVal(x, 'x'));
    };
    const leavePlot = () => {
      hovering.current = false;
      hoverX.current = null;
      setHoverTime(null);
      instance.setCursor({ left: instance.valToPos(cursor.current, 'x'), top: -10 }, false);
    };
    const moveScrub = (event: PointerEvent) => {
      inspectAt(event);
      if (event.pointerId === activePointer) scrubAt(event);
    };
    const endScrub = () => {
      if (activePointer !== null && instance.over.hasPointerCapture(activePointer))
        instance.over.releasePointerCapture(activePointer);
      activePointer = null;
    };
    if (navigation.current.onChange) {
      instance.over.tabIndex = 0;
      instance.over.setAttribute('role', 'group');
      instance.over.setAttribute('aria-label', `${title} time navigation`);
      instance.over.setAttribute('aria-keyshortcuts', '+ - ArrowLeft ArrowRight Home');
      instance.over.title =
        'Wheel: zoom. Shift + wheel or horizontal wheel: pan. Keys: + / −, ← / →, Home. Drag: scrub.';
    }
    const detachNavigation = attachTimeWindowNavigation(
      instance.over,
      () => {
        const current = navigation.current;
        return current.domain && current.onChange && activePointer === null
          ? { domain: current.domain, range: current.range }
          : null;
      },
      (range) => {
        navigation.current.range = range;
        navigation.current.onChange?.(range);
      },
    );
    instance.over.addEventListener('pointerenter', inspectAt);
    instance.over.addEventListener('pointerleave', leavePlot);
    instance.over.addEventListener('pointerdown', beginScrub);
    instance.over.addEventListener('pointermove', moveScrub);
    instance.over.addEventListener('pointerup', endScrub);
    instance.over.addEventListener('pointercancel', endScrub);
    instance.over.addEventListener('lostpointercapture', endScrub);
    const observer = new ResizeObserver(() =>
      instance.setSize({
        width: Math.max(element.clientWidth, 100),
        height: Math.max(element.clientHeight, 65),
      }),
    );
    observer.observe(element);
    instance.setCursor({ left: instance.valToPos(cursor.current, 'x'), top: -10 }, false);
    return () => {
      endScrub();
      hovering.current = false;
      instance.over.removeEventListener('pointerenter', inspectAt);
      instance.over.removeEventListener('pointerleave', leavePlot);
      instance.over.removeEventListener('pointerdown', beginScrub);
      instance.over.removeEventListener('pointermove', moveScrub);
      instance.over.removeEventListener('pointerup', endScrub);
      instance.over.removeEventListener('pointercancel', endScrub);
      instance.over.removeEventListener('lostpointercapture', endScrub);
      detachNavigation();
      observer.disconnect();
      plot.current = null;
      instance.destroy();
    };
  }, [times, traces, baseline, minimumSpan, stepped, domain, title, rateUnit]);
  useEffect(() => {
    const instance = plot.current;
    if (!instance || !domain) return;
    const range = clampTimeRange(timeRange, domain);
    // Commit the scale before projecting the paused cursor or hover position.
    instance.batch(() => instance.setScale('x', { min: range[0], max: range[1] }));
    if (hovering.current && hoverX.current !== null) {
      setHoverTime(instance.posToVal(hoverX.current, 'x'));
      instance.setCursor({ left: hoverX.current, top: -10 }, false);
    } else {
      instance.setCursor({ left: instance.valToPos(cursor.current, 'x'), top: -10 }, false);
    }
  }, [timeRange, domain]);
  useEffect(() => {
    const instance = plot.current;
    if (instance && !hovering.current)
      instance.setCursor({ left: instance.valToPos(cursorTime, 'x'), top: -10 }, false);
  }, [cursorTime]);
  const index = closestIndex(times, hoverTime ?? cursorTime);
  return (
    <section className="trace-panel" aria-label={`${title} in ${displayUnit}`}>
      <div className="trace-heading">
        <h2 title={description}>
          {titleControl || title}
          <span>{displayUnit}</span>
        </h2>
        <div className="trace-values" data-inspecting={hoverTime !== null}>
          {hoverTime !== null && (
            <span className="trace-hover-time">T+ {formatElapsedSeconds(times[index])} s</span>
          )}
          {traces.map((trace) => (
            <span key={trace.label} style={{ color: trace.color }}>
              <i />
              {trace.label}
              <b>
                {rateUnit
                  ? `${formatRateValue(trace.values[index] == null ? null : trace.values[index]! / rateUnit.divisor)} ${displayUnit}`
                  : formatValue(trace.values[index])}
              </b>
            </span>
          ))}
        </div>
      </div>
      <div ref={host} className="plot-canvas" />
      {times.length < 2 && <div className="plot-empty">Awaiting computed samples</div>}
    </section>
  );
}
export function closestIndex(times: number[], value: number) {
  if (!times.length) return 0;
  let lo = 0,
    hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(times[lo - 1] - value) < Math.abs(times[lo] - value) ? lo - 1 : lo;
}
