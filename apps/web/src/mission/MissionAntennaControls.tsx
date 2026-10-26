import { useState } from 'react';
import { AntennaControls } from '../controls/RadioControls';
import type { Direction, Variant } from '../types';
import type { MissionConfig } from './missionTypes';
import { MissionUhfControls } from './MissionUhfControls';

export function MissionAntennaControls({
  config,
  edit,
  onVariant,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
  onVariant?: (variant: Variant) => void;
}) {
  const [band, setBand] = useState<'sband' | 'uhf'>('sband');
  const [direction, setDirection] = useState<Direction>('downlink');
  return (
    <>
      <nav className="mission-mode-selector" aria-label="Antenna band">
        <button aria-pressed={band === 'sband'} onClick={() => setBand('sband')}>
          S-band
        </button>
        <button aria-pressed={band === 'uhf'} onClick={() => setBand('uhf')}>
          UHF
        </button>
      </nav>
      {band === 'uhf' ? (
        <MissionUhfControls
          config={config}
          edit={edit}
          antennaOnly
          onVariant={(variant) => {
            edit((draft) => {
              if (!draft.uhf_beacon) return;
              draft.uhf_beacon.antenna_variant = variant;
              draft.antenna_variant = variant;
            });
            onVariant?.(variant);
          }}
        />
      ) : (
        <>
          <nav className="mission-mode-selector" aria-label="Antenna direction">
            {(['uplink', 'downlink'] as const).map((choice) => (
              <button
                key={choice}
                aria-pressed={direction === choice}
                onClick={() => setDirection(choice)}
              >
                {choice === 'uplink' ? 'Uplink' : 'Downlink'}
              </button>
            ))}
          </nav>
          <fieldset>
            <legend>S-BAND ANTENNAS</legend>
            <AntennaControls
              key={direction}
              direction={direction}
              link={config[direction]}
              antennaVariant={config.antenna_variant}
              onChange={(change) => edit((draft) => change(draft[direction]))}
              onVariant={(variant) => {
                edit((draft) => {
                  draft.antenna_variant = variant;
                });
                onVariant?.(variant);
              }}
            />
          </fieldset>
        </>
      )}
    </>
  );
}
