import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Field, Select } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';
import type { UhfBeaconConfig } from './uhfTypes';

interface UhfPreview {
  airtime: { packet_airtime_s: number };
  beacon: { duty_fraction: number };
  power: { average_electrical_w: number | null; average_heat_w: number | null };
  missing_inputs: string[];
}

export function MissionUhfControls({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const radio = config.uhf_beacon;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ key: string; data: UhfPreview } | null>(null);
  const request = useRef(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    setLoading(false);
    return () => {
      request.current++;
      abort.current?.abort();
    };
  }, [config]);
  const key = radio ? JSON.stringify(radio) : '';
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null);
    setError('');
    if (key)
      api<UhfPreview>('/api/mission/uhf-beacon/preview', {
        method: 'POST',
        body: key,
        signal: controller.signal,
      })
        .then((data) => {
          if (!controller.signal.aborted) setPreview({ key, data });
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : 'UHF preview unavailable');
        });
    return () => controller.abort();
  }, [key]);
  const enable = async (enabled: boolean) => {
    const version = ++request.current;
    abort.current?.abort();
    if (!enabled) {
      setLoading(false);
      edit((draft) => {
        delete draft.uhf_beacon;
      });
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError('');
    try {
      const defaults = await api<UhfBeaconConfig>('/api/mission/uhf-beacon/default', {
        signal: controller.signal,
      });
      if (request.current === version)
        edit((draft) => {
          draft.uhf_beacon = defaults;
        });
    } catch (cause) {
      if (request.current === version)
        setError(cause instanceof Error ? cause.message : 'UHF profile unavailable');
    } finally {
      if (request.current === version) setLoading(false);
    }
  };
  const change = (update: (draft: UhfBeaconConfig) => void) =>
    edit((draft) => {
      if (draft.uhf_beacon) update(draft.uhf_beacon);
    });
  const data = preview?.key === key ? preview.data : null;
  return (
    <>
      <label className="spacecraft-follow">
        <input
          type="checkbox"
          checked={!!radio}
          disabled={loading}
          onChange={(event) => void enable(event.target.checked)}
        />
        {loading ? 'Loading UHF' : 'LoRa beacon'}
      </label>
      {error && <small role="alert">{error}</small>}
      {radio && (
        <>
          <fieldset>
            <legend>
              MINIF27 <span>SPACECRAFT BEACON</span>
            </legend>
            <Field
              label="Beacon interval"
              unit="s"
              value={radio.interval_s}
              min={1}
              max={86400}
              step={1}
              onChange={(value) =>
                change((d) => {
                  d.interval_s = value;
                })
              }
            />
            <Field
              label="Frequency"
              unit="MHz"
              value={radio.frequency_hz / 1e6}
              min={100}
              max={1000}
              step={0.1}
              onChange={(value) =>
                change((d) => {
                  d.frequency_hz = value * 1e6;
                })
              }
            />
            <Field
              label="RF port output"
              unit="dBm"
              value={radio.tx_power_dbm}
              min={-10}
              max={30}
              step={1}
              onChange={(value) =>
                change((d) => {
                  d.tx_power_dbm = value;
                })
              }
            />
            <Select
              label="Spreading factor"
              value={String(radio.modulation.spreading_factor)}
              options={[5, 6, 7, 8, 9, 10, 11, 12].map((value) => ({
                value: String(value),
                label: `SF${value}`,
              }))}
              onChange={(value) =>
                change((d) => {
                  d.modulation.spreading_factor = Number(value);
                  d.receiver_threshold_dbm = null;
                })
              }
            />
            <Select
              label="Bandwidth"
              value={String(radio.modulation.bandwidth_hz)}
              options={[125000, 250000, 500000].map((value) => ({
                value: String(value),
                label: `${value / 1000} kHz`,
              }))}
              onChange={(value) =>
                change((d) => {
                  d.modulation.bandwidth_hz = Number(value);
                  d.receiver_threshold_dbm = null;
                })
              }
            />
            <Select
              label="Coding rate"
              value={String(radio.modulation.coding_rate_denominator)}
              options={[5, 6, 7, 8].map((value) => ({ value: String(value), label: `4/${value}` }))}
              onChange={(value) =>
                change((d) => {
                  d.modulation.coding_rate_denominator = Number(value);
                  d.receiver_threshold_dbm = null;
                })
              }
            />
            <Field
              label="Beacon payload"
              unit="byte"
              value={radio.modulation.payload_bytes}
              min={1}
              max={255}
              step={1}
              onChange={(value) =>
                change((d) => {
                  d.modulation.payload_bytes = value;
                })
              }
            />
            {data && (
              <div className="mission-radio-ledger">
                <span>
                  Airtime <strong>{data.airtime.packet_airtime_s.toFixed(3)} s</strong>
                </span>
                <span>
                  TX duty <strong>{(data.beacon.duty_fraction * 100).toFixed(2)}%</strong>
                </span>
              </div>
            )}
          </fieldset>
          <fieldset>
            <legend>UHF POWER</legend>
            <Field
              label="TX electrical"
              unit="W"
              value={radio.tx_electrical_w}
              min={0}
              max={20}
              step={0.01}
              onChange={(value) =>
                change((d) => {
                  d.tx_electrical_w = value;
                })
              }
            />
            <Field
              label="RX electrical"
              unit="W"
              value={radio.idle_electrical_w}
              min={0}
              max={20}
              step={0.001}
              onChange={(value) =>
                change((d) => {
                  d.idle_electrical_w = value;
                })
              }
            />
            <Field
              label="TX feed loss · assumed"
              unit="dB"
              value={radio.tx_feed_loss_db}
              min={0}
              max={50}
              step={0.1}
              onChange={(value) =>
                change((d) => {
                  d.tx_feed_loss_db = value;
                })
              }
            />
            {data && (
              <div className="mission-radio-ledger">
                <span>
                  Mean draw{' '}
                  <strong>
                    {data.power.average_electrical_w == null
                      ? '—'
                      : `${data.power.average_electrical_w.toFixed(3)} W`}
                  </strong>
                </span>
                <span>
                  Mean heat{' '}
                  <strong>
                    {data.power.average_heat_w == null
                      ? '—'
                      : `${data.power.average_heat_w.toFixed(3)} W`}
                  </strong>
                </span>
              </div>
            )}
            <small title="Manufacturer-condition reference: TX 500 mA at 5 V; RX 6 mA at 3.3 V. Converter and harness losses are not measured. S-band idle power is a separate load.">
              Published current reference · editable
            </small>
          </fieldset>
          <details className="mission-details">
            <summary>Beacon antennas & ground receiver</summary>
            <Select
              label="Spacecraft UHF antenna"
              value={radio.antenna_variant}
              options={[
                { value: 'dipole', label: 'Dipole' },
                { value: 'turnstile', label: 'Turnstile' },
              ]}
              onChange={(value) =>
                change((d) => {
                  d.antenna_variant = value as UhfBeaconConfig['antenna_variant'];
                })
              }
            />
            <Field
              label="Ground Yagi gain"
              unit="dBi"
              value={radio.ground_peak_gain_dbi}
              min={0}
              max={40}
              step={0.1}
              onChange={(value) =>
                change((d) => {
                  d.ground_peak_gain_dbi = value;
                })
              }
            />
            <small title="User-reported 15 dBi ground Yagi also applies reciprocally to the UHF uplink antenna at the same frequency and antenna state. This beacon model evaluates spacecraft-to-ground only; ground TX power and the spacecraft receiver threshold are not configured here.">
              15 dBi reported · UHF uplink chain unresolved
            </small>
            <Field
              label="Ground RX sensitivity"
              unit="dBm"
              value={radio.receiver_threshold_dbm}
              min={-180}
              max={0}
              step={1}
              onChange={(value) =>
                change((d) => {
                  d.receiver_threshold_dbm = value;
                })
              }
            />
            {radio.receiver_threshold_dbm == null && (
              <small>Ground sensitivity needed for beacon margin.</small>
            )}
            <Field
              label="Radiation efficiency"
              unit="%"
              value={radio.radiation_efficiency * 100}
              min={0}
              max={100}
              step={1}
              onChange={(value) =>
                change((d) => {
                  d.radiation_efficiency = value / 100;
                })
              }
            />
          </details>
        </>
      )}
    </>
  );
}
