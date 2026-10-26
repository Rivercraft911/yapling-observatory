import { useRef } from 'react';
import type { MissionSession } from './useMission';

export function MissionArchiveControls({ mission }: { mission: MissionSession }) {
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => menu.current?.removeAttribute('open');
  return (
    <details className="mission-file-menu" ref={menu}>
      <summary title="Save or open a completed mission history">File</summary>
      <div className="mission-file-options">
        <button
          type="button"
          disabled={!mission.canSave || mission.saving || mission.importing}
          title="Save the displayed run with its archived inputs, including any stopped valid prefix."
          onClick={() => {
            close();
            void mission.saveArchive();
          }}
        >
          {mission.saving ? 'Saving…' : 'Save run'}
        </button>
        <button
          type="button"
          disabled={mission.busy || mission.importing}
          title="Validate and open a local mission archive without recomputing it."
          onClick={() => {
            close();
            input.current?.click();
          }}
        >
          {mission.importing ? 'Opening…' : 'Open run…'}
        </button>
      </div>
      <input
        ref={input}
        className="mission-archive-input"
        type="file"
        accept="application/json,.json"
        aria-label="Open mission archive"
        disabled={mission.busy || mission.importing}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void mission.openArchive(file);
        }}
      />
    </details>
  );
}
