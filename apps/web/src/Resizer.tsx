import { useEffect, useRef } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import './resizer.css';

export interface PaneDividerProps {
  orientation: 'vertical' | 'horizontal';
  value: number; min: number; max: number;
  onChange: (next: number) => void;
  onReset: () => void;
  label: string;
  reverse?: boolean;
}

/** A pixel-valued view control. The owner decides which pane the value sizes. */
export function PaneDivider({ orientation, value, min, max, onChange, onReset, label, reverse = false }: PaneDividerProps) {
  const element = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; origin: number; value: number } | null>(null);
  const low = Number.isFinite(min) ? min : 0;
  const high = Number.isFinite(max) ? Math.max(low, max) : low;
  const clamp = (next: number) => Math.max(low, Math.min(high, Number.isFinite(next) ? next : low));
  const current = clamp(value);
  const axis = (event: PointerEvent) => orientation === 'vertical' ? event.clientX : event.clientY;
  const release = () => {
    const pointer = drag.current; drag.current = null;
    if (pointer && element.current?.hasPointerCapture(pointer.id)) element.current.releasePointerCapture(pointer.id);
  };
  useEffect(() => {
    const node = element.current;
    const cancel = () => { const pointer = drag.current; drag.current = null; if (pointer && node?.hasPointerCapture(pointer.id)) node.releasePointerCapture(pointer.id); };
    window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('blur', cancel); cancel(); };
  }, []);
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.currentTarget.focus();
    drag.current = {id: event.pointerId, origin: axis(event), value: current};
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const pointer = drag.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    event.preventDefault(); onChange(clamp(pointer.value + (axis(event) - pointer.origin) * (reverse ? -1 : 1)));
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    const negative = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const positive = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (event.key === 'Home') next = low;
    else if (event.key === 'End') next = high;
    else if (event.key === negative || event.key === positive) next = current + (event.key === positive ? 1 : -1) * (reverse ? -1 : 1) * (event.shiftKey ? 10 : 1);
    else return;
    event.preventDefault(); onChange(clamp(next));
  };
  return <div ref={element} role="separator" tabIndex={0} aria-label={label} aria-orientation={orientation}
    aria-valuemin={low} aria-valuemax={high} aria-valuenow={current} aria-valuetext={`${Math.round(current)} pixels`}
    className={`pane-divider pane-divider-${orientation}`}
    title={`${label}. Drag or use arrow keys; Shift changes 10 pixels. Home / End select limits. Double-click resets.`}
    onPointerDown={start} onPointerMove={move} onPointerUp={release} onPointerCancel={release} onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={keyDown} onDoubleClick={() => { release(); onReset(); }}><span aria-hidden="true"/></div>;
}
