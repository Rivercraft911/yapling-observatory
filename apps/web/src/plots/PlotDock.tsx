import { useEffect, useMemo, useState } from 'react';
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
      saved.length === 3 &&
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
  useEffect(() => {
    try {
      localStorage.setItem('ssi-workspace-plots', JSON.stringify(selection));
    } catch {}
  }, [selection]);
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
      </nav>
      <div className="trace-stack">
        {panels.map(({ definition, traces, baseline: comparison }, slot) => (
          <TracePlot
            key={slot}
            title={definition.title}
            unit={definition.unit}
            minimumSpan={definition.minimumSpan}
            stepped={definition.stepped}
            times={snapshot?.run.result?.samples.time_s || emptyTimes}
            traces={traces}
            baseline={comparison}
            cursorTime={cursorTime}
            onScrub={onScrub}
            titleControl={
              <select
                className="plot-selector"
                aria-label={`Plot ${slot + 1}`}
                title={definition.description}
                value={definition.id}
                onChange={(event) =>
                  setSelection((current) =>
                    current.map((id, index) =>
                      index === slot ? (event.target.value as PlotId) : id,
                    ),
                  )
                }
              >
                {plotDefinitions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            }
          />
        ))}
      </div>
    </section>
  );
}
