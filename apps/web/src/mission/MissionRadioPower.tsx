import { useEffect, useState } from 'react';
import { api } from '../api';
import { Field } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';

interface RadioPowerPreview {
  transmit: {
    electrical_w: number;
    rf_output_w: number;
    transmitter_heat_w: number;
    feed_heat_w: number;
    antenna_heat_w: number;
    escaped_rf_w: number;
    total_heat_w: number;
    radiation_efficiency: number;
  };
  receive: { electrical_w: number; heat_w: number };
  idle: { electrical_w: number; heat_w: number };
}

export function MissionRadioPower({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const power = config.power;
  const requestKey = JSON.stringify({
    tx_electrical_w: power.spacecraft_tx_electrical_w,
    rx_electrical_w: power.spacecraft_receive_w,
    idle_electrical_w: power.radio_idle_w,
    downlink: config.downlink,
    analytical_radiation_efficiency: power.transmit_radiation_efficiency,
  });
  const [preview, setPreview] = useState<{ key: string; value: RadioPowerPreview } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setPreview(null);
    setFailure(null);
    api<RadioPowerPreview>('/api/mission/radio-power', {
      method: 'POST',
      body: requestKey,
      signal: abort.signal,
    })
      .then((value) => {
        if (!abort.signal.aborted) setPreview({ key: requestKey, value });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setFailure({
            key: requestKey,
            message: error instanceof Error ? error.message : 'Radio preview unavailable',
          });
      });
    return () => abort.abort();
  }, [requestKey]);
  const current = preview?.key === requestKey ? preview.value : null;
  const error = failure?.key === requestKey ? failure.message : null;
  return (
    <fieldset>
      <legend>
        SPACECRAFT RADIO <span>downlink TX</span>
      </legend>
      <Field
        label="TX electrical"
        unit="W"
        value={power.spacecraft_tx_electrical_w}
        min={0}
        max={1000}
        step={0.1}
        onChange={(v) =>
          edit((d) => {
            d.power.spacecraft_tx_electrical_w = v;
          })
        }
      />
      <div title="Conducted RF output at the radio/PA port, before transmitter feed loss.">
        <Field
          label="RF port output"
          unit="W"
          value={config.downlink.tx_power_w}
          min={0.0001}
          max={1000}
          step={0.1}
          onChange={(v) =>
            edit((d) => {
              d.downlink.tx_power_w = v;
            })
          }
        />
      </div>
      <div className="mission-radio-ledger" aria-live="polite">
        {current ? (
          <>
            <span>
              TX total heat <strong>{current.transmit.total_heat_w.toFixed(2)} W</strong>
            </span>
            <span>
              Escaping RF <strong>{current.transmit.escaped_rf_w.toFixed(2)} W</strong>
            </span>
          </>
        ) : (
          <small title={error || undefined}>
            {error ? 'Radio preview unavailable' : 'Calculating radio power…'}
          </small>
        )}
      </div>
      <details className="mission-details">
        <summary>RF power boundaries</summary>
        <small>
          RF port output precedes the feed. Total spacecraft heat includes transmitter, feed and
          antenna losses.
        </small>
        <Field
          label="TX feed loss"
          unit="dB"
          value={config.downlink.tx_feed_loss_db}
          min={0}
          max={100}
          step={0.1}
          onChange={(v) =>
            edit((d) => {
              d.downlink.tx_feed_loss_db = v;
            })
          }
        />
        {config.downlink.spacecraft_antenna !== 'spherical_harmonic' && (
          <Field
            label="Radiation efficiency"
            unit="%"
            value={power.transmit_radiation_efficiency * 100}
            min={0}
            max={100}
            step={1}
            onChange={(v) =>
              edit((d) => {
                d.power.transmit_radiation_efficiency = v / 100;
              })
            }
          />
        )}
        {current && (
          <div className="mission-radio-ledger">
            <span>
              Transmitter heat <strong>{current.transmit.transmitter_heat_w.toFixed(2)} W</strong>
            </span>
            <span>
              Feed heat <strong>{current.transmit.feed_heat_w.toFixed(2)} W</strong>
            </span>
            <span>
              Antenna heat <strong>{current.transmit.antenna_heat_w.toFixed(2)} W</strong>
            </span>
            <span>
              Radiation efficiency{' '}
              <strong>{(current.transmit.radiation_efficiency * 100).toFixed(1)}%</strong>
            </span>
          </div>
        )}
      </details>
      <Field
        label="RX electrical"
        unit="W"
        value={power.spacecraft_receive_w}
        min={0}
        max={1000}
        step={0.1}
        onChange={(v) =>
          edit((d) => {
            d.power.spacecraft_receive_w = v;
          })
        }
      />
      <Field
        label="Radio idle"
        unit="W"
        value={power.radio_idle_w}
        min={0}
        max={1000}
        step={0.1}
        onChange={(v) =>
          edit((d) => {
            d.power.radio_idle_w = v;
          })
        }
      />
    </fieldset>
  );
}
