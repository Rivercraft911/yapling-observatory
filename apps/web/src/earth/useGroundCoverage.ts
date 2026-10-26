import { useEffect, useMemo, useState } from 'react';
import { api, APIError } from '../api';
import type { Direction, Scenario } from '../types';
import type { MissionConfig } from '../mission/missionTypes';
import type { GroundCoverageResponse } from './flatMapGeometry';

export function useGroundCoverage(
  scenario: MissionConfig | Scenario | null,
  direction: Direction,
  altitudeM: number | null,
  polarizationLossDb: number,
) {
  const key = useMemo(
    () =>
      scenario
        ? JSON.stringify({
            scenario,
            direction,
            altitude_m: altitudeM,
            polarization_loss_db: polarizationLossDb,
          })
        : '',
    [scenario, direction, altitudeM, polarizationLossDb],
  );
  const [reply, setReply] = useState<{
    key: string;
    data?: GroundCoverageResponse;
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    api<GroundCoverageResponse>('/api/mission/coverage', {
      method: 'POST',
      body: key,
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setReply({ key, data });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        const error =
          cause instanceof APIError && cause.status === 404
            ? 'Coverage needs the updated local service.'
            : cause instanceof Error
              ? cause.message
              : 'Coverage unavailable';
        setReply({ key, error });
      });
    return () => controller.abort();
  }, [key, attempt]);
  const current = reply?.key === key ? reply : null;
  return {
    retry: () => {
      setReply(null);
      setAttempt((value) => value + 1);
    },
    data: current?.data ?? null,
    error: key ? (current?.error ?? '') : 'Run inputs unavailable',
    state:
      !key || current?.error
        ? ('unavailable' as const)
        : current?.data
          ? ('ready' as const)
          : ('loading' as const),
  };
}
