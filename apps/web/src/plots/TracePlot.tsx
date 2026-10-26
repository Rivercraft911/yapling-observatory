import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import uPlot from 'uplot';
import { formatAxisValues, formatElapsedSeconds, formatValue } from './traceFormatting';
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
  times,
  traces,
  cursorTime,
  onScrub,
  baseline,
  minimumSpan = 0,
  stepped = false,
  titleControl,
}: {
  title: string;
  unit: string;
  times: number[];
  traces: Trace[];
  cursorTime: number;
  onScrub: (time: number) => void;
  baseline?: { times: number[]; traces: Trace[] };
  minimumSpan?: number;
  stepped?: boolean;
  titleControl?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const scrub = useRef(onScrub);
  scrub.current = onScrub;
  const hovering = useRef(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const cursor = useRef(cursorTime);
  cursor.current = cursorTime;
  useEffect(() => {
    const element = host.current;
    if (!element || times.length < 2) return;
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
        x: { time: false },
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
          values: (_u, values) => formatAxisValues(values),
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
      instance.over.setPointerCapture(event.pointerId);
      scrubAt(event);
    };
    const inspectAt = (event: PointerEvent) => {
      hovering.current = true;
      const bounds = instance.over.getBoundingClientRect();
      const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left));
      setHoverTime(instance.posToVal(x, 'x'));
    };
    const leavePlot = () => {
      hovering.current = false;
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
      observer.disconnect();
      plot.current = null;
      instance.destroy();
    };
  }, [times, traces, baseline, minimumSpan, stepped]);
  useEffect(() => {
    const instance = plot.current;
    if (instance && !hovering.current)
      instance.setCursor({ left: instance.valToPos(cursorTime, 'x'), top: -10 }, false);
  }, [cursorTime]);
  const index = closestIndex(times, hoverTime ?? cursorTime);
  return (
    <section className="trace-panel" aria-label={`${title} in ${unit}`}>
      <div className="trace-heading">
        <h2>
          {titleControl || title}
          <span>{unit}</span>
        </h2>
        <div className="trace-values" data-inspecting={hoverTime !== null}>
          {hoverTime !== null && (
            <span className="trace-hover-time">T+ {formatElapsedSeconds(times[index])} s</span>
          )}
          {traces.map((trace) => (
            <span key={trace.label} style={{ color: trace.color }}>
              <i />
              {trace.label}
              <b>{formatValue(trace.values[index])}</b>
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
