import type { AssetInfo, Variant } from '../types';

export function SpacecraftInspector({
  variant,
  asset,
  onVariant,
  followAttitude,
  onFollowAttitude,
  onApply,
  hasRun,
}: {
  variant: Variant;
  asset?: AssetInfo;
  onVariant: (variant: Variant) => void;
  followAttitude: boolean;
  onFollowAttitude: (enabled: boolean) => void;
  onApply: () => void;
  hasRun: boolean;
}) {
  return (
    <div className="spacecraft-inspector">
      <div className="controls-title">
        <span className="eyebrow">SPACECRAFT</span>
        <span className="inspector-revision">{asset?.revision || '—'}</span>
      </div>
      <div className="scenario-name">1U · deployable arrays</div>
      <fieldset>
        <legend>GEOMETRY</legend>
        <label className="field-row">
          <span>Antenna assembly</span>
          <select
            aria-label="Spacecraft antenna assembly"
            value={variant}
            onChange={(event) => onVariant(event.target.value as Variant)}
          >
            <option value="dipole">Straight dipole</option>
            <option value="turnstile">Turnstile</option>
            <option value="v45">45° V / tape</option>
          </select>
        </label>
        <label className="spacecraft-follow">
          <input
            type="checkbox"
            checked={followAttitude}
            disabled={!hasRun}
            onChange={(event) => onFollowAttitude(event.target.checked)}
          />
          Follow run attitude
        </label>
      </fieldset>
      <button className="apply-assembly" onClick={onApply}>
        Use assembly in scenario
      </button>
      <details className="spacecraft-evidence">
        <summary>Model details</summary>
        <p>
          White PCB, body cells and four deployables. Antenna meshes show the concept geometry.
          Installed RF and flight fit are unverified.
        </p>
        <p>Use the view controls to orbit, fly or focus a selected part.</p>
      </details>
    </div>
  );
}
