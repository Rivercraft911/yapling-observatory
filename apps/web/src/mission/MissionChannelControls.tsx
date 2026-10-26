import { useEffect, useRef, useState } from 'react';
import { api, APIError } from '../api';
import { Field, Select } from '../controls/RadioControls';
import type { Direction, RadioProfile } from '../types';
import type { MissionConfig } from './missionTypes';
import type { DirectionDelivery } from './radioDeliveryTypes';

interface ChannelResponse {
  profile: RadioProfile;
  delivery: DirectionDelivery | null;
  symbol_rate_sps: number;
  channel_bandwidth_hz: number;
  rolloff: 0.2 | 0.25 | 0.35;
  assumptions: string;
}

function inputKey(config: MissionConfig, direction: Direction) {
  return JSON.stringify({
    direction,
    profile: config[direction].profile,
    delivery: config.radio_delivery?.[direction] ?? null,
  });
}

export function MissionChannelControls({
  config,
  direction,
  edit,
}: {
  config: MissionConfig;
  direction: Direction;
  edit: (change: (draft: MissionConfig) => void) => void;
}) {
  const profile = config[direction].profile;
  const [bandwidthMHz, setBandwidthMHz] = useState((profile.channel_bandwidth_hz ?? 20e6) / 1e6);
  const [rolloff, setRolloff] = useState(profile.rolloff ?? 0.35);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const sourceKey = inputKey(config, direction);
  const currentKey = useRef(sourceKey);
  currentKey.current = sourceKey;
  useEffect(() => {
    setBandwidthMHz((profile.channel_bandwidth_hz ?? 20e6) / 1e6);
    setRolloff(profile.rolloff ?? 0.35);
    setPending(false);
    setError('');
    return () => {
      version.current++;
      abort.current?.abort();
    };
  }, [sourceKey]);
  const changeDraft = () => {
    version.current++;
    abort.current?.abort();
    setPending(false);
    setError('');
  };
  const apply = async () => {
    const request = ++version.current;
    const requestKey = sourceKey;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const current = () =>
      version.current === request &&
      currentKey.current === requestKey &&
      !controller.signal.aborted;
    setPending(true);
    setError('');
    try {
      const result = await api<ChannelResponse>('/api/mission/radio-channel', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          profile,
          delivery: config.radio_delivery?.[direction] ?? null,
          channel_bandwidth_hz: bandwidthMHz * 1e6,
          rolloff,
        }),
      });
      if (current())
        edit((draft) => {
          if (inputKey(draft, direction) !== requestKey) return;
          draft[direction].profile = result.profile;
          if (draft.radio_delivery && result.delivery)
            draft.radio_delivery[direction] = result.delivery;
        });
    } catch (cause) {
      if (current())
        setError(
          cause instanceof APIError && cause.status === 404
            ? 'Bandwidth could not apply: the local service does not provide channel settings. It may be older than this interface. Open the app paired with the current service, then retry.'
            : cause instanceof Error
              ? cause.message
              : 'Channel settings unavailable',
        );
    } finally {
      if (current()) setPending(false);
    }
  };
  if (profile.waveform !== 'dvb_s2') return null;
  const unrecorded = profile.channel_bandwidth_hz == null || profile.rolloff == null;
  const unapplied =
    unrecorded ||
    bandwidthMHz * 1e6 !== profile.channel_bandwidth_hz ||
    rolloff !== profile.rolloff;
  return (
    <fieldset>
      <legend>{direction.toUpperCase()} CHANNEL</legend>
      <Field
        label="Allocated bandwidth"
        unit="MHz"
        value={bandwidthMHz}
        min={0.000001}
        max={135}
        step={1}
        onChange={(value) => {
          changeDraft();
          setBandwidthMHz(value);
        }}
      />
      <Select
        label="Roll-off"
        value={String(rolloff)}
        options={[0.2, 0.25, 0.35].map((value) => ({
          value: String(value),
          label: String(value),
        }))}
        onChange={(value) => {
          changeDraft();
          setRolloff(Number(value) as ChannelResponse['rolloff']);
        }}
      />
      <div className="field-row">
        <span>Stored Rs</span>
        <output aria-label={`${direction} symbol rate`}>
          {profile.symbol_rate_sps == null
            ? 'Unrecorded'
            : `${(profile.symbol_rate_sps / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 })} Msym/s`}
        </output>
      </div>
      {unapplied && (
        <small>{unrecorded ? 'Allocation unrecorded · draft unapplied' : 'Draft unapplied'}</small>
      )}
      <button className="text-button" disabled={pending} onClick={() => void apply()}>
        {pending ? 'Applying…' : 'Apply channel'}
      </button>
      {error && <small role="alert">{error}</small>}
    </fieldset>
  );
}
