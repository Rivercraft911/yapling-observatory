import { useEffect, useMemo, useRef, useState } from 'react';
import type { RunResult } from '../types';
import { missionEvents, type MissionEventCategory, type PlotEvent } from './missionEvents';
import { eventTimeRange, groupVisibleEvents, type EventGroup } from './eventNavigation';
import { formatElapsedSeconds } from './traceFormatting';
import type { TimeDomain, TimeRange } from './timeWindow';
import './event-strip.css';

const categories: { id: MissionEventCategory; label: string; symbol: string }[] = [
  { id: 'pass', label: 'Passes', symbol: '▰' },
  { id: 'eclipse', label: 'Eclipse', symbol: '◐' },
  { id: 'conops', label: 'CONOPS', symbol: '◆' },
  { id: 'radio', label: 'Radio', symbol: '│' },
  { id: 'wheel', label: 'Wheels', symbol: '!' },
  { id: 'command', label: 'Commands', symbol: '↗' },
];
const pageSize = 30;
const eventText = (event: PlotEvent) =>
  `${event.label} · T+ ${formatElapsedSeconds(event.time)} s${event.endTime !== undefined ? ` to ${formatElapsedSeconds(event.endTime)} s` : ''}`;

export function EventStrip({
  result,
  range,
  domain,
  onFocus,
}: {
  result: RunResult;
  range: TimeRange;
  domain: TimeDomain;
  onFocus: (time: number, range: TimeRange) => void;
}) {
  const data = useMemo(() => missionEvents(result), [result]);
  const [category, setCategory] = useState<MissionEventCategory | 'all'>('all');
  const [open, setOpen] = useState<EventGroup | null>(null);
  const [page, setPage] = useState(0);
  const [width, setWidth] = useState(600);
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const availableCategories = useMemo(
    () => categories.filter((item) => data.events.some((event) => event.category === item.id)),
    [data.events],
  );
  const filtered = useMemo(
    () => data.events.filter((event) => category === 'all' || event.category === category),
    [data.events, category],
  );
  const groups = useMemo(
    () => groupVisibleEvents(filtered, range, width),
    [filtered, range[0], range[1], width],
  );
  const active = open;
  const count = groups.reduce((total, group) => total + group.events.length, 0);
  const close = () => {
    root.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
    setOpen(null);
  };
  useEffect(() => {
    if (category !== 'all' && !availableCategories.some((item) => item.id === category))
      setCategory('all');
  }, [category, availableCategories]);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setOpen(null);
    setPage(0);
  }, [category, width]);
  useEffect(() => {
    if (!open) return;
    const currentIds = new Set(data.events.map((event) => event.id));
    if (!open.events.some((event) => currentIds.has(event.id))) setOpen(null);
  }, [data.events, open]);
  useEffect(() => {
    if (open === null) return;
    root.current?.querySelector<HTMLButtonElement>('.event-picker-list button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const outsideWheel = (event: WheelEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('wheel', outsideWheel, { passive: true });
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('wheel', outsideWheel);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const focus = (event: PlotEvent) => {
    setOpen(null);
    onFocus(event.time, eventTimeRange(event, domain));
  };
  return (
    <div className="event-strip" ref={root} aria-label="Mission events" title="">
      <div className="event-filters" role="group" aria-label="Event categories">
        <button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
          All
        </button>
        {availableCategories.map((item) => (
          <button
            key={item.id}
            aria-pressed={category === item.id}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
        <span className="event-count">{count.toLocaleString()} in view</span>
        {data.sampled && (
          <span title="Sampled markers report the first returned sample after a change; their tooltip gives the sampling interval.">
            sampled
          </span>
        )}
        {data.incomplete && (
          <span
            className="event-warning"
            title="Some event records are missing, invalid or omitted. The displayed list is not a complete event history."
          >
            partial log
          </span>
        )}
      </div>
      <div className="event-track" ref={track} role="group" aria-label="Events in graph window">
        {!count && <span className="event-empty">No events in this window</span>}
        {groups.map((group) => {
          const event = group.events[0];
          const multiple = group.events.length > 1;
          return (
            <button
              key={group.slot}
              className="event-marker"
              data-category={multiple ? 'group' : event.category}
              style={{ left: `${group.position * 100}%` }}
              aria-label={
                multiple
                  ? `${group.events.length} events near T+ ${formatElapsedSeconds(event.time)} s`
                  : eventText(event)
              }
              aria-expanded={multiple ? open?.slot === group.slot : undefined}
              title={
                multiple
                  ? `${group.events.length} events · choose one to focus the graphs`
                  : `${eventText(event)}\n${event.detail}\nClick to focus the graphs`
              }
              onClick={() => {
                if (!multiple) focus(event);
                else {
                  setPage(0);
                  setOpen(open?.slot === group.slot ? null : group);
                }
              }}
            >
              {multiple
                ? group.events.length > 99
                  ? '99+'
                  : group.events.length
                : categories.find((item) => item.id === event.category)?.symbol}
            </button>
          );
        })}
      </div>
      {active && (
        <div
          className="event-picker"
          role="group"
          aria-label="Choose an event"
          style={{ left: `min(${active.position * 100}%, max(0px, 100% - 310px))` }}
        >
          <div className="event-picker-heading">
            <span>{active.events.length} events</span>
            <button aria-label="Close event list" onClick={close}>
              ×
            </button>
          </div>
          <div className="event-picker-list">
            {active.events.slice(page * pageSize, (page + 1) * pageSize).map((event) => (
              <button key={event.id} title={event.detail} onClick={() => focus(event)}>
                <span>{event.label}</span>
                <small>T+ {formatElapsedSeconds(event.time)} s</small>
              </button>
            ))}
          </div>
          {active.events.length > pageSize && (
            <div className="event-pages">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                {page + 1} / {Math.ceil(active.events.length / pageSize)}
              </span>
              <button
                disabled={(page + 1) * pageSize >= active.events.length}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
