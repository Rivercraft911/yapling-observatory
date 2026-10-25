import { useCallback, useEffect, useRef, useState } from 'react';
import { api, cloneScenario } from '../api';
import {
  downloadMissionArchive,
  prepareMissionArchive,
  importMissionArchive,
  readMissionArchive,
  requestMissionRun,
} from './missionArchives';
import { canAdvanceMissionRun, MissionRequests, type MissionRequest } from './missionRequests';
import type { MissionConfig, MissionRun, MissionSnapshot } from './missionTypes';

const working = new Set(['queued', 'running', 'cancelling']);
interface RunContext {
  request: MissionRequest;
  scenario: MissionConfig;
  runId: string | null;
}

export function useMission() {
  const [config, setConfig] = useState<MissionConfig | null>(null);
  const [run, setRun] = useState<MissionRun | null>(null);
  const [snapshot, setSnapshot] = useState<MissionSnapshot | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [orbitPending, setOrbitPending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const requests = useRef(new MissionRequests()).current;
  const configRef = useRef<MissionConfig | null>(null);
  const runRef = useRef<MissionRun | null>(null);
  const snapshotRef = useRef<MissionSnapshot | null>(null);
  const runContext = useRef<RunContext | null>(null);
  const submittingRef = useRef(false);
  const importingRef = useRef(false);
  const savingRef = useRef(false);
  const loadingRef = useRef(true);
  const resolvingOrbit = useRef(false);

  const commitConfig = useCallback((next: MissionConfig) => {
    configRef.current = next;
    setConfig(next);
  }, []);
  const commitRun = useCallback((next: MissionRun) => {
    runRef.current = next;
    setRun(next);
  }, []);
  const commitSnapshot = useCallback((next: MissionSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  const isBusy = useCallback(
    () => submittingRef.current || (!!runRef.current && working.has(runRef.current.status)),
    [],
  );
  const invalidateInputs = useCallback(
    (importMessage?: string) => {
      const wasOpening = importingRef.current;
      requests.inputsChanged();
      loadingRef.current = false;
      resolvingOrbit.current = false;
      importingRef.current = false;
      setLoading(false);
      setOrbitPending(false);
      setImporting(false);
      if (wasOpening && importMessage) setError(importMessage);
    },
    [requests],
  );

  const reload = useCallback(async () => {
    if (isBusy() || importingRef.current) return;
    invalidateInputs();
    const request = requests.begin('defaults');
    loadingRef.current = true;
    setLoading(true);
    setError('');
    try {
      const { scenario } = await api<{ scenario: MissionConfig }>('/api/mission/default', {
        signal: request.signal,
      });
      if (request.current()) commitConfig(scenario);
    } catch (cause) {
      if (request.current())
        setError(cause instanceof Error ? cause.message : 'Mission unavailable');
    } finally {
      if (request.current()) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [commitConfig, invalidateInputs, isBusy, requests]);
  useEffect(() => {
    void reload();
    return () => requests.cancelAll();
  }, [reload, requests]);

  const edit = useCallback(
    (change: (draft: MissionConfig) => void) => {
      if (!configRef.current) return;
      const next = cloneScenario(configRef.current);
      change(next);
      invalidateInputs('Inputs changed while opening; choose the file again.');
      commitConfig(next);
    },
    [commitConfig, invalidateInputs],
  );

  const resolveOrbit = useCallback(
    async (orbit: MissionConfig['orbit'], ltan?: number, sso = false) => {
      if (!configRef.current) return;
      const interruptedImport = importingRef.current;
      invalidateInputs('Inputs changed while opening; choose the file again.');
      const request = requests.begin('orbit');
      resolvingOrbit.current = true;
      setOrbitPending(true);
      const unresolvedOrbit = { ...orbit, ltan_hours_at_epoch: null };
      commitConfig({ ...configRef.current, orbit: unresolvedOrbit });
      try {
        const result = await api<{ orbit: MissionConfig['orbit'] }>('/api/mission/orbit', {
          method: 'POST',
          signal: request.signal,
          body: JSON.stringify({
            orbit: unresolvedOrbit,
            ...(ltan == null ? {} : { ltan_hours: ltan }),
            sso,
          }),
        });
        if (request.current() && configRef.current) {
          commitConfig({ ...configRef.current, orbit: result.orbit });
          if (!interruptedImport) setError('');
        }
      } catch (cause) {
        if (request.current())
          setError(cause instanceof Error ? cause.message : 'Orbit input failed');
      } finally {
        if (request.current()) {
          resolvingOrbit.current = false;
          setOrbitPending(false);
        }
      }
    },
    [commitConfig, invalidateInputs, requests],
  );

  const acceptRun = useCallback(
    (next: MissionRun, context: RunContext, text: string) => {
      if (!context.request.current() || runContext.current !== context) return false;
      if (context.runId && context.runId !== next.run_id) {
        setError('The service returned a different mission run.');
        return false;
      }
      context.runId = next.run_id;
      if (!canAdvanceMissionRun(runRef.current, next)) return true;
      commitRun(next);
      if (next.status === 'complete' && next.result)
        commitSnapshot({
          run: next,
          scenario: cloneScenario(context.scenario),
          raw_run_json: text,
        });
      if (next.status === 'failed') setError(next.error || 'Mission failed');
      return true;
    },
    [commitRun, commitSnapshot],
  );

  const start = useCallback(async () => {
    if (
      !configRef.current ||
      isBusy() ||
      importingRef.current ||
      resolvingOrbit.current ||
      loadingRef.current
    )
      return false;
    requests.cancel('poll', 'cancel');
    const context: RunContext = {
      request: requests.begin('run'),
      scenario: cloneScenario(configRef.current),
      runId: null,
    };
    runContext.current = context;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const { run: created, text } = await requestMissionRun('/api/mission/runs', {
        method: 'POST',
        body: JSON.stringify({ scenario: context.scenario }),
        signal: context.request.signal,
      });
      return acceptRun(created, context, text);
    } catch (cause) {
      if (context.request.current())
        setError(cause instanceof Error ? cause.message : 'Run failed');
      return false;
    } finally {
      if (context.request.current()) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }, [acceptRun, isBusy, requests]);

  useEffect(() => {
    const context = runContext.current;
    if (
      !run ||
      !working.has(run.status) ||
      !context ||
      context.runId !== run.run_id ||
      !context.request.current()
    )
      return;
    const request = requests.begin('poll');
    const activeContext = context;
    const id = run.run_id;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { run: next, text } = await requestMissionRun(
          `/api/mission/runs/${encodeURIComponent(id)}`,
          {
            signal: request.signal,
          },
        );
        if (!request.current() || !activeContext.request.current()) return;
        if (!acceptRun(next, activeContext, text)) return;
        if (working.has(next.status)) timer = setTimeout(poll, 500);
      } catch (cause) {
        if (request.current() && activeContext.request.current()) {
          setError(cause instanceof Error ? cause.message : 'Run unavailable');
          timer = setTimeout(poll, 1500);
        }
      }
    }
    timer = setTimeout(poll, 100);
    return () => {
      requests.cancel('poll');
      clearTimeout(timer);
    };
  }, [run?.run_id, run?.status, acceptRun, requests]);

  const cancel = useCallback(async () => {
    const before = runRef.current;
    const context = runContext.current;
    if (
      !before ||
      !working.has(before.status) ||
      !context ||
      context.runId !== before.run_id ||
      !context.request.current()
    )
      return;
    requests.cancel('poll');
    const request = requests.begin('cancel');
    commitRun({ ...before, status: 'cancelling' });
    try {
      const { run: next, text } = await requestMissionRun(
        `/api/mission/runs/${encodeURIComponent(before.run_id)}`,
        {
          method: 'DELETE',
          signal: request.signal,
        },
      );
      if (request.current() && context.request.current()) acceptRun(next, context, text);
    } catch (cause) {
      if (request.current() && context.request.current()) {
        if (runRef.current && working.has(runRef.current.status)) commitRun(before);
        setError(cause instanceof Error ? cause.message : 'Cancellation failed');
      }
    }
  }, [acceptRun, commitRun, requests]);

  const openArchive = useCallback(
    async (file: File) => {
      if (isBusy()) {
        setError('Wait for the active run before opening an archive.');
        return false;
      }
      invalidateInputs();
      const request = requests.beginImport();
      importingRef.current = true;
      setImporting(true);
      setError('');
      try {
        const text = await readMissionArchive(file, request.signal);
        const result = await importMissionArchive(text, request.signal);
        if (!request.current()) return false;
        const opened: MissionSnapshot = {
          ...result.snapshot,
          presentation_id: crypto.randomUUID(),
          imported: {
            ...result.import_metadata,
            filename: file.name,
            opened_at: new Date().toISOString(),
          },
          original_archive_json: text,
        };
        runContext.current = null;
        commitConfig(cloneScenario(opened.scenario));
        commitRun(opened.run);
        commitSnapshot(opened);
        return true;
      } catch (cause) {
        if (request.current())
          setError(cause instanceof Error ? cause.message : 'Mission archive could not be opened.');
        return false;
      } finally {
        if (request.current()) {
          importingRef.current = false;
          setImporting(false);
        }
      }
    },
    [commitConfig, commitRun, commitSnapshot, invalidateInputs, isBusy, requests],
  );

  const saveArchive = useCallback(async () => {
    const archived = snapshotRef.current;
    if (
      !archived?.run.result ||
      archived.run.status !== 'complete' ||
      savingRef.current ||
      importingRef.current
    )
      return;
    const request = requests.begin('export');
    savingRef.current = true;
    setSaving(true);
    try {
      const text = await prepareMissionArchive(archived, request.signal);
      if (request.current()) downloadMissionArchive(text, archived.run.run_id);
    } catch (cause) {
      if (request.current())
        setError(cause instanceof Error ? cause.message : 'Mission archive could not be saved.');
    } finally {
      if (request.current()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  }, [requests]);

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
    importing,
    saving,
    start,
    cancel,
    reload,
    openArchive,
    saveArchive,
    canSave: !!snapshot?.run.result && snapshot.run.status === 'complete',
    dirty: !!config && !!snapshot && JSON.stringify(config) !== JSON.stringify(snapshot.scenario),
  };
}
export type MissionSession = ReturnType<typeof useMission>;
