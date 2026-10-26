import type { MissionConfig, MissionSnapshot } from '../mission/missionTypes';

export type PointingIntent = {
  command_id: string;
  mode: 'auto' | 'sun_pointing' | 'ground_tracking' | 'imaging';
  target_latitude_deg?: number;
  target_longitude_deg?: number;
};
export type LiveSession = {
  live_id: string;
  status: 'starting' | 'running' | 'paused' | 'stopping' | 'complete' | 'cancelled' | 'failed';
  initial_scenario: MissionConfig;
  initial_scenario_id: string;
  initial_scenario_hash: string;
  computed_time_s: number;
  latest_telemetry?: Record<string, unknown> | null;
  latest_sequence: number;
  last_sample_time_s: number | null;
  sample_count: number;
  unapplied_command_ids: string[];
  unapplied_numerical_step_ids?: string[];
  requested_duration_s: number;
  speed: number;
  paused: boolean;
  lease_expired: boolean;
  pending_commands: number;
  numerical_step_s?: number;
  numerical_step_options?: { dynamics_step_s: number; allowed: boolean; reason: string | null }[];
  pending_numerical_steps?: number;
  numerical_step_acks?: {
    sequence: number;
    command: { command_id: string; effective_time_s: number; dynamics_step_s: number };
  }[];
  numerical_step_errors?: {
    sequence: number;
    command_id: string;
    effective_time_s: number;
    error: string;
  }[];
  next_sequence: number;
  first_sequence: number;
  gap: boolean;
  samples: { sequence: number; row: Record<string, unknown> }[];
  command_acks: { sequence: number; command: PointingIntent & { effective_time_s: number } }[];
  final_snapshot: Pick<MissionSnapshot, 'scenario' | 'run'> | null;
  error: string | null;
};
