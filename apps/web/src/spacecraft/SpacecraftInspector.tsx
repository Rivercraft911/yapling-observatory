import type { AssetInfo, Variant } from '../types';
import { OPTIONAL_MODULES } from './previewVisibility';

export function SpacecraftInspector({
  variant,
  asset,
  onVariant,
  followAttitude,
  onFollowAttitude,
  onApply,
  hasRun,
  cutaway,
  onCutaway,
  cutawayAvailable,
  starTrackerVisible,
  onStarTrackerVisible,
  moduleVisibility,
  availableModules,
  onModuleVisibility,
}: {
  variant: Variant;
  asset?: AssetInfo;
  onVariant: (variant: Variant) => void;
  followAttitude: boolean;
  onFollowAttitude: (enabled: boolean) => void;
  onApply: () => void;
  hasRun: boolean;
  cutaway: boolean;
  onCutaway: (enabled: boolean) => void;
  cutawayAvailable: boolean;
  starTrackerVisible: boolean;
  onStarTrackerVisible: (visible: boolean) => void;
  moduleVisibility: Record<string, boolean>;
  availableModules: string[];
  onModuleVisibility: (groups: string[], visible: boolean) => void;
}) {
  return (
    <div className="spacecraft-inspector">
      <div className="controls-title">
        <span className="eyebrow">SPACECRAFT</span>
        <span className="inspector-revision">{asset?.revision || '—'}</span>
      </div>
      <div className="scenario-name">
        {cutaway ? 'Cutaway layout study' : '1U · deployable arrays'}
      </div>
      <fieldset>
        <legend>GEOMETRY</legend>
        <label
          className="spacecraft-follow"
          title={cutawayAvailable ? 'Internal layout study' : 'Cutaway preview unavailable'}
        >
          <input
            type="checkbox"
            checked={cutaway}
            disabled={!cutaway && !cutawayAvailable}
            onChange={(event) => onCutaway(event.target.checked)}
          />
          Cutaway{!cutawayAvailable ? ' · unavailable' : ''}
        </label>
        {cutaway && cutawayAvailable ? (
          <label className="spacecraft-follow">
            <input
              type="checkbox"
              checked={starTrackerVisible}
              onChange={(event) => onStarTrackerVisible(event.target.checked)}
            />
            Star tracker
          </label>
        ) : null}
        {cutaway &&
          OPTIONAL_MODULES.filter((module) =>
            module.groups.every((name) => availableModules.includes(name)),
          ).map((module) => (
            <label className="spacecraft-follow" key={module.label}>
              <input
                type="checkbox"
                checked={module.groups.every((name) => moduleVisibility[name] !== false)}
                onChange={(event) => onModuleVisibility(module.groups, event.target.checked)}
              />
              Show {module.label.toLowerCase()}
            </label>
          ))}
        {!cutaway ? (
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
        ) : null}
        {!cutaway || cutawayAvailable ? (
          <label
            className="spacecraft-follow"
            title="Show the computed spacecraft orientation at the shared timeline time. Turn off for a fixed inspection pose; simulation results stay unchanged."
          >
            <input
              type="checkbox"
              checked={followAttitude}
              disabled={!hasRun}
              onChange={(event) => onFollowAttitude(event.target.checked)}
            />
            Replay orientation
          </label>
        ) : null}
      </fieldset>
      {!cutaway ? (
        <button className="apply-assembly" onClick={onApply}>
          Use assembly in scenario
        </button>
      ) : null}
      <details className="spacecraft-evidence">
        <summary>Model details</summary>
        {cutaway ? (
          <p>
            Internal packaging concept. Hardware, fit and optical coverage are unverified.
            Visibility changes do not update the scenario, mass or inertia.
          </p>
        ) : (
          <p>
            White PCB, body cells and four deployables. Antenna meshes show the concept geometry.
            Installed RF and flight fit are unverified.
          </p>
        )}
        <p>Use the view controls to orbit, fly or focus a selected part.</p>
      </details>
    </div>
  );
}
