import type { RunSnapshot } from '../types';
import { closestIndex } from './TracePlot';
import type { RadioDeliveryConfig } from '../mission/radioDeliveryTypes';

export function LinkStatus({
  snapshot,
  cursorTime,
}: {
  snapshot: RunSnapshot | null;
  cursorTime: number;
}) {
  const result = snapshot?.run.result;
  if (!result?.samples.time_s.length) return null;
  const samples = result.samples;
  const index = closestIndex(samples.time_s, cursorTime);
  const config = (result.manifest?.scenario as { radio_delivery?: RadioDeliveryConfig } | undefined)
    ?.radio_delivery;
  const active = samples.radio_active?.[index] !== false;
  const inContact = samples.visible[index];
  return (
    <span className="link-now" aria-label="Radio at replay time">
      <span title="S-band serves one direction at a time. The inactive direction has zero scheduled rate.">
        {!inContact
          ? 'Below mask'
          : !active
            ? 'Radio idle'
            : `${samples.active_direction[index] === 'downlink' ? 'DL' : 'UL'} window`}
      </span>
      {config &&
        (['uplink', 'downlink'] as const).map((direction) => {
          const receiver = samples.radio_delivery?.[direction];
          const mode = config[direction]?.modes.find(
            (item) => item.mode_id === receiver?.mode_id[index],
          );
          if (!mode) return null;
          return (
            <span
              key={direction}
              className={`${direction}-color`}
              title={`${receiver?.receiver_state[index] ?? 'Unavailable'} · ${config[direction].policy} · assumed receiver`}
            >
              {direction === 'uplink' ? 'UL' : 'DL'} {mode.modulation} {mode.code_rate}
            </span>
          );
        })}
    </span>
  );
}
