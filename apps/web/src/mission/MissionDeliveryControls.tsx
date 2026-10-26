import { useEffect, useRef, useState } from 'react';
import { api, APIError } from '../api';
import { Field, Select } from '../controls/RadioControls';
import type { MissionConfig } from './missionTypes';
import type { DeliveryMode, DirectionDelivery, RadioDeliveryConfig } from './radioDeliveryTypes';

export function MissionDeliveryControls({
  config,
  edit,
}: {
  config: MissionConfig;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const linkKey = JSON.stringify({ uplink: config.uplink, downlink: config.downlink });
  const receiverKey = JSON.stringify(config.radio_delivery ?? null);
  useEffect(() => {
    setPending(false);
    setError('');
    return () => {
      version.current++;
      abort.current?.abort();
    };
  }, [linkKey, receiverKey]);
  const delivery = config.radio_delivery;
  const enable = async (enabled: boolean, preset: 'current' | 'adaptive_psk' = 'current') => {
    const request = ++version.current;
    setError('');
    abort.current?.abort();
    abort.current = new AbortController();
    if (!enabled) {
      setPending(false);
      edit((draft) => {
        delete draft.radio_delivery;
      });
      return;
    }
    setPending(true);
    try {
      const profile = await api<RadioDeliveryConfig>('/api/mission/delivery-example', {
        method: 'POST',
        body: JSON.stringify({ ...JSON.parse(linkKey), preset }),
        signal: abort.current.signal,
      });
      if (version.current === request)
        edit((draft) => {
          draft.radio_delivery = profile;
        });
    } catch (cause) {
      if (version.current === request)
        setError(
          cause instanceof APIError &&
            cause.status === 422 &&
            cause.issues.some(
              (issue) =>
                issue.type === 'extra_forbidden' &&
                issue.loc.length === 2 &&
                issue.loc[0] === 'body' &&
                issue.loc[1] === 'preset',
            )
            ? 'Receiver modes could not load: the local service does not support receiver presets. It may be older than this interface. Open the app paired with the current service, then retry.'
            : cause instanceof Error
              ? cause.message
              : 'Receiver profile unavailable',
        );
    } finally {
      if (version.current === request) setPending(false);
    }
  };
  const change = (
    direction: 'uplink' | 'downlink',
    update: (profile: DirectionDelivery) => void,
  ) => {
    version.current++;
    abort.current?.abort();
    setPending(false);
    edit((draft) => {
      if (draft.radio_delivery) update(draft.radio_delivery[direction]);
    });
  };
  const adaptive =
    delivery?.uplink.policy === 'adaptive' && delivery.downlink.policy === 'adaptive';
  const partlyAdaptive =
    !!delivery &&
    !adaptive &&
    (delivery.uplink.policy === 'adaptive' || delivery.downlink.policy === 'adaptive');
  const adaptiveAvailable =
    config.uplink.profile.waveform === 'dvb_s2' &&
    config.downlink.profile.waveform === 'dvb_s2' &&
    (!delivery ||
      (delivery.uplink.hardware_profile === 'generic_dvb_s2_reference' &&
        delivery.downlink.hardware_profile === 'generic_dvb_s2_reference'));
  const setAdaptive = (enabled: boolean) => {
    if (!delivery) {
      if (enabled) void enable(true, 'adaptive_psk');
      return;
    }
    version.current++;
    abort.current?.abort();
    setPending(false);
    setError('');
    edit((draft) => {
      if (!draft.radio_delivery) return;
      for (const direction of ['uplink', 'downlink'] as const) {
        draft.radio_delivery[direction].policy = enabled ? 'adaptive' : 'fixed';
        draft.radio_delivery[direction].schedule = [];
      }
    });
  };
  return (
    <>
      <label
        className="spacecraft-follow"
        title="Switch both directions between adaptive selection and their selected fixed modes. Uses the configured mode set and receiver timings; advanced settings are below."
      >
        <input
          type="checkbox"
          aria-label="Adaptive MODCOD"
          checked={!!adaptive}
          aria-checked={partlyAdaptive ? 'mixed' : !!adaptive}
          disabled={pending || (!adaptive && !adaptiveAvailable)}
          onChange={(event) => setAdaptive(event.target.checked)}
        />
        Adaptive MODCOD
        <span>
          {pending ? 'Loading' : adaptive ? 'Enabled' : partlyAdaptive ? 'Mixed' : 'Disabled'}
        </span>
      </label>
      {error && <small role="alert">{error}</small>}
      <details className="mission-details">
        <summary>MODCOD settings</summary>
        <label className="spacecraft-follow">
          <input
            type="checkbox"
            checked={!!delivery}
            disabled={pending}
            onChange={(event) => void enable(event.target.checked)}
          />
          Model completed frames
        </label>
        <button
          className="text-button"
          disabled={
            pending ||
            config.uplink.profile.waveform !== 'dvb_s2' ||
            config.downlink.profile.waveform !== 'dvb_s2'
          }
          title="Load all 17 normal-frame QPSK/8PSK modes using ideal AWGN thresholds and the RF reserve. Replaces the receiver configuration with an editable adaptive study."
          onClick={() => void enable(true, 'adaptive_psk')}
        >
          Load all 17 QPSK / 8PSK modes
        </button>
        {delivery && (
          <>
            <small>
              {delivery.downlink.policy === 'adaptive' || delivery.uplink.policy === 'adaptive'
                ? 'Ideal channel adaptation · normal frames · AWGN reference'
                : 'Assumed receiver · complete-frame payload'}
            </small>
            {(['uplink', 'downlink'] as const).map((direction) => {
              const profile = delivery[direction];
              return (
                <fieldset key={direction}>
                  <legend>
                    {direction === 'uplink' ? 'UPLINK' : 'DOWNLINK'} <span>receiver</span>
                  </legend>
                  <Select
                    label="Policy"
                    value={profile.policy}
                    options={[
                      { value: 'fixed', label: 'Fixed mode' },
                      {
                        value: 'scheduled',
                        label: 'Scheduled VCM',
                        disabled: profile.hardware_profile !== 'generic_dvb_s2_reference',
                      },
                      {
                        value: 'adaptive',
                        label: 'Adaptive · ideal channel',
                        disabled: profile.hardware_profile !== 'generic_dvb_s2_reference',
                      },
                    ]}
                    onChange={(value) =>
                      change(direction, (p) => {
                        p.policy = value as DirectionDelivery['policy'];
                        if (p.policy !== 'scheduled') p.schedule = [];
                      })
                    }
                  />
                  <Select
                    label="Starting mode"
                    value={profile.initial_mode_id}
                    options={profile.modes.map((m) => ({
                      value: m.mode_id,
                      label: `${m.modulation} ${m.code_rate}`,
                    }))}
                    onChange={(value) =>
                      change(direction, (p) => {
                        p.initial_mode_id = value;
                      })
                    }
                  />
                  {(
                    [
                      'acquisition_s',
                      'reacquisition_s',
                      'mode_change_s',
                      'minimum_dwell_s',
                    ] as const
                  ).map((key) => (
                    <Field
                      key={key}
                      label={
                        {
                          acquisition_s: 'Acquisition',
                          reacquisition_s: 'Reacquisition',
                          mode_change_s: 'Mode change',
                          minimum_dwell_s: 'Minimum dwell',
                        }[key]
                      }
                      unit="s"
                      value={profile[key]}
                      min={0}
                      max={3600}
                      step={0.1}
                      onChange={(value) =>
                        change(direction, (p) => {
                          p[key] = value;
                        })
                      }
                    />
                  ))}
                  <details className="mission-details">
                    <summary>Modes & timing</summary>
                    {profile.modes.map((mode, index) => (
                      <details className="mission-details" key={mode.mode_id}>
                        <summary>
                          {mode.modulation} {mode.code_rate} ·{' '}
                          {(mode.symbol_rate_sps / 1e6).toLocaleString()} Msym/s
                        </summary>
                        <fieldset>
                          <legend>
                            {mode.modulation} {mode.code_rate}
                          </legend>
                          <Select
                            label="Modulation"
                            value={mode.modulation}
                            options={['QPSK', '8PSK'].map((value) => ({ value, label: value }))}
                            onChange={(value) =>
                              change(direction, (p) => {
                                p.modes[index].modulation = value as DeliveryMode['modulation'];
                                p.modes[index].code_rate = '3/4';
                                p.modes[index].decode_threshold_esn0_db = null;
                                p.modes[index].threshold_status = 'unresolved';
                              })
                            }
                          />
                          <Select
                            label="Code rate"
                            value={mode.code_rate}
                            options={(mode.modulation === 'QPSK'
                              ? [
                                  '1/4',
                                  '1/3',
                                  '2/5',
                                  '1/2',
                                  '3/5',
                                  '2/3',
                                  '3/4',
                                  '4/5',
                                  '5/6',
                                  '8/9',
                                  '9/10',
                                ]
                              : ['3/5', '2/3', '3/4', '5/6', '8/9', '9/10']
                            )
                              .filter((value) => mode.frame_size !== 'short' || value !== '9/10')
                              .map((value) => ({ value, label: value }))}
                            onChange={(value) =>
                              change(direction, (p) => {
                                p.modes[index].code_rate = value as DeliveryMode['code_rate'];
                                p.modes[index].decode_threshold_esn0_db = null;
                                p.modes[index].threshold_status = 'unresolved';
                              })
                            }
                          />
                          <Field
                            label="Symbol rate"
                            unit="Msym/s"
                            value={mode.symbol_rate_sps / 1e6}
                            min={0.001}
                            max={100}
                            step={0.1}
                            onChange={(value) =>
                              change(direction, (p) => {
                                p.modes[index].symbol_rate_sps = value * 1e6;
                              })
                            }
                          />
                          <Select
                            label="Frame"
                            value={mode.frame_size}
                            options={[
                              { value: 'short', label: 'Short' },
                              { value: 'normal', label: 'Normal' },
                            ]}
                            onChange={(value) =>
                              change(direction, (p) => {
                                p.modes[index].frame_size = value as DeliveryMode['frame_size'];
                                if (value === 'short' && p.modes[index].code_rate === '9/10')
                                  p.modes[index].code_rate = '3/4';
                                p.modes[index].decode_threshold_esn0_db = null;
                                p.modes[index].threshold_status = 'unresolved';
                              })
                            }
                          />
                          <label className="spacecraft-follow">
                            <input
                              type="checkbox"
                              checked={mode.pilots}
                              onChange={(event) =>
                                change(direction, (p) => {
                                  p.modes[index].pilots = event.target.checked;
                                })
                              }
                            />
                            Pilots
                          </label>
                          <Field
                            label="Decode threshold · assumed"
                            unit="dB Es/N₀"
                            value={mode.decode_threshold_esn0_db}
                            min={-30}
                            max={40}
                            step={0.1}
                            onChange={(value) =>
                              change(direction, (p) => {
                                p.modes[index].decode_threshold_esn0_db = value;
                                p.modes[index].threshold_status = 'illustrative';
                                p.modes[index].threshold_source =
                                  'User-entered hard threshold, not a measured receiver curve';
                              })
                            }
                          />
                          <button
                            className="text-button"
                            disabled={
                              profile.modes.length <= 1 ||
                              profile.initial_mode_id === mode.mode_id ||
                              profile.schedule.some((item) => item.mode_id === mode.mode_id)
                            }
                            onClick={() =>
                              change(direction, (p) => {
                                p.modes.splice(index, 1);
                              })
                            }
                          >
                            Remove mode
                          </button>
                        </fieldset>
                      </details>
                    ))}
                    <button
                      className="text-button"
                      disabled={profile.modes.length >= 32}
                      onClick={() =>
                        change(direction, (p) => {
                          let index = p.modes.length + 1;
                          while (p.modes.some((mode) => mode.mode_id === `${direction}-${index}`))
                            index++;
                          p.modes.push({ ...p.modes[0], mode_id: `${direction}-${index}` });
                        })
                      }
                    >
                      + Mode
                    </button>
                    <Field
                      label="Lock hold through fade"
                      unit="s"
                      value={profile.loss_hold_s}
                      min={0}
                      max={3600}
                      step={0.1}
                      onChange={(value) =>
                        change(direction, (p) => {
                          p.loss_hold_s = value;
                        })
                      }
                    />
                    <Field
                      label="Acquisition reserve"
                      unit="dB"
                      value={profile.acquisition_margin_db}
                      min={0}
                      max={30}
                      step={0.1}
                      onChange={(value) =>
                        change(direction, (p) => {
                          p.acquisition_margin_db = value;
                        })
                      }
                    />
                    <Field
                      label="Lock hold offset"
                      unit="dB"
                      value={profile.hold_margin_db}
                      min={-30}
                      max={0}
                      step={0.1}
                      onChange={(value) =>
                        change(direction, (p) => {
                          p.hold_margin_db = value;
                        })
                      }
                    />
                    <Field
                      label="Application overhead"
                      unit="bit/frame"
                      value={profile.application_overhead_bits_per_frame}
                      min={0}
                      max={60000}
                      step={8}
                      onChange={(value) =>
                        change(direction, (p) => {
                          p.application_overhead_bits_per_frame = value;
                        })
                      }
                    />
                  </details>
                  {profile.policy === 'scheduled' && (
                    <>
                      {profile.schedule.map((item, index) => (
                        <div className="mission-vcm-slot" key={index}>
                          <Field
                            label="T+"
                            unit="s"
                            value={item.start_s}
                            min={0.001}
                            max={config.duration_s}
                            step={1}
                            onChange={(value) =>
                              change(direction, (p) => {
                                p.schedule[index].start_s = value;
                              })
                            }
                          />
                          <Select
                            label="Mode"
                            value={item.mode_id}
                            options={profile.modes.map((mode) => ({
                              value: mode.mode_id,
                              label: mode.mode_id,
                            }))}
                            onChange={(value) =>
                              change(direction, (p) => {
                                p.schedule[index].mode_id = value;
                              })
                            }
                          />
                          <button
                            className="text-button"
                            onClick={() =>
                              change(direction, (p) => {
                                p.schedule.splice(index, 1);
                              })
                            }
                          >
                            Remove switch
                          </button>
                        </div>
                      ))}
                      <button
                        className="text-button"
                        disabled={profile.schedule.length >= 256}
                        onClick={() =>
                          change(direction, (p) => {
                            p.schedule.push({
                              start_s: (p.schedule.at(-1)?.start_s || 0) + 60,
                              mode_id: p.initial_mode_id,
                            });
                          })
                        }
                      >
                        + Scheduled switch
                      </button>
                    </>
                  )}
                </fieldset>
              );
            })}
          </>
        )}
      </details>
    </>
  );
}
