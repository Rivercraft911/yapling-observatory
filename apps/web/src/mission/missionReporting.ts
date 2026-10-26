export interface ContactTotals {
  scheduled_s: number;
  ideal_contact_s: number;
  ideal_capacity_bits: number | null;
  delivered_useful_bits: number | null;
}
export interface ReportInterval {
  start_s: number;
  end_s: number;
  start_utc: string;
  end_utc: string;
  scheduled_contact_s: number;
  uplink: ContactTotals;
  downlink: ContactTotals;
}
export interface MissionDay extends ReportInterval {
  date_utc: string;
  computed_duration_s: number;
  partial_day: boolean;
  endpoint_only?: boolean;
  endpoint_frame_count?: number;
  geometric_pass_count: number;
  geometric_pass_entries: number;
  geometric_visible_s: number;
}
export interface MissionPass extends ReportInterval {
  pass_index: number;
  duration_s: number;
  start_clipped: boolean;
  end_clipped: boolean;
  max_elevation_deg: number;
}
export interface MissionReport {
  schema_version: '1.0';
  delivery_kind?: 'explicit_receiver_frame_model' | 'not_modeled';
  interval_semantics: string;
  epoch_utc: string;
  computed_start_utc: string;
  computed_end_utc: string;
  days: MissionDay[];
  passes: MissionPass[];
}
export function missionReport(value: unknown, progress = false): MissionReport | null {
  if (!value || typeof value !== 'object') return null;
  const report = value as Partial<MissionReport>;
  return report.schema_version === '1.0' &&
    Array.isArray(report.days) &&
    (Array.isArray(report.passes) || progress)
    ? progress
      ? ({ ...report, passes: report.passes ?? [] } as MissionReport)
      : (report as MissionReport)
    : null;
}
export function reportMegabytes(bits: number | null) {
  return bits === null ? '—' : (bits / 8e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
export function reportCsv(report: MissionReport) {
  const rows: (string | number | null)[][] = [
    [
      'utc_date',
      'computed_seconds',
      'partial_day',
      'passes_intersecting_day',
      'pass_entries',
      'geometric_visible_seconds',
      'scheduled_contact_seconds',
      'uplink_ideal_capacity_bits',
      'downlink_ideal_capacity_bits',
      'uplink_modeled_payload_bits',
      'downlink_modeled_payload_bits',
    ],
  ];
  for (const day of report.days)
    rows.push([
      day.date_utc,
      day.computed_duration_s,
      day.partial_day ? 1 : 0,
      day.geometric_pass_count,
      day.geometric_pass_entries,
      day.geometric_visible_s,
      day.scheduled_contact_s,
      day.uplink.ideal_capacity_bits,
      day.downlink.ideal_capacity_bits,
      day.uplink.delivered_useful_bits,
      day.downlink.delivered_useful_bits,
    ]);
  return rows
    .map((row) =>
      row
        .map((value) => (value === null ? '' : `"${String(value).replaceAll('"', '""')}"`))
        .join(','),
    )
    .join('\r\n');
}
