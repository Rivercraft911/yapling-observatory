export type MissionRequestKind =
  | 'defaults'
  | 'orbit'
  | 'run'
  | 'poll'
  | 'cancel'
  | 'import'
  | 'export';

export interface MissionRequest {
  signal: AbortSignal;
  current: () => boolean;
}

export class MissionRequests {
  private active = new Map<MissionRequestKind, AbortController>();
  private attached = true;
  private attachment = 0;

  attach() {
    this.attached = true;
    const attachment = ++this.attachment;
    return () => {
      if (attachment !== this.attachment) return;
      this.attached = false;
      // Immediate effect reattachment preserves requests; real unmounts invalidate replies now.
      queueMicrotask(() => {
        if (!this.attached && attachment === this.attachment) this.cancelAll();
      });
    };
  }

  begin(kind: MissionRequestKind): MissionRequest {
    this.cancel(kind);
    const controller = new AbortController();
    this.active.set(kind, controller);
    if (!this.attached) controller.abort();
    return {
      signal: controller.signal,
      current: () =>
        this.attached && this.active.get(kind) === controller && !controller.signal.aborted,
    };
  }

  cancel(...kinds: MissionRequestKind[]) {
    for (const kind of kinds) {
      const controller = this.active.get(kind);
      this.active.delete(kind);
      controller?.abort();
    }
  }

  cancelAll() {
    this.cancel(...this.active.keys());
  }

  inputsChanged() {
    this.cancel('defaults', 'orbit', 'import');
  }

  beginImport() {
    this.inputsChanged();
    this.cancel('run', 'poll', 'cancel');
    return this.begin('import');
  }
}

export function canAdvanceMissionRun(
  current: { run_id: string; status: string } | null,
  next: { run_id: string; status: string },
) {
  if (!current || current.run_id !== next.run_id) return true;
  const pending = new Set(['queued', 'running', 'cancelling']);
  if (!pending.has(current.status) && pending.has(next.status)) return false;
  return current.status !== 'cancelling' || !['queued', 'running'].includes(next.status);
}
