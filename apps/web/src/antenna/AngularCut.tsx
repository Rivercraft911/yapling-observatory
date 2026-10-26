import type { Pattern } from './types';

export function AngularCut({
  pattern,
  kind,
}: {
  pattern: Pattern | null;
  kind: 'azimuth' | 'elevation';
}) {
  const cut = pattern?.cuts?.[kind];
  const peak = pattern?.peak_gain_dbi ?? 0;
  const lower = Math.floor(peak / 5) * 5 - 30,
    upper = Math.ceil(peak / 5) * 5;
  const width = 520,
    height = 160,
    left = 43,
    right = 13,
    top = 14,
    bottom = 28;
  const minAngle = kind === 'azimuth' ? -180 : -90,
    maxAngle = -minAngle;
  const x = (angle: number) =>
    left + ((angle - minAngle) / (maxAngle - minAngle)) * (width - left - right);
  const y = (gain: number) =>
    top +
    ((upper - Math.max(lower, Math.min(upper, gain))) / (upper - lower || 1)) *
      (height - top - bottom);
  let path = '';
  cut?.gain_dbi.forEach((gain, i) => {
    path += `${i === 0 ? 'M' : 'L'}${x(cut.angle_deg[i]).toFixed(2)},${y(gain ?? lower).toFixed(2)} `;
  });
  const ticks = [lower, (upper + lower) / 2, upper];
  const halfPower = cut?.half_power;
  const intervals =
    halfPower?.lower_deg != null && halfPower.upper_deg != null
      ? (kind === 'azimuth' ? [-360, 0, 360] : [0])
          .map((shift) => [
            Math.max(minAngle, halfPower.lower_deg! + shift),
            Math.min(maxAngle, halfPower.upper_deg! + shift),
          ])
          .filter(([a, b]) => b > a)
      : [];
  return (
    <figure className="antenna-cut">
      <figcaption>
        <strong>{kind === 'azimuth' ? 'Azimuth cut' : 'Elevation cut'}</strong>
        {halfPower?.width_deg != null && (
          <b
            className="beamwidth-label"
            title="Half-power span relative to the largest sampled peak in this cut. The bounds are about 3.01 dB below its peak."
          >
            HPBW {halfPower.width_deg.toFixed(1)}°
          </b>
        )}
        <span>
          {kind === 'azimuth' ? 'elevation' : 'azimuth'} {cut?.fixed_angle_deg ?? 0}° · gain [dBi]
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${kind} gain cut in dBi. Nulls reach the displayed floor; they are not finite gain values.`}
      >
        {intervals.map(([a, b], index) => (
          <g key={`beam-${index}`}>
            <rect
              x={x(a)}
              y={top}
              width={x(b) - x(a)}
              height={height - top - bottom}
              className="cut-beam-shade"
            />
            <line
              x1={x(a)}
              x2={x(b)}
              y1={y(halfPower!.threshold_gain_dbi)}
              y2={y(halfPower!.threshold_gain_dbi)}
              className="cut-beam-bound"
            />
            {[a, b].map((bound) => (
              <line
                key={bound}
                x1={x(bound)}
                x2={x(bound)}
                y1={y(halfPower!.threshold_gain_dbi) - 5}
                y2={height - bottom}
                className="cut-beam-edge"
              />
            ))}
          </g>
        ))}
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="cut-grid" />
            <text x={left - 8} y={y(tick) + 3} textAnchor="end">
              {tick.toFixed(0)}
            </text>
          </g>
        ))}
        {[minAngle, minAngle / 2, 0, maxAngle / 2, maxAngle].map((angle) => (
          <g key={angle}>
            <line x1={x(angle)} x2={x(angle)} y1={top} y2={height - bottom} className="cut-grid" />
            <text x={x(angle)} y={height - 9} textAnchor="middle">
              {angle}°
            </text>
          </g>
        ))}
        {cut ? (
          <path d={path} className="cut-curve" />
        ) : (
          <text x={width / 2} y={height / 2} textAnchor="middle">
            No resolved pattern
          </text>
        )}
      </svg>
      <small>
        {halfPower?.width_deg != null
          ? 'Shaded span: half power, −3.01 dB from the cut peak.'
          : 'Nulls clip at plot floor.'}
      </small>
    </figure>
  );
}
