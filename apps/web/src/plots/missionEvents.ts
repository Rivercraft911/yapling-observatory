import type { RunResult } from '../types';

export type MissionEventCategory = 'pass' | 'eclipse' | 'conops' | 'radio' | 'wheel' | 'command';
export interface PlotEvent {
  id: string;
  category: MissionEventCategory;
  time: number;
  endTime?: number;
  label: string;
  detail: string;
  source: 'recorded' | 'sampled';
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const named = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const binarySun = (value: unknown) => value === 0 || value === 1;
const words = (value: string) => value.replaceAll('_', ' ');
const column = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const directions = ['uplink', 'downlink'] as const;

export function missionEvents(result: RunResult): {
  events: PlotEvent[];
  incomplete: boolean;
  sampled: boolean;
} {
  const events: PlotEvent[] = [];
  let incomplete = false;
  const samples = record(result.samples);
  const times = column(samples.time_s);
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  for (const time of times) {
    if (!finite(time)) continue;
    firstTime = firstTime === null ? time : Math.min(firstTime, time);
    lastTime = lastTime === null ? time : Math.max(lastTime, time);
  }
  const manifest = record(result.manifest);
  if (manifest.history_gap === true) incomplete = true;
  const partial = manifest.partial === true || manifest.kind === 'live_telemetry_prefix';
  const inPrefix = (time: number) =>
    !partial || (firstTime !== null && lastTime !== null && time >= firstTime && time <= lastTime);
  const add = (event: PlotEvent) => {
    if (inPrefix(event.time)) events.push(event);
  };
  const radioManifest = record(manifest.radio_delivery);
  const radioConfig = record(
    record(manifest.scenario).radio_delivery ?? radioManifest.configuration ?? radioManifest.config,
  );
  const modeName = (direction: string, id: unknown) => {
    if (!named(id)) return 'unavailable mode';
    const mode = column(record(radioConfig[direction]).modes)
      .map(record)
      .find((item) => item.mode_id === id);
    return mode && named(mode.modulation) && named(mode.code_rate)
      ? `${mode.modulation} ${mode.code_rate}`
      : id;
  };
  const rawEvents = column(result.events).map((value, index) => ({ value: record(value), index }));
  const stateRecords = rawEvents.filter(({ value }) => value.type === 'state');
  const receiverRecords = rawEvents.filter(
    ({ value }) => value.type === 'radio_delivery' || value.type === 'receiver',
  );
  const hasRecordedVisibility =
    stateRecords.some(({ value }) => typeof value.visible === 'boolean') ||
    rawEvents.some(({ value }) => value.kind === 'visible');
  const hasRecordedSun = stateRecords.some(({ value }) => binarySun(value.sun_visibility));
  const hasRecordedConops = stateRecords.some(
    ({ value }) => named(value.mode) || named(value.stage_id),
  );
  const hasRecordedRadio =
    receiverRecords.length > 0 || rawEvents.some(({ value }) => value.kind === 'active_direction');
  const report = record(record(result.summary).reporting);
  const hasPassReport = Array.isArray(report.passes);

  const exportInfo = record(radioManifest.event_export);
  if (finite(radioManifest.events_dropped) && radioManifest.events_dropped > 0) incomplete = true;
  if (
    !finite(radioManifest.events_dropped) &&
    finite(exportInfo.maximum_receiver_events) &&
    exportInfo.maximum_receiver_events > 0 &&
    finite(exportInfo.exported_receiver_events) &&
    exportInfo.exported_receiver_events >= exportInfo.maximum_receiver_events
  )
    incomplete = true;
  if (
    finite(exportInfo.exported_receiver_events) &&
    exportInfo.exported_receiver_events > receiverRecords.length
  )
    incomplete = true;
  for (const direction of directions) {
    const totals = record(record(record(result.summary).radio_delivery)[direction]);
    for (const [counter, causes] of [
      ['mode_change_count', ['adaptive_mode_change', 'scheduled_mode_change']],
      ['acquisition_count', ['acquisition_complete']],
      ['lock_loss_count', ['hold_threshold_timeout']],
    ] as const) {
      const count = receiverRecords.filter(
        ({ value }) =>
          value.direction === direction && causes.some((cause) => cause === value.cause),
      ).length;
      if (finite(totals[counter]) && totals[counter] > count) incomplete = true;
    }
  }

  let previousState: RecordValue | null = null;
  const chronological = rawEvents
    .filter(({ value }) => {
      if (finite(value.time_s)) return true;
      if (
        ['state', 'radio_delivery', 'receiver', 'pointing_command', 'numerical_step'].includes(
          String(value.type),
        )
      )
        incomplete = true;
      return false;
    })
    .sort((a, b) => (a.value.time_s as number) - (b.value.time_s as number) || a.index - b.index);
  for (const { value, index } of chronological) {
    const time = value.time_s as number;
    const base = { time, source: 'recorded' as const };
    if (value.type === 'state') {
      if (previousState) {
        if (
          !hasPassReport &&
          typeof value.visible === 'boolean' &&
          typeof previousState.visible === 'boolean' &&
          value.visible !== previousState.visible
        )
          add({
            ...base,
            id: `state:${index}:pass`,
            category: 'pass',
            label: value.visible ? 'Station mask entry' : 'Station mask exit',
            detail:
              'Recorded geometric visibility transition on the accepted dynamics grid; not root-found.',
          });
        if (
          binarySun(value.sun_visibility) &&
          binarySun(previousState.sun_visibility) &&
          value.sun_visibility !== previousState.sun_visibility
        )
          add({
            ...base,
            id: `state:${index}:eclipse`,
            category: 'eclipse',
            label: value.sun_visibility === 0 ? 'Eclipse entry' : 'Eclipse exit',
            detail:
              'Recorded hard-shadow transition on the accepted dynamics grid; no penumbra timing.',
          });
        const modeChanged =
          named(value.mode) && named(previousState.mode) && value.mode !== previousState.mode;
        const stageChanged =
          named(value.stage_id) &&
          named(previousState.stage_id) &&
          value.stage_id !== previousState.stage_id;
        if (modeChanged || stageChanged)
          add({
            ...base,
            id: `state:${index}:conops`,
            category: 'conops',
            label: named(value.mode) ? `CONOPS · ${words(value.mode)}` : 'CONOPS stage change',
            detail: [
              modeChanged
                ? `${words(previousState.mode as string)} → ${words(value.mode as string)}.`
                : '',
              stageChanged ? `Stage ${previousState.stage_id} → ${value.stage_id}.` : '',
              'Recorded operation transition on the accepted dynamics grid.',
            ]
              .filter(Boolean)
              .join(' '),
          });
      }
      previousState = value;
    } else if (value.type === 'radio_delivery' || value.type === 'receiver') {
      if (!directions.some((direction) => direction === value.direction) || !named(value.state)) {
        incomplete = true;
        continue;
      }
      const direction = value.direction as string;
      const prefix = direction === 'uplink' ? 'UL' : 'DL';
      const cause = named(value.cause) ? value.cause : 'cause unavailable';
      const mode = modeName(direction, value.mode_id);
      const label =
        cause === 'adaptive_mode_change' || cause === 'scheduled_mode_change'
          ? `${prefix} MODCOD · ${mode}`
          : cause === 'acquisition_complete'
            ? `${prefix} lock acquired`
            : cause === 'hold_threshold_timeout'
              ? `${prefix} lock lost`
              : `${prefix} receiver · ${words(value.state)}`;
      add({
        ...base,
        id: `receiver:${index}`,
        category: 'radio',
        label,
        detail: `${words(cause)}; ${words(value.state)}; ${mode}. Recorded receiver-model event under assumed timing and threshold settings.`,
      });
    } else if (value.type === 'pointing_command' || value.type === 'numerical_step') {
      const command = record(value.command);
      const id = named(command.command_id) ? command.command_id : String(index);
      if (value.type === 'pointing_command' && named(command.mode)) {
        const target =
          finite(command.target_latitude_deg) && finite(command.target_longitude_deg)
            ? ` Target ${command.target_latitude_deg}°, ${command.target_longitude_deg}°.`
            : '';
        add({
          ...base,
          id: `pointing:${id}:${index}`,
          category: 'command',
          label: `Command · ${words(command.mode)}`,
          detail: `Recorded accepted pointing command ${id}.${target} Timing is its effective controller boundary.`,
        });
      } else if (value.type === 'numerical_step' && finite(command.dynamics_step_s)) {
        add({
          ...base,
          id: `numerics:${id}:${index}`,
          category: 'command',
          label: `Integration step · ${command.dynamics_step_s} s`,
          detail: `Recorded accepted numerical command ${id}; effective integration step ${command.dynamics_step_s} s. Wall-clock playback speed is separate.`,
        });
      }
    } else if (value.kind === 'visible' && !hasPassReport && typeof value.value === 'boolean') {
      add({
        ...base,
        id: `legacy:${index}:pass`,
        category: 'pass',
        label: value.value ? 'Station mask entry' : 'Station mask exit',
        detail:
          'Recorded legacy visibility marker at the first output sample after the transition; exact crossing time is unavailable.',
      });
    } else if (
      value.kind === 'active_direction' &&
      directions.some((direction) => direction === value.value)
    ) {
      add({
        ...base,
        id: `legacy:${index}:radio`,
        category: 'radio',
        label: `${value.value === 'uplink' ? 'UL' : 'DL'} window`,
        detail:
          'Recorded legacy direction marker at the first output sample after the schedule transition; receiver lock is separate.',
      });
    }
  }

  column(report.passes).forEach((item, index) => {
    const pass = record(item);
    if (!finite(pass.start_s) || !finite(pass.end_s) || pass.end_s < pass.start_s) {
      incomplete = true;
      return;
    }
    if (
      partial &&
      (firstTime === null || lastTime === null || pass.end_s < firstTime || pass.start_s > lastTime)
    )
      return;
    const start = partial ? Math.max(firstTime as number, pass.start_s) : pass.start_s;
    const end = partial ? Math.min(lastTime as number, pass.end_s) : pass.end_s;
    const clippedStart = pass.start_clipped === true || start !== pass.start_s;
    const clippedEnd = pass.end_clipped === true || end !== pass.end_s;
    const peak = finite(pass.max_elevation_deg)
      ? ` Recorded peak elevation ${pass.max_elevation_deg}°.`
      : '';
    add({
      id: `pass:${index}:${pass.start_s}:${pass.end_s}`,
      category: 'pass',
      time: start,
      endTime: end,
      label: `Pass ${finite(pass.pass_index) ? pass.pass_index : index + 1}`,
      detail: `Recorded geometric pass interval on the accepted dynamics grid; boundaries are not root-found.${clippedStart ? ' Start clipped; entry is outside the returned interval.' : ''}${clippedEnd ? ' End clipped; exit is outside the returned interval.' : ''}${peak}`,
      source: 'recorded',
    });
  });

  const sampledChange = (
    values: unknown[],
    category: MissionEventCategory,
    key: string,
    valid: (value: unknown) => boolean,
    label: (value: unknown) => string,
    description: (before: unknown, after: unknown) => string,
  ) => {
    for (let index = 1; index < times.length; index++) {
      const beforeTime = times[index - 1],
        time = times[index];
      const before = values[index - 1],
        after = values[index];
      if (
        !finite(beforeTime) ||
        !finite(time) ||
        time <= beforeTime ||
        !valid(before) ||
        !valid(after) ||
        before === after
      )
        continue;
      add({
        id: `sampled:${key}:${beforeTime}:${time}`,
        category,
        time,
        label: `${label(after)} (sampled)`,
        detail: `${description(before, after)} Change observed between returned samples T+${beforeTime} s and T+${time} s; the marker uses the later sample, not an exact event time.`,
        source: 'sampled',
      });
    }
  };
  if (!hasPassReport && !hasRecordedVisibility)
    sampledChange(
      column(samples.visible),
      'pass',
      'visibility',
      (value) => typeof value === 'boolean',
      (value) => (value ? 'Station mask entry' : 'Station mask exit'),
      () => 'Sampled geometric visibility changed.',
    );
  if (!hasRecordedSun)
    sampledChange(
      column(record(samples.power).sun_visibility),
      'eclipse',
      'sun',
      binarySun,
      (value) => (value === 0 ? 'Eclipse entry' : 'Eclipse exit'),
      () => 'Sampled hard-shadow state changed.',
    );
  if (!hasRecordedConops)
    sampledChange(
      column(samples.mode),
      'conops',
      'mode',
      named,
      (value) => `CONOPS · ${words(value as string)}`,
      (before, after) => `${words(before as string)} → ${words(after as string)}.`,
    );
  sampledChange(
    column(record(samples.gnc).wheel_saturated),
    'wheel',
    'wheel',
    (value) => typeof value === 'boolean',
    (value) => (value ? 'Wheel limit entered' : 'Wheel limit cleared'),
    () =>
      'Aggregate wheel torque, speed or power limit flag changed; this does not identify momentum saturation.',
  );

  if (!hasRecordedRadio) {
    const receivers = record(samples.radio_delivery);
    for (const direction of directions) {
      const receiver = record(receivers[direction]);
      const states = column(receiver.receiver_state),
        modes = column(receiver.mode_id);
      for (let index = 1; index < times.length; index++) {
        const beforeTime = times[index - 1],
          time = times[index];
        if (!finite(beforeTime) || !finite(time) || time <= beforeTime) continue;
        const stateChanged =
          named(states[index - 1]) && named(states[index]) && states[index - 1] !== states[index];
        const modeChanged =
          named(modes[index - 1]) && named(modes[index]) && modes[index - 1] !== modes[index];
        if (!stateChanged && !modeChanged) continue;
        const prefix = direction === 'uplink' ? 'UL' : 'DL';
        add({
          id: `sampled:${direction}:${beforeTime}:${time}`,
          category: 'radio',
          time,
          label: `${prefix} ${modeChanged ? `MODCOD · ${modeName(direction, modes[index])}` : `receiver · ${words(states[index] as string)}`} (sampled)`,
          detail: [
            stateChanged ? `Receiver ${states[index - 1]} → ${states[index]}.` : '',
            modeChanged
              ? `${modeName(direction, modes[index - 1])} → ${modeName(direction, modes[index])}.`
              : '',
            `Observed between returned samples T+${beforeTime} s and T+${time} s; exact switching/acquisition time and cause are unavailable.`,
          ]
            .filter(Boolean)
            .join(' '),
          source: 'sampled',
        });
      }
    }
    if (!Object.keys(receivers).length) {
      sampledChange(
        column(samples.radio_active),
        'radio',
        'radio-active',
        (value) => typeof value === 'boolean',
        (value) => (value ? 'Radio active' : 'Radio idle'),
        () => 'Sampled radio scheduling state changed.',
      );
      sampledChange(
        column(samples.active_direction),
        'radio',
        'direction',
        (value) => directions.some((direction) => direction === value),
        (value) => `${value === 'uplink' ? 'UL' : 'DL'} window`,
        () => 'Sampled direction slot changed; lock is separate.',
      );
    }
  }
  events.sort((a, b) => a.time - b.time);
  return { events, incomplete, sampled: events.some((event) => event.source === 'sampled') };
}
