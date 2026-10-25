import { useCallback, useEffect, useRef, useState } from 'react';
import { api, cloneScenario } from '../api';
import type { MissionConfig, MissionRun, MissionSnapshot } from './missionTypes';

const working = new Set(['queued', 'running', 'cancelling']);
export function useMission() {
  const [config, setConfig] = useState<MissionConfig | null>(null);
  const [run, setRun] = useState<MissionRun | null>(null);
  const [snapshot, setSnapshot] = useState<MissionSnapshot | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [orbitPending, setOrbitPending] = useState(false);
  const resolvingOrbit = useRef(false);
  const generation = useRef(0);
  const pending = useRef<MissionConfig | null>(null);
  const [reload, setReload] = useState(0);
  const orbitGeneration = useRef(0);
  const orbitAbort = useRef<AbortController | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    api<{ scenario: MissionConfig }>('/api/mission/default', { signal: abort.signal })
      .then(({ scenario }) => {
        if (!abort.signal.aborted) {
          setConfig(scenario);
          setError('');
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [reload]);
  useEffect(
    () => () => {
      generation.current++;
      orbitAbort.current?.abort();
    },
    [],
  );
  const edit = useCallback((change: (draft: MissionConfig) => void) => {
    setConfig((current) => {
      if (!current) return current;
      const next = cloneScenario(current);
      change(next);
      return next;
    });
  }, []);
  const resolveOrbit = useCallback(
    async (orbit: MissionConfig['orbit'], ltan?: number, sso = false) => {
      const ticket = ++orbitGeneration.current;
      orbitAbort.current?.abort();
      const abort = new AbortController();
      orbitAbort.current = abort;
      resolvingOrbit.current = true;
      setOrbitPending(true);
      const unresolvedOrbit = { ...orbit, ltan_hours_at_epoch: null };
      edit((draft) => {
        draft.orbit = unresolvedOrbit;
      });
      try {
        const result = await api<{ orbit: MissionConfig['orbit'] }>('/api/mission/orbit', {
          method: 'POST',
          signal: abort.signal,
          body: JSON.stringify({
            orbit: unresolvedOrbit,
            ...(ltan == null ? {} : { ltan_hours: ltan }),
            sso,
          }),
        });
        if (ticket === orbitGeneration.current && !abort.signal.aborted) {
          edit((draft) => {
            draft.orbit = result.orbit;
          });
          setError('');
        }
      } catch (cause) {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Orbit input failed');
      } finally {
        if (ticket === orbitGeneration.current) {
          resolvingOrbit.current = false;
          setOrbitPending(false);
        }
      }
    },
    [edit],
  );
  const start = useCallback(async () => {
    const input = configRef.current;
    if (!input || resolvingOrbit.current) return;
    const ticket = ++generation.current;
    pending.current = cloneScenario(input);
    setSubmitting(true);
    setError('');
    try {
      const created = await api<MissionRun>('/api/mission/runs', {
        method: 'POST',
        body: JSON.stringify({ scenario: input }),
      });
      if (ticket === generation.current) setRun(created);
    } catch (cause) {
      if (ticket === generation.current)
        setError(cause instanceof Error ? cause.message : 'Run failed');
    } finally {
      if (ticket === generation.current) setSubmitting(false);
    }
  }, []);
  useEffect(() => {
    if (!run || !working.has(run.status)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const id = run.run_id;
    async function poll() {
      try {
        const next = await api<MissionRun>(`/api/mission/runs/${encodeURIComponent(id)}`, {
          signal: abort.signal,
        });
        if (abort.signal.aborted) return;
        setRun(next);
        if (next.result && pending.current)
          setSnapshot({ run: next, scenario: cloneScenario(pending.current) });
        if (next.status === 'failed') setError(next.error || 'Mission failed');
        if (working.has(next.status)) timer = setTimeout(poll, 500);
      } catch (cause) {
        if (!abort.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Run unavailable');
          timer = setTimeout(poll, 1500);
        }
      }
    }
    timer = setTimeout(poll, 100);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [run?.run_id, run?.status]);
  const cancel = useCallback(async () => {
    if (!run) return;
    try {
      setRun(
        await api<MissionRun>(`/api/mission/runs/${encodeURIComponent(run.run_id)}`, {
          method: 'DELETE',
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cancellation failed');
    }
  }, [run]);
  return {
    config,
    orbitPending,
    edit,
    resolveOrbit,
    run,
    snapshot,
    error,
    clearError: () => setError(''),
    loading,
    busy: submitting || (!!run && working.has(run.status)),
    submitting,
    start,
    cancel,
    reload: () => setReload((n) => n + 1),
    dirty: !!config && !!snapshot && JSON.stringify(config) !== JSON.stringify(snapshot.scenario),
  };
}
export type MissionSession = ReturnType<typeof useMission>;
