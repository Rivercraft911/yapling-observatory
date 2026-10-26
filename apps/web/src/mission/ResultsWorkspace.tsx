import { useState, type ReactNode } from 'react';
import type { RunSnapshot } from '../types';
import { PlotDock } from '../plots/PlotDock';
import { MissionReport } from './MissionReport';
import { missionReport, reportMegabytes, type MissionReport as Report } from './missionReporting';
import './results-workspace.css';

function knownTotal(values: (number | null | undefined)[]) {
  return values.length &&
    values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? values.reduce<number>((total, value) => total + value!, 0)
    : null;
}

function durationText(seconds: number | null) {
  if (seconds === null) return '—';
  return seconds >= 86400
    ? `${(seconds / 86400).toLocaleString(undefined, { maximumFractionDigits: 2 })} d`
    : seconds >= 3600
      ? `${(seconds / 3600).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`
      : `${(seconds / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
}

function passCount(report: Report | null, live: boolean) {
  if (!report) return null;
  if (live) {
    const completed = (report as Report & { completed_pass_count?: unknown }).completed_pass_count;
    return typeof completed === 'number' && Number.isInteger(completed) && completed >= 0
      ? completed
      : null;
  }
  return report.passes.every((pass) => Number.isInteger(pass.pass_index) && pass.pass_index > 0)
    ? new Set(report.passes.map((pass) => pass.pass_index)).size
    : null;
}

export function ResultsWorkspace({
  snapshot,
  baseline,
  cursorTime,
  onScrub,
  liveReport,
  actions,
}: {
  snapshot: RunSnapshot | null;
  baseline: RunSnapshot | null;
  cursorTime: number;
  onScrub: (time: number) => void;
  liveReport?: unknown;
  actions?: ReactNode;
}) {
  const [view, setView] = useState<'charts' | 'report'>('charts');
  const history = snapshot?.run.result;
  const completed = missionReport(history?.summary.reporting);
  const progress = missionReport(liveReport, true);
  const showingLive = !!progress && (view === 'report' || !history);
  const report = showingLive ? progress : completed;
  const duration =
    !showingLive && typeof history?.summary.computed_duration_s === 'number'
      ? history.summary.computed_duration_s
      : report
        ? knownTotal(report.days.map((day) => day.computed_duration_s))
        : null;
  const passes = passCount(report, showingLive);
  const frameModeled = report?.delivery_kind === 'explicit_receiver_frame_model';
  const totals = (
    direction: 'uplink' | 'downlink',
    metric: 'ideal_capacity_bits' | 'delivered_useful_bits',
  ) => (report ? knownTotal(report.days.map((day) => day[direction]?.[metric])) : null);
  const rfTotal = (direction: 'uplink' | 'downlink') => {
    if (showingLive) return totals(direction, 'ideal_capacity_bits');
    const value = history?.summary.ideal_capacity_bits?.[direction];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const frameTotal = (direction: 'uplink' | 'downlink') => {
    if (!frameModeled) return null;
    if (showingLive) {
      const uncertain = report?.days.some(
        (day) => (day[direction] as { delivery_available?: boolean })?.delivery_available !== true,
      );
      return uncertain ? null : totals(direction, 'delivered_useful_bits');
    }
    const delivery = history?.summary.radio_delivery as
      | Partial<
          Record<
            'uplink' | 'downlink',
            { delivery_available?: boolean; delivered_useful_bits?: unknown }
          >
        >
      | undefined;
    const row = delivery?.[direction];
    return row?.delivery_available === true &&
      typeof row.delivered_useful_bits === 'number' &&
      Number.isFinite(row.delivered_useful_bits)
      ? row.delivered_useful_bits
      : null;
  };
  const endReason =
    typeof history?.summary.end_reason === 'string' ? history.summary.end_reason : null;
  const stopped = !!endReason && endReason !== 'requested_duration';
  return (
    <section className="results-workspace" aria-label="Mission results">
      <header className="results-heading">
        <div className="results-identity">
          <span className="results-eyebrow">RESULTS</span>
          <h1>
            {showingLive ? 'Mission computing' : snapshot?.scenario.name || 'Mission results'}
          </h1>
          <span
            className={`results-history-state ${stopped && !showingLive ? 'is-stopped' : ''}`}
            title={stopped && !showingLive ? endReason?.replaceAll('_', ' ') : undefined}
          >
            {showingLive
              ? 'Live daily totals'
              : history
                ? `${stopped ? 'Stopped' : 'History'} · ${snapshot.run.run_id.slice(0, 8)}`
                : 'No completed history'}
          </span>
        </div>
        {actions && <div className="results-actions">{actions}</div>}
      </header>
      <nav className="results-views" aria-label="Results views">
        <button aria-pressed={view === 'charts'} onClick={() => setView('charts')}>
          Charts
        </button>
        <button aria-pressed={view === 'report'} onClick={() => setView('report')}>
          Daily & passes{progress && <span className="results-live-mark">LIVE</span>}
        </button>
        {baseline?.run.result && (
          <span className="results-comparison">Comparison · {baseline.run.run_id.slice(0, 8)}</span>
        )}
      </nav>
      <dl
        className="results-summary"
        aria-label={showingLive ? 'Live report summary' : 'Displayed history summary'}
      >
        <div>
          <dt>{showingLive ? 'Computed so far' : 'Computed'}</dt>
          <dd>{durationText(duration)}</dd>
        </div>
        <div
          title={
            showingLive
              ? 'Returned completed-pass count; the current pass may still be open.'
              : 'Unique geometric pass IDs, including clipped passes. A midnight-crossing pass is counted once.'
          }
        >
          <dt>{showingLive ? 'Completed passes' : 'Unique passes'}</dt>
          <dd>{passes === null ? '—' : passes.toLocaleString()}</dd>
        </div>
        <div title="Modeled completed-frame GCS payload under the recorded receiver and overhead assumptions. A dash preserves unresolved data; no traffic queue or measured receiver reliability is implied.">
          <dt>Frame payload · UL / DL</dt>
          <dd>
            {frameModeled ? (
              <>
                <span className="uplink-color">{reportMegabytes(frameTotal('uplink'))}</span> /{' '}
                {reportMegabytes(frameTotal('downlink'))}
                <small>MB</small>
              </>
            ) : report ? (
              'Not modeled'
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div title="Legacy RF rate estimate with its original net-efficiency assumption. It uses a different boundary from exact frame payload and is not a universal upper bound.">
          <dt>RF estimate · UL / DL</dt>
          <dd>
            <span className="uplink-color">{reportMegabytes(rfTotal('uplink'))}</span> /{' '}
            {reportMegabytes(rfTotal('downlink'))}
            <small>MB</small>
          </dd>
        </div>
      </dl>
      <div className="results-content">
        {view === 'charts' ? (
          <PlotDock
            snapshot={snapshot}
            baseline={baseline}
            cursorTime={cursorTime}
            onScrub={onScrub}
            showReportTab={false}
          />
        ) : (
          <MissionReport report={report} live={showingLive} onScrub={onScrub} />
        )}
      </div>
    </section>
  );
}
