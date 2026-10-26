import type { RunSnapshot, Samples } from '../types';
import type { LiveSession } from './liveTypes';
import { missionDisplaySnapshot } from '../mission/displaySnapshot.ts';

type Columns = { [key: string]: Columns | unknown[] };
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function append(columns: Columns, row: Record<string, unknown>) {
  for (const [key, value] of Object.entries(row)) {
    if (record(value)) append((columns[key] ??= {}) as Columns, value);
    else ((columns[key] ??= []) as unknown[]).push(structuredClone(value));
  }
}

export class LiveHistory {
  private columns: Columns = {};
  private telemetry: Record<string, unknown>[] = [];
  sequence = 0;
  gap = false;
  acknowledgments: LiveSession['command_acks'] = [];
  accept(session: LiveSession) {
    if (session.gap && session.first_sequence > this.sequence + 1) {
      this.columns = {};
      this.gap = true;
      this.sequence = session.first_sequence - 1;
    }
    const events = [
      ...session.samples.map((item) => ({ sequence: item.sequence, sample: item.row })),
      ...session.command_acks.map((item) => ({ sequence: item.sequence, command: item })),
    ].sort((a, b) => a.sequence - b.sequence);
    let added = false;
    for (const event of events) {
      if (event.sequence <= this.sequence) continue;
      if (event.sequence !== this.sequence + 1)
        throw new Error('Live telemetry sequence is incomplete.');
      if ('sample' in event) {
        const time = event.sample.time_s;
        const times = this.columns.time_s as number[] | undefined;
        if (
          typeof time !== 'number' ||
          !Number.isFinite(time) ||
          (times?.length && time <= times.at(-1)!)
        )
          throw new Error('Live sample time is invalid.');
        if ((times?.length ?? 0) >= 20001)
          throw new Error('Live history exceeded its sample limit.');
        append(this.columns, event.sample);
        added = true;
      } else this.acknowledgments.push(event.command);
      this.sequence = event.sequence;
    }
    if (session.next_sequence > this.sequence)
      throw new Error('Live telemetry watermark skipped data.');
    const latest = session.latest_telemetry;
    if (latest && typeof latest.time_s === 'number' && Number.isFinite(latest.time_s)) {
      const last = this.telemetry.at(-1);
      if (
        !last ||
        latest.time_s > Number(last.time_s) ||
        (latest.time_s === last.time_s && JSON.stringify(latest) !== JSON.stringify(last))
      ) {
        if (last?.time_s === latest.time_s) this.telemetry.pop();
        this.telemetry.push(structuredClone(latest));
        if (this.telemetry.length > 120) this.telemetry.shift();
        added = true;
      }
    }
    return added;
  }
  snapshot(session: LiveSession): RunSnapshot | null {
    if (session.final_snapshot) return missionDisplaySnapshot(session.final_snapshot);
    if (!(this.columns.time_s as number[] | undefined)?.length && !this.telemetry.length)
      return null;
    const input = session.initial_scenario;
    const times = (this.columns.time_s as number[] | undefined) || [];
    const firstLiveTime = this.telemetry[0]?.time_s;
    const firstLiveIndex =
      typeof firstLiveTime === 'number' ? times.findIndex((t) => t >= firstLiveTime) : -1;
    const keep = firstLiveIndex < 0 ? times.length : firstLiveIndex;
    const copyColumns = (columns: Columns): Columns =>
      Object.fromEntries(
        Object.entries(columns).map(([key, values]) => [
          key,
          Array.isArray(values) ? values.slice(0, keep) : copyColumns(values),
        ]),
      );
    const combined = copyColumns(this.columns);
    const rowAt = (columns: Columns, index: number): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(columns).map(([key, values]) => [
          key,
          Array.isArray(values) ? values[index] : rowAt(values, index),
        ]),
      );
    const tail = new Map<number, Record<string, unknown>>();
    for (let i = keep; i < times.length; i++) tail.set(times[i], rowAt(this.columns, i));
    for (const row of this.telemetry) tail.set(Number(row.time_s), row);
    for (const [, row] of [...tail].sort((a, b) => a[0] - b[0])) append(combined, row);
    const samples = combined as unknown as Samples;
    // Presentation only. Partial histories never enter the archive or completed-run store.
    return {
      run: {
        run_id: session.live_id,
        status: 'running',
        scenario_id: session.initial_scenario_id,
        scenario_hash: session.initial_scenario_hash,
        error: null,
        result: {
          manifest: { partial: true, kind: 'live_telemetry_prefix' },
          summary: {
            ideal_capacity_bits: {
              uplink: samples.uplink?.cumulative_ideal_bits.at(-1) ?? null,
              downlink: samples.downlink?.cumulative_ideal_bits.at(-1) ?? null,
            },
          },
          samples,
        },
      },
      scenario: {
        name: input.name,
        epoch_utc: input.orbit.elements.epoch_utc,
        duration_s: input.duration_s,
        step_s: input.clocks.output_step_s,
        station: input.station,
        antenna_variant: input.antenna_variant,
        uplink: input.uplink,
        downlink: input.downlink,
        schedule: input.schedule,
        provenance: input.provenance,
      },
    };
  }
}
