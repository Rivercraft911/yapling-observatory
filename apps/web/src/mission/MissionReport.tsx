import { useState } from 'react';
import type { MissionReport as Report } from './missionReporting';
import { reportCsv, reportMegabytes } from './missionReporting';

export function MissionReport({
  report,
  onScrub,
  onFocusRange,
  live = false,
}: {
  report: Report | null;
  onScrub: (time: number) => void;
  onFocusRange?: (start: number, end: number) => void;
  live?: boolean;
}) {
  const [view, setView] = useState<'days' | 'passes'>('days');
  const [metric, setMetric] = useState<'ideal_capacity_bits' | 'delivered_useful_bits'>(
    'delivered_useful_bits',
  );
  if (!report)
    return (
      <div className="mission-report-empty">
        Run a mission to build daily and pass totals. Older saved runs retain their original
        results.
      </div>
    );
  const hasDelivery = report.delivery_kind === 'explicit_receiver_frame_model';
  const chosenView = live ? 'days' : view;
  const chosenMetric = hasDelivery ? metric : 'ideal_capacity_bits';
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([reportCsv(report)], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `mission-daily-${report.days[0]?.date_utc || 'report'}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="mission-report">
      <div className="mission-report-toolbar">
        <div role="group" aria-label="Report periods">
          <button aria-pressed={chosenView === 'days'} onClick={() => setView('days')}>
            Daily
          </button>
          <button
            aria-pressed={chosenView === 'passes'}
            disabled={live}
            onClick={() => setView('passes')}
          >
            Passes <span>{live ? '…' : report.passes.length}</span>
          </button>
        </div>
        <div role="group" aria-label="Report data metric">
          <button
            aria-pressed={chosenMetric === 'ideal_capacity_bits'}
            onClick={() => setMetric('ideal_capacity_bits')}
            title="Legacy RF rate estimate using the radio profile efficiency. Exact frame payload uses separate framing assumptions, so this is not a universal upper bound."
          >
            RF estimate
          </button>
          <button
            aria-pressed={chosenMetric === 'delivered_useful_bits'}
            disabled={!hasDelivery}
            onClick={() => setMetric('delivered_useful_bits')}
            title={
              hasDelivery
                ? 'Modeled completed-frame payload under the selected receiver assumptions. A dash means unresolved channel or threshold, not zero delivery.'
                : 'Enable frame accounting under Link and run again.'
            }
          >
            Frame payload
          </button>
        </div>
        <button className="text-button" onClick={download}>
          CSV ↗
        </button>
      </div>
      <div className="mission-report-table">
        <table>
          <caption>
            {chosenView === 'days' ? 'UTC days' : 'Geometric passes'} ·{' '}
            {chosenMetric === 'ideal_capacity_bits' ? 'RF rate estimate' : 'modeled frame payload'}{' '}
            · MB = 10⁶ bytes
          </caption>
          <thead>
            <tr>
              <th>{chosenView === 'days' ? 'UTC day' : 'AOS · UTC'}</th>
              <th>{chosenView === 'days' ? 'Passes' : 'Peak EL'}</th>
              <th title="Scheduled radio time while above the station elevation mask.">
                Contact · min
              </th>
              <th className="uplink-color">UL · MB</th>
              <th>DL · MB</th>
            </tr>
          </thead>
          <tbody>
            {chosenView === 'days'
              ? report.days.map((day) => (
                  <tr key={day.date_utc}>
                    <td>
                      <button
                        disabled={live}
                        onClick={() =>
                          onFocusRange ? onFocusRange(day.start_s, day.end_s) : onScrub(day.start_s)
                        }
                        title={`${onFocusRange ? 'Focus charts · ' : ''}${day.start_utc} to ${day.end_utc}${day.endpoint_only ? '; frames completing exactly at the final UTC midnight, with no following duration computed' : day.partial_day ? '; partial UTC day' : ''}`}
                      >
                        {day.date_utc}
                        {day.partial_day && (
                          <sup>{day.endpoint_only ? ' boundary' : ' partial'}</sup>
                        )}
                      </button>
                    </td>
                    <td title="Geometric passes intersecting this UTC day. A midnight-crossing pass appears in both days.">
                      {day.geometric_pass_count}
                    </td>
                    <td>{(day.scheduled_contact_s / 60).toFixed(1)}</td>
                    <td className="uplink-color">{reportMegabytes(day.uplink[chosenMetric])}</td>
                    <td>{reportMegabytes(day.downlink[chosenMetric])}</td>
                  </tr>
                ))
              : report.passes.map((pass) => (
                  <tr key={pass.pass_index}>
                    <td>
                      <button
                        onClick={() =>
                          onFocusRange
                            ? onFocusRange(pass.start_s, pass.end_s)
                            : onScrub(pass.start_s)
                        }
                        title={`${onFocusRange ? 'Focus charts · ' : ''}${pass.start_utc} to ${pass.end_utc}`}
                      >
                        {pass.start_utc.replace('T', ' ').replace('Z', '')}
                        {(pass.start_clipped || pass.end_clipped) && <sup> clipped</sup>}
                      </button>
                    </td>
                    <td>{pass.max_elevation_deg.toFixed(1)}°</td>
                    <td>{(pass.scheduled_contact_s / 60).toFixed(1)}</td>
                    <td className="uplink-color">{reportMegabytes(pass.uplink[chosenMetric])}</td>
                    <td>{reportMegabytes(pass.downlink[chosenMetric])}</td>
                  </tr>
                ))}
          </tbody>
        </table>
        {chosenView === 'passes' && report.passes.length === 0 && (
          <p className="mission-report-empty">No geometric passes in the computed interval.</p>
        )}
      </div>
      <div className="mission-report-boundary" title={report.interval_semantics}>
        {live ? 'Computing · totals so far' : 'Computed'} {report.computed_start_utc} →{' '}
        {report.computed_end_utc}
      </div>
    </div>
  );
}
