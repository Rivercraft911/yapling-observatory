import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RunSnapshot } from '../types';
import { TracePlot } from './TracePlot';
import { plotDefinitions, plotTraces } from './registry';
import type { PlotId } from './registry';

const emptyTimes: number[] = [];
const defaults: PlotId[] = ['pointing', 'margin', 'rate'];
const presets: { label: string; values: PlotId[] }[] = [
  { label: 'Link', values: defaults },
  { label: 'Motion', values: ['pointing', 'tracking', 'elevation'] },
];
function readSelection(): PlotId[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('ssi-workspace-plots') || 'null');
    if (
      Array.isArray(saved) &&
      saved.length >= 1 &&
      saved.length <= 6 &&
      new Set(saved).size === saved.length &&
      saved.every((id) => plotDefinitions.some((definition) => definition.id === id))
    )
      return saved;
  } catch {}
  return defaults;
}
export function PlotDock({
  snapshot,
  baseline,
  cursorTime,
  onScrub,
}: {
  snapshot: RunSnapshot | null;
  baseline: RunSnapshot | null;
  cursorTime: number;
  onScrub: (time: number) => void;
}) {
  const [selection, setSelection] = useState(readSelection);
  const [choosing, setChoosing] = useState(false);
  const chooser = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem('ssi-workspace-plots', JSON.stringify(selection));
    } catch {}
  }, [selection]);
  useEffect(() => {
    if (!choosing) return;
    const outside = (event: PointerEvent) => {
      if (!chooser.current?.contains(event.target as Node)) setChoosing(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChoosing(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [choosing]);
  const panels = useMemo(
    () =>
      selection.map((id) => {
        const definition = plotDefinitions.find((item) => item.id === id)!;
        return {
          definition,
          traces: plotTraces(definition, snapshot),
          baseline: baseline?.run.result
            ? {
                times: baseline.run.result.samples.time_s,
                traces: plotTraces(definition, baseline, true),
              }
            : undefined,
        };
      }),
    [selection, snapshot, baseline],
  );
  const toggle = (id: PlotId) =>
    setSelection((current) =>
      current.includes(id)
        ? current.length > 1
          ? current.filter((value) => value !== id)
          : current
        : current.length < 6
          ? [...current, id]
          : current,
    );
  return (
    <section className="plot-dock" aria-label="Run plots">
      <nav className="plot-groups" aria-label="Plot groups">
        {presets.map((preset) => (
          <button
            key={preset.label}
            aria-pressed={selection.join() === preset.values.join()}
            onClick={() => setSelection(preset.values)}
          >
            {preset.label}
          </button>
        ))}
        <div className="plot-chooser" ref={chooser}>
          <button
            aria-expanded={choosing}
            aria-controls="plot-options"
            onClick={() => setChoosing(!choosing)}
          >
            Plots <span>{selection.length}</span>
          </button>
          {choosing && (
            <div className="plot-options" id="plot-options" role="group" aria-label="Choose plots">
              <div className="plot-options-heading">
                SHOW PLOTS <span>{selection.length} / 6</span>
              </div>
              {plotDefinitions.map((item) => (
                <label key={item.id} title={item.description}>
                  <input
                    type="checkbox"
                    checked={selection.includes(item.id)}
                    disabled={
                      selection.includes(item.id) ? selection.length === 1 : selection.length === 6
                    }
                    onChange={() => toggle(item.id)}
                  />
                  <span>{item.title}</span>
                  <small>{item.unit}</small>
                </label>
              ))}
            </div>
          )}
        </div>
      </nav>
      <div
        className="trace-stack"
        data-dense={selection.length > 3}
        style={
          {
            '--plot-count': selection.length,
            '--plot-pairs': Math.ceil(selection.length / 2),
          } as CSSProperties
        }
      >
        {panels.map(({ definition, traces, baseline: comparison }) => (
          <TracePlot
            key={definition.id}
            title={definition.title}
            unit={definition.unit}
            minimumSpan={definition.minimumSpan}
            stepped={definition.stepped}
            times={snapshot?.run.result?.samples.time_s || emptyTimes}
            traces={traces}
            baseline={comparison}
            cursorTime={cursorTime}
            onScrub={onScrub}
          />
        ))}
      </div>
    </section>
  );
}
