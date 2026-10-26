import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof BUNDLED_LIVE_DISPLAY_TEST === 'undefined') {
  const { build } = await import('esbuild');
  const scratch = await mkdtemp(join(tmpdir(), 'ssi-earth-live-display-'));
  try {
    const output = join(scratch, 'check.mjs');
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      define: { BUNDLED_LIVE_DISPLAY_TEST: 'true' },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: output,
      logLevel: 'warning',
    });
    await import(pathToFileURL(output).href);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
} else {
  const assert = (await import('node:assert/strict')).default;
  const { BufferGeometry, Float32BufferAttribute, Group, Color, Vector3 } = await import('three');
  const { EarthScene } = await import('./EarthScene.ts');
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10);
  const snapshot = (end) => ({
    scenario: {
      station: { latitude_deg: 0, longitude_deg: 0, height_m: 0 },
      epoch_utc: '2026-10-25T00:00:00Z',
      duration_s: 100,
    },
    run: {
      run_id: 'live-test',
      result: {
        samples: {
          time_s: Array.from({ length: end + 1 }, (_, i) => i),
          satellite_position_ecef_m: Array.from({ length: end + 1 }, (_, i) => [7e6, i, 0]),
          station_position_m: Array.from({ length: end + 1 }, () => [6378137, 0, 0]),
          sun_direction_ecef: Array.from({ length: end + 1 }, () => [1, 0, 0]),
          q_body_from_inertial_wxyz: Array.from({ length: end + 1 }, () => [1, 0, 0, 0]),
          visible: [false, true, true],
          active_direction: ['uplink', 'uplink', 'downlink'],
          uplink: { margin_db: [10, 10, 10] },
          downlink: { margin_db: [10, 10, 10] },
        },
      },
    },
  });
  const scene = Object.create(EarthScene.prototype);
  const display = { current: 0.4 };
  Object.assign(scene, {
    snapshot: null,
    sampleIndex: 1,
    displayTimeSource: display,
    satellite: { position: new Vector3() },
    station: { position: new Vector3() },
    stationPoint: new Vector3(),
    stationNormal: new Vector3(),
    history: new Group(),
    autoFramed: true,
    follow: {
      setSun() {},
      setPosition(position) {
        scene.displayedPosition = position;
      },
      setTemperatures() {},
      setPose(_pose, time) {
        scene.poseTime = time;
      },
    },
    sunDisplay: { setDirection() {} },
    targetDisplay: { clear() {}, setTarget() {} },
    labels: { target: {} },
    followLink: {
      setLink() {
        return { deltaDisplayM: [1, 0, 0] };
      },
    },
    losSolidMaterial: { color: new Color() },
    losDashedMaterial: { color: new Color() },
    losGeometry: new BufferGeometry().setAttribute(
      'position',
      new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3),
    ),
    losSolid: { position: new Vector3() },
    losDashed: { position: new Vector3(), computeLineDistances() {} },
    renderer: { domElement: { dataset: {} } },
  });
  const first = snapshot(1);
  scene.setHistory(first);
  near(scene.displayedPosition[1], 0.4);
  near(scene.poseTime, 0.4);
  assert.equal(scene.renderer.domElement.dataset.sampleIndex, '0');
  assert.equal(scene.losSolid.visible, false, 'A future link transition must not appear early');
  const paths = [...scene.history.children];
  scene.setHistory(first);
  assert.deepEqual(scene.history.children, paths, 'Sample-only updates retain path geometry');

  // This is the receipt path used by EarthView. Both calls used to briefly
  // overwrite the delayed pose with the newest discrete sample before rAF.
  scene.setHistory(snapshot(2));
  near(scene.displayedPosition[1], 0.4);
  scene.updateSample(2);
  near(scene.displayedPosition[1], 0.4);
  assert.equal(scene.renderer.domElement.dataset.sampleIndex, '0');
  scene.updateSample(2, 1.4);
  near(scene.displayedPosition[1], 1.4);
  assert.equal(scene.renderer.domElement.dataset.sampleIndex, '1');
  assert.equal(scene.losSolid.visible, true);

  // Replay without a graphics clock retains exact selected-sample behavior.
  scene.setDisplayTimeSource(undefined);
  near(scene.displayedPosition[1], 2);
  near(scene.poseTime, 2);
  assert.equal(scene.renderer.domElement.dataset.sampleIndex, '2');
  scene.clearHistory();
  scene.losGeometry.dispose();
  console.log(
    'Earth receipt presentation passed: actual setHistory/updateSample methods retain the buffered pose, discrete transitions use the displayed lower sample, repeated histories retain geometry and clock-free replay stays exact.',
  );
}
