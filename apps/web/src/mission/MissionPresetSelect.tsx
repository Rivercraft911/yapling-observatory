export type MissionPresetId = 'terminator' | 'daylight';

export function MissionPresetSelect({
  onSelect,
  disabled = false,
}: {
  onSelect: (preset: MissionPresetId) => Promise<void>;
  disabled?: boolean;
}) {
  return (
    <label className="mission-preset-select">
      <span>Mission preset</span>
      <select
        aria-label="Mission preset"
        value=""
        disabled={disabled}
        title="Replaces the draft inputs. Existing results stay available."
        onChange={(event) => void onSelect(event.target.value as MissionPresetId)}
      >
        <option value="" disabled>
          Load preset…
        </option>
        <option value="terminator">Terminator SSO</option>
        <option value="daylight">Daylight passes</option>
      </select>
    </label>
  );
}
