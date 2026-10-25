import { api } from '../api.ts';
import type { MissionArchiveImport, MissionRun, MissionSnapshot } from './missionTypes';

export const MAX_MISSION_ARCHIVE_BYTES = 64 * 1024 * 1024;

export async function readMissionArchive(file: Pick<File, 'size' | 'text'>, signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Opening cancelled', 'AbortError');
  if (file.size > MAX_MISSION_ARCHIVE_BYTES) throw new Error('Mission archive exceeds 64 MiB.');
  if (!file.size) throw new Error('Mission archive is empty.');
  const text = await file.text();
  if (signal.aborted) throw new DOMException('Opening cancelled', 'AbortError');
  return text;
}

export function importMissionArchive(text: string, signal: AbortSignal) {
  return api<MissionArchiveImport>('/api/mission/archive/import', {
    method: 'POST',
    body: text,
    signal,
  });
}

function responseError(text: string, fallback: string) {
  try {
    const body = JSON.parse(text);
    if (typeof body?.detail === 'string') return body.detail;
    if (Array.isArray(body?.detail))
      return body.detail
        .slice(0, 3)
        .map((issue: { msg?: string }) => issue.msg || 'Invalid archive')
        .join('\n');
  } catch {
    /* A service error may not contain JSON. */
  }
  return fallback;
}

export async function requestMissionRun(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(responseError(text, 'Mission request failed.'));
  let run: unknown;
  try {
    run = JSON.parse(text);
  } catch {
    throw new Error('The service returned invalid mission JSON.');
  }
  if (!run || typeof run !== 'object' || !('run_id' in run))
    throw new Error('The service returned no mission run.');
  return { run: run as MissionRun, text };
}

export async function prepareMissionArchive(snapshot: MissionSnapshot, signal: AbortSignal) {
  if (snapshot.imported) {
    if (!snapshot.original_archive_json)
      throw new Error('The original archive is unavailable; open the file again.');
    return snapshot.original_archive_json;
  }
  if (!snapshot.raw_run_json)
    throw new Error('This history predates archive capture; run the mission again before saving.');
  const response = await fetch('/api/mission/archive/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: snapshot.raw_run_json,
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(responseError(text, 'Mission archive could not be saved.'));
  }
  return text;
}

export function downloadMissionArchive(text: string, runId: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ssi-mission-${runId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'run'}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
