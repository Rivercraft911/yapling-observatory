import { useEffect, useState } from 'react';
import { api } from '../api';
import './field-model.css';
import type { AntennaCatalog, AntennaModel, Pattern, SphericalHarmonicProfile } from './types';

export const profileEvidenceLabel = (profile: SphericalHarmonicProfile) =>
  ({
    analytical: 'Analytical reference',
    em_simulated: 'EM simulation',
    measured: 'Measured profile',
    illustrative: 'Illustrative only',
  })[profile.provenance.status];

export function downloadProfile(profile: SphericalHarmonicProfile) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(profile, null, 2) + '\n'], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${profile.name.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'antenna'}-${profile.revision.replace(/[^a-zA-Z0-9_-]+/g, '-')}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FieldModelDetails({
  profile,
  model = 'spherical_harmonic',
  orientationDeg,
  definition,
}: {
  profile?: SphericalHarmonicProfile;
  model?: AntennaModel;
  orientationDeg?: [number, number, number];
  definition?: Pattern['definition'];
}) {
  const [open, setOpen] = useState(false);
  const [definitions, setDefinitions] = useState<AntennaCatalog['models'] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const current = definition || definitions?.[model];
  useEffect(() => {
    if (!open || current) {
      setLoading(false);
      setError('');
      return;
    }
    if (definitions) {
      setLoading(false);
      setError('Field definition unavailable');
      return;
    }
    const abort = new AbortController();
    let active = true;
    setLoading(true);
    setError('');
    api<AntennaCatalog>('/api/antenna-lab/catalog', { signal: abort.signal })
      .then((catalog) => {
        if (active) setDefinitions(catalog.models || {});
      })
      .catch((cause) => {
        if (active && cause.name !== 'AbortError')
          setError(cause.message || 'Field definition unavailable');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      abort.abort();
    };
  }, [open, model, definition, definitions]);
  return (
    <details
      className="antenna-field-model"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <summary>Field model</summary>
      {current?.formula ? <pre className="antenna-formula">{current.formula}</pre> : null}
      {loading ? <small>Loading field definition…</small> : null}
      {error ? <small role="alert">{error}</small> : null}
      {profile ? (
        <dl>
          <dt>Profile</dt>
          <dd>
            {profile.name} · {profile.revision}
          </dd>
          <dt>Evidence</dt>
          <dd>{profileEvidenceLabel(profile)}</dd>
          <dt>Degree</dt>
          <dd>
            ℓ ≤ {profile.maximum_degree} · {profile.coefficients.length} coefficient pairs
          </dd>
          <dt>Frequency</dt>
          <dd>{profile.frequency_hz / 1e6} MHz · single frequency</dd>
          <dt>Efficiency</dt>
          <dd>η = {profile.radiation_efficiency} · included once</dd>
          <dt>Mount</dt>
          <dd>{(orientationDeg || [0, 0, 0]).join('°, ')}° · Rz Ry Rx</dd>
        </dl>
      ) : null}
      {current?.conventions ? <p>{current.conventions}</p> : null}
      {current?.axes ? <p>{current.axes}</p> : null}
      {current?.limits ? <p>{current.limits}</p> : null}
      {current?.function ? <code>{current.function}</code> : null}
      {profile ? (
        <>
          <p className="antenna-profile-source">{profile.provenance.source}</p>
          <p>{profile.provenance.conditions}</p>
          <details>
            <summary>Coefficient JSON</summary>
            <pre>{JSON.stringify(profile, null, 2)}</pre>
          </details>
          <button type="button" onClick={() => downloadProfile(profile)}>
            Download JSON
          </button>
        </>
      ) : null}
    </details>
  );
}
