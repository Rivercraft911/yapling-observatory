import type { RunSnapshot } from '../types';
import { closestIndex } from './TracePlot';
import { powerReadout } from './powerReadout';
import './power-status.css';

function value(number: number | null, unit: string, signed = false) {
  return number === null ? '—' : `${signed && number > 0 ? '+' : ''}${number.toFixed(2)} ${unit}`;
}

export function PowerStatus({
  snapshot,
  cursorTime,
  expanded = false,
}: {
  snapshot: RunSnapshot | null;
  cursorTime: number;
  expanded?: boolean;
}) {
  if (!snapshot?.run.result?.samples.power) return null;
  const data = powerReadout(snapshot, closestIndex(snapshot.run.result.samples.time_s, cursorTime));
  return (
    <div className="power-status" aria-label="Power at replay time">
      <dl className="power-now">
        <div title="Available solar power at the common bus, before curtailment.">
          <dt>Solar</dt>
          <dd>{value(data.solar, 'W')}</dd>
        </div>
        <div title="Total requested spacecraft load, including radio and actuators.">
          <dt>Draw</dt>
          <dd>{value(data.draw, 'W')}</dd>
        </div>
        <div title="Solar available minus requested draw. Battery limits and curtailment can prevent this surplus from being stored.">
          <dt>Net</dt>
          <dd
            className={data.net === null ? '' : data.net >= 0 ? 'power-surplus' : 'power-deficit'}
          >
            {value(data.net, 'W', true)}
          </dd>
        </div>
        <div title="Charge state from the electrical model at the replay cursor.">
          <dt>SOC</dt>
          <dd>{value(data.soc === null ? null : data.soc * 100, '%')}</dd>
        </div>
      </dl>
      {expanded && (
        <dl className="power-run" aria-label="Whole run energy">
          <span>RUN</span>
          <div title="Solar energy actually accepted at the bus, after curtailment.">
            <dt>Solar used</dt>
            <dd>{value(data.usedSolarJ === null ? null : data.usedSolarJ / 3600, 'Wh')}</dd>
          </div>
          <div>
            <dt>Load</dt>
            <dd>{value(data.loadJ === null ? null : data.loadJ / 3600, 'Wh')}</dd>
          </div>
          <div title="Final minus initial stored chemical energy over the whole returned run, including battery losses. Independent of graph zoom.">
            <dt>Stored Δ</dt>
            <dd>
              {value(data.storedDeltaJ === null ? null : data.storedDeltaJ / 3600, 'Wh', true)}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}
