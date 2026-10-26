import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RunSnapshot } from '../types';
import { TracePlot } from './TracePlot';
import { plotDefinitions, plotTraces } from './registry';
import type { PlotId } from './registry';
import { MissionReport } from '../mission/MissionReport';
import { PowerStatus } from './PowerStatus';
import { LinkStatus } from './LinkStatus';
import { formatElapsedSeconds } from './traceFormatting';
import {
  clampTimeRange,
  fullRangeOrNull,
  keyTimeRange,
  sampleTimeDomain,
  type TimeRange,
} from './timeWindow';
import './plots.css';
import { missionReport } from '../mission/missionReporting';
import {
  plotLayouts,
  readPlotPreferences,
  writePlotPreferences,
  togglePlotSelection,
  type PlotLayout,
  type PlotColumns,
} from './plotPreferences';

const emptyTimes: number[] = [];
const compactPresets: { label: string; values: PlotId[] }[] = [
  { label: 'Link', values: plotLayouts.compact.defaults },
  { label: 'GNC', values: ['pointing', 'wheel_speed', 'wheel_capacity'] },
  { label: 'Power', values: ['power', 'battery_soc', 'battery_current'] },
  { label: 'Thermal', values: ['temperatures', 'dissipation', 'internal_heat'] },
  { label: 'Battery', values: ['battery_soc', 'battery_voltage', 'battery_current'] },
];
const resultsPresets: { label: string; values: PlotId[] }[] = [
  { label: 'Overview', values: plotLayouts.results.defaults },
  {
    label: 'Link',
    values: ['margin', 'frame_rate', 'selected_margin', 'payload', 'receiver_lock', 'rate'],
  },
  {
    label: 'GNC',
    values: [
      'pointing',
      'body_rate',
      'wheel_speed',
      'wheel_capacity',
      'wheel_momentum',
      'saturation',
      'unloading_torque',
      'coil_power',
      'magnetic_field',
      'control_torque',
      'control_residual',
    ],
  },
  {
    label: 'Power',
    values: [
      'power',
      'battery_soc',
      'energy',
      'battery_current',
      'battery_voltage',
      'actuator_power',
    ],
  },
  {
    label: 'Thermal',
    values: [
      'temperatures',
      'dissipation',
      'absorbed_heat',
      'radiated_heat',
      'internal_heat',
      'bus_heat',
      'battery_heat',
    ],
  },
  {
    label: 'Battery',
    values: [
      'battery_soc',
      'battery_voltage',
      'battery_current',
      'battery_remaining_charge',
      'battery_heat',
    ],
  },
];
function preferenceStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
interface PlotDockProps {
  snapshot: RunSnapshot | null;
  baseline: RunSnapshot | null;
  cursorTime: number;
  onScrub: (time: number) => void;
  liveReport?: unknown;
  showReportTab?: boolean;
  layout?: PlotLayout;
  timeRange?: TimeRange | null;
  onTimeRangeChange?: (range: TimeRange | null) => void;
  onFocusRange?: (start: number, end: number) => void;
}
export function PlotDock(props: PlotDockProps) {
  return <PlotDockContent key={props.layout || 'compact'} {...props} />;
}
function PlotDockContent({
  snapshot,
  baseline,
  cursorTime,
  onScrub,
  liveReport,
  showReportTab = true,
  layout = 'compact',
  timeRange,
  onTimeRangeChange,
  onFocusRange,
}: PlotDockProps) {
  const [reportOpen, setReportOpen] = useState(false);
  const [localTimeRange, setLocalTimeRange] = useState<TimeRange | null>(null);
  const activeTimeRange = timeRange === undefined ? localTimeRange : timeRange;
  const changeTimeRange = onTimeRangeChange ?? setLocalTimeRange;
  const times = snapshot?.run.result?.samples.time_s || emptyTimes;
  const timeDomain = useMemo(() => sampleTimeDomain(times), [times]);
  const shownRange = timeDomain ? clampTimeRange(activeTimeRange, timeDomain) : null;
  const navigate = (key: string) => {
    if (!timeDomain) return;
    const range = keyTimeRange(activeTimeRange, timeDomain, key);
    if (range) changeTimeRange(fullRangeOrNull(range, timeDomain));
  };
  const [preferences, setPreferences] = useState(() =>
    readPlotPreferences(
      layout,
      plotDefinitions.map((definition) => definition.id),
      preferenceStorage(),
    ),
  );
  const selection = preferences.selection;
  const maximum = plotLayouts[layout].maximum;
  const adaptive = !!(
    snapshot?.run.result?.samples.radio_delivery?.downlink.ready_payload_rate_bps ||
    snapshot?.run.result?.samples.radio_delivery?.uplink.ready_payload_rate_bps
  );
  const presets =
    layout === 'results'
      ? resultsPresets
      : compactPresets.map((preset) =>
          adaptive && preset.label === 'Link'
            ? { ...preset, values: ['selected_margin', 'frame_rate', 'pointing'] as PlotId[] }
            : preset,
        );
  const [choosing, setChoosing] = useState(false);
  const chooser = useRef<HTMLDivElement>(null);
  useEffect(() => {
    writePlotPreferences(layout, preferences, preferenceStorage());
  }, [layout, preferences]);
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
    setPreferences((current) => ({
      ...current,
      selection: togglePlotSelection(current.selection, id, layout),
    }));
  return (
    <section
      className={`plot-dock ${layout === 'results' ? 'results-plot-dock' : ''}`}
      data-columns={preferences.columns}
      data-time-navigation={!reportOpen}
      data-power-status={
        !reportOpen && selection.includes('power') && !!snapshot?.run.result?.samples.power
      }
      aria-label={layout === 'results' ? 'Results charts' : 'Run plots'}
    >
      <nav className="plot-groups" aria-label="Plot groups">
        {(snapshot?.run.result?.samples.uhf_beacon
          ? [
              ...presets,
              {
                label: 'UHF',
                values: (layout === 'results'
                  ? ['uhf_signal', 'uhf_margin', 'uhf_duty', 'uhf_beacons', 'uhf_power']
                  : ['uhf_signal', 'uhf_duty', 'uhf_beacons']) as PlotId[],
              },
            ]
          : presets
        ).map((preset) => (
          <button
            key={preset.label}
            aria-pressed={!reportOpen && selection.join() === preset.values.join()}
            onClick={() => {
              setReportOpen(false);
              setPreferences((current) => ({ ...current, selection: [...preset.values] }));
            }}
          >
            {preset.label}
          </button>
        ))}
        {layout === 'results' && (
          <label
            className="results-plot-columns"
            title="Maximum chart columns; narrow windows use fewer columns to keep plots readable."
          >
            <span>Columns</span>
            <select
              aria-label="Results chart columns"
              value={preferences.columns}
              onChange={(event) => {
                const columns =
                  event.target.value === 'auto'
                    ? 'auto'
                    : (Number(event.target.value) as PlotColumns);
                setPreferences((current) => ({ ...current, columns }));
              }}
            >
              <option value="auto">Auto</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </label>
        )}
        {showReportTab && (
          <button aria-pressed={reportOpen} onClick={() => setReportOpen(true)}>
            Report
          </button>
        )}
        <div className="plot-chooser" ref={chooser}>
          <button
            aria-expanded={choosing}
            aria-controls="plot-options"
            onClick={() => {
              setReportOpen(false);
              setChoosing(!choosing);
            }}
          >
            Plots <span>{selection.length}</span>
          </button>
          {choosing && (
            <div className="plot-options" id="plot-options" role="group" aria-label="Choose plots">
              <div className="plot-options-heading">
                SHOW PLOTS{' '}
                <span>
                  {selection.length} / {maximum}
                </span>
              </div>
              {plotDefinitions.map((item) => (
                <label key={item.id} title={item.description}>
                  <input
                    type="checkbox"
                    checked={selection.includes(item.id)}
                    disabled={
                      selection.includes(item.id)
                        ? selection.length === 1
                        : selection.length === maximum
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
      {!reportOpen && selection.includes('power') && (
        <PowerStatus snapshot={snapshot} cursorTime={cursorTime} expanded={layout === 'results'} />
      )}
      {!reportOpen && (
        <div
          className="plot-time-navigation"
          role="group"
          aria-label="Graph time window"
          title="Wheel over a chart: zoom at pointer. Shift + wheel or horizontal wheel: pan. Focus a chart for + / −, ← / → and Home. Drag to scrub."
        >
          <span className="plot-time-range">
            X ·{' '}
            {shownRange
              ? `${formatElapsedSeconds(shownRange[0])}–${formatElapsedSeconds(shownRange[1])} s`
              : 'No samples'}
          </span>
          {selection.some((id) =>
            [
              'rate',
              'margin',
              'frame_rate',
              'selected_margin',
              'payload',
              'receiver_lock',
            ].includes(id),
          ) && <LinkStatus snapshot={snapshot} cursorTime={cursorTime} />}
          <button
            aria-label="Pan graphs earlier"
            title="Pan earlier (←)"
            disabled={!shownRange || shownRange[0] <= timeDomain!.bounds[0]}
            onClick={() => navigate('ArrowLeft')}
          >
            ←
          </button>
          <button
            aria-label="Zoom graphs out"
            title="Zoom out (−)"
            disabled={
              !shownRange ||
              shownRange[1] - shownRange[0] >= timeDomain!.bounds[1] - timeDomain!.bounds[0]
            }
            onClick={() => navigate('-')}
          >
            −
          </button>
          <button
            aria-label="Zoom graphs in"
            title="Zoom in (+)"
            disabled={!shownRange || shownRange[1] - shownRange[0] <= timeDomain!.minimumSpan}
            onClick={() => navigate('+')}
          >
            +
          </button>
          <button
            aria-label="Pan graphs later"
            title="Pan later (→)"
            disabled={!shownRange || shownRange[1] >= timeDomain!.bounds[1]}
            onClick={() => navigate('ArrowRight')}
          >
            →
          </button>
          <button
            className="plot-time-full"
            title="Show the full returned time range (Home)"
            disabled={
              !shownRange ||
              (shownRange[0] === timeDomain!.bounds[0] && shownRange[1] === timeDomain!.bounds[1])
            }
            onClick={() => navigate('Home')}
          >
            Full
          </button>
        </div>
      )}
      {reportOpen ? (
        <MissionReport
          report={missionReport(
            liveReport ?? snapshot?.run.result?.summary.reporting,
            !!liveReport,
          )}
          live={!!liveReport}
          onScrub={onScrub}
          onFocusRange={
            onFocusRange
              ? (start, end) => {
                  setReportOpen(false);
                  onFocusRange(start, end);
                }
              : undefined
          }
        />
      ) : (
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
              times={times}
              traces={traces}
              baseline={comparison}
              cursorTime={cursorTime}
              onScrub={onScrub}
              timeRange={activeTimeRange}
              onTimeRangeChange={changeTimeRange}
            />
          ))}
        </div>
      )}
    </section>
  );
}
