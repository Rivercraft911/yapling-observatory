import type { PlotEvent } from './missionEvents';
import { clampTimeRange, type TimeDomain, type TimeRange } from './timeWindow.ts';

export interface EventGroup {
  slot: number;
  position: number;
  events: PlotEvent[];
}

export function groupVisibleEvents(events: readonly PlotEvent[], range: TimeRange, width: number) {
  const slots = Math.max(1, Math.min(160, Math.floor(width / 26)));
  const span = range[1] - range[0];
  if (!(span > 0)) return [];
  const groups = new Map<number, EventGroup>();
  for (const event of events) {
    if (event.time > range[1] || (event.endTime ?? event.time) < range[0]) continue;
    const fraction = Math.max(0, Math.min(1, (event.time - range[0]) / span));
    const slot = Math.min(slots - 1, Math.floor(fraction * slots));
    const group = groups.get(slot) ?? {
      slot,
      position: (slot + 0.5) / slots,
      events: [],
    };
    group.events.push(event);
    groups.set(slot, group);
  }
  return [...groups.values()].sort((a, b) => a.slot - b.slot);
}

export function eventTimeRange(event: PlotEvent, domain: TimeDomain): TimeRange {
  const end = event.endTime ?? event.time;
  const padding = Math.max(domain.minimumSpan * 2, (end - event.time) * 0.1, 30);
  return clampTimeRange([event.time - padding, end + padding], domain);
}
