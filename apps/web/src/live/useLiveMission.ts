import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { MissionConfig } from '../mission/missionTypes';
import type { RunSnapshot } from '../types';
import { LiveHistory } from './liveHistory';
import type { LiveSession, PointingIntent } from './liveTypes';

const activeStates = new Set(['starting', 'running', 'paused', 'stopping']);
const savedId = () => {
  try {
    return localStorage.getItem('ssi-live-session');
  } catch {
    return null;
  }
};
function remember(id: string | null) {
  try {
    if (id) localStorage.setItem('ssi-live-session', id);
    else localStorage.removeItem('ssi-live-session');
  } catch {
    /* Storage is optional. */
  }
}

export function useLiveMission() {
  const [id, setId] = useState(savedId);
  const [restoring, setRestoring] = useState(() => !!savedId());
  const [session, setSession] = useState<LiveSession | null>(null);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const history = useRef(new LiveHistory());
  const generation = useRef(0);
  const idRef = useRef(id);
  idRef.current = id;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const ingest = useCallback((next: LiveSession) => {
    const added = history.current.accept(next);
    if (added || !sessionRef.current || next.final_snapshot)
      setSnapshot(history.current.snapshot(next));
    setSession(next);
    sessionRef.current = next;
    if (next.error) setError(next.error);
  }, []);
  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    const own = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await api<{ session: LiveSession }>(
          `/api/live/${encodeURIComponent(id)}?after_sequence=${history.current.sequence}`,
          { signal: abort.signal },
        );
        if (abort.signal.aborted || generation.current !== own || idRef.current !== id) return;
        ingest(response.session);
        setRestoring(false);
        if (
          activeStates.has(response.session.status) ||
          response.session.next_sequence < response.session.latest_sequence
        )
          timer = setTimeout(poll, 500);
      } catch (cause) {
        if (abort.signal.aborted || generation.current !== own || idRef.current !== id) return;
        setError(cause instanceof Error ? cause.message : 'Live telemetry unavailable');
        if (cause instanceof Error && cause.message.includes('session not found')) {
          remember(null);
          idRef.current = null;
          sessionRef.current = null;
          setSession(null);
          setPending(false);
          setRestoring(false);
          setId(null);
          return;
        }
        timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [id, ingest]);
  const start = useCallback(
    async (scenario: MissionConfig, speed: number) => {
      if (
        pending ||
        restoring ||
        (idRef.current !== null && sessionRef.current === null) ||
        (sessionRef.current && activeStates.has(sessionRef.current.status))
      )
        return;
      const own = ++generation.current;
      setPending(true);
      setError('');
      try {
        const response = await api<{ session: LiveSession }>('/api/live', {
          method: 'POST',
          body: JSON.stringify({ scenario, speed }),
        });
        if (generation.current !== own) return;
        history.current = new LiveHistory();
        setSnapshot(null);
        sessionRef.current = null;
        ingest(response.session);
        remember(response.session.live_id);
        idRef.current = response.session.live_id;
        setId(response.session.live_id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not start live simulation');
      } finally {
        if (generation.current === own) setPending(false);
      }
    },
    [ingest, pending, restoring],
  );
  const send = useCallback(
    async (path: string, body: unknown, method = 'POST') => {
      if (!id || pending) return false;
      const own = generation.current;
      const current = () => generation.current === own && idRef.current === id;
      setPending(true);
      setError('');
      try {
        await api(`/api/live/${encodeURIComponent(id)}${path}`, {
          method,
          body: body == null ? undefined : JSON.stringify(body),
        });
        return current();
      } catch (cause) {
        if (current()) setError(cause instanceof Error ? cause.message : 'Live command failed');
        return false;
      } finally {
        if (current()) setPending(false);
      }
    },
    [id, pending],
  );
  const command = useCallback(
    (intent: Omit<PointingIntent, 'command_id'>) =>
      send('/commands', {
        ...intent,
        command_id: crypto.randomUUID(),
      }),
    [send],
  );
  const control = useCallback(
    (change: { speed?: number; paused?: boolean; stop?: boolean }) => send('/control', change),
    [send],
  );
  const cancel = useCallback(() => send('', null, 'DELETE'), [send]);
  return {
    session,
    snapshot,
    restoring,
    error,
    pending,
    start,
    control,
    command,
    cancel,
    active: !!session && activeStates.has(session.status),
    historyGap: history.current.gap,
    acknowledgments: history.current.acknowledgments,
    clearError: () => setError(''),
  };
}
export type LiveMissionSession = ReturnType<typeof useLiveMission>;
