import { useMemo, useState } from 'react';
import type { Direction, RunSnapshot, Scenario } from '../types';
import type { MissionConfig } from '../mission/missionTypes';
import { buildGroundTrack } from './groundTrack';
import { FlatGroundTrack } from './FlatGroundTrack';
import { useGroundCoverage } from './useGroundCoverage';

export function GroundTrackWorkspace({
  snapshot,
  scenario,
  sampleIndex,
  windowSeconds,
}: {
  snapshot: RunSnapshot;
  scenario: MissionConfig | Scenario | null;
  sampleIndex: number;
  windowSeconds: number;
}) {
  const [direction, setDirection] = useState<Direction>('downlink');
  const [heightKm, setHeightKm] = useState<number | null>(null);
  const [polarizationLossDb, setPolarizationLossDb] = useState(0);
  const coverage = useGroundCoverage(
    scenario,
    direction,
    heightKm === null ? null : heightKm * 1000,
    polarizationLossDb,
  );
  const samples = snapshot.run.result?.samples;
  const time = samples?.time_s[sampleIndex] ?? 0;
  const windowTime = Number.isFinite(windowSeconds) ? Math.floor(time / 60) * 60 : 0;
  const maxGapS = snapshot.scenario.step_s * 3;
  const track = useMemo(
    () =>
      samples
        ? buildGroundTrack(samples, {
            cursorTimeS: windowTime,
            windowSeconds,
            maxGapS,
            maxMarkers: 64,
          })
        : null,
    [samples, windowTime, windowSeconds, maxGapS],
  );
  const station = snapshot.scenario.station;
  const resolvedHeightKm = coverage.data ? coverage.data.altitude_m / 1000 : null;
  return (
    <>
      <FlatGroundTrack
        track={track}
        currentPositionEcefM={samples?.satellite_position_ecef_m[sampleIndex]}
        station={{
          latitudeDeg: station.latitude_deg,
          longitudeDeg: station.longitude_deg,
          label: 'DURAND',
        }}
        coverage={coverage.data}
        coverageState={coverage.state}
        coverageError={coverage.error}
      />
      <div className="ground-coverage-controls" aria-label="Coverage inputs">
        <select
          aria-label="Coverage direction"
          value={direction}
          onChange={(event) => setDirection(event.target.value as Direction)}
        >
          <option value="downlink">Downlink</option>
          <option value="uplink">Uplink</option>
        </select>
        <label title="Fixed geodetic height for these planning contours. Empty uses the run's nominal orbital height, not the spacecraft's instantaneous height.">
          Height{' '}
          <input
            key={`${snapshot.run.run_id}-${heightKm}`}
            aria-label="Coverage height in kilometres"
            type="number"
            min="100"
            max="50000"
            step="10"
            defaultValue={heightKm ?? ''}
            placeholder={resolvedHeightKm === null ? 'Orbit' : resolvedHeightKm.toFixed(0)}
            onBlur={(event) => {
              if (!event.target.value.trim()) setHeightKm(null);
              else {
                const value = event.target.valueAsNumber;
                if (Number.isFinite(value) && value >= 100 && value <= 50000) setHeightKm(value);
                else event.target.value = heightKm === null ? '' : String(heightKm);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />{' '}
          km
        </label>
        <label title="Assumed polarization loss for the coverage calculation. Zero is matched polarization. Actual run coupling remains in the sampled track and link plots.">
          Pol. loss{' '}
          <input
            aria-label="Coverage polarization loss in decibels"
            type="number"
            min="0"
            max="60"
            step="0.5"
            defaultValue={polarizationLossDb}
            onBlur={(event) => {
              const value = event.target.valueAsNumber;
              if (Number.isFinite(value) && value >= 0 && value <= 60) setPolarizationLossDb(value);
              else event.target.value = String(polarizationLossDb);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />{' '}
          dB
        </label>
        {coverage.error && (
          <button
            className="ground-coverage-retry"
            type="button"
            title={coverage.error}
            onClick={coverage.retry}
          >
            Retry contours
          </button>
        )}
        <details className="ground-coverage-assumptions">
          <summary title="Conditional coverage uses peak gains and perfect tracking. It does not predict receiver lock or delivered data.">
            Peak-gain estimate
          </summary>
          <div>
            <strong>Run inputs · ideal tracking</strong>
            {coverage.data?.assumptions.map((assumption, index) => (
              <p key={index}>{assumption}</p>
            ))}
            {!coverage.data && (
              <p>
                Contours use the stored run, the selected height and explicit polarization loss.
              </p>
            )}
          </div>
        </details>
      </div>
    </>
  );
}
