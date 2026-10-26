import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (typeof BUNDLED_GROUND_TRACK_LAYER_TEST === 'undefined') {
  const { build } = await import('esbuild');
  const scratch = await mkdtemp(join(tmpdir(), 'ssi-ground-track-layer-'));
  try {
    const output = join(scratch, 'check.mjs');
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      define: { BUNDLED_GROUND_TRACK_LAYER_TEST: 'true' },
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
  const { PerspectiveCamera } = await import('three');
  const { GroundTrackLayer } = await import('./GroundTrackLayer.ts');
  const { WGS84_A_M, WGS84_B_OVER_A } = await import('./geodesy.ts');
  const samples = (count) => ({
    time_s: Array.from({ length: count }, (_, i) => i * 30),
    satellite_position_ecef_m: Array.from({ length: count }, (_, i) => [
      (WGS84_A_M + 550000) * Math.cos(i * 0.03),
      (WGS84_A_M + 550000) * Math.sin(i * 0.03),
      0,
    ]),
    visible: Array.from({ length: count }, (_, i) => i % 5 > 0 && i % 5 < 4),
    elevation_deg: Array.from({ length: count }, (_, i) => (i % 5 === 2 ? 50 : 5)),
    range_m: Array.from({ length: count }, (_, i) => (i % 5 === 2 ? 550000 : 700000)),
    radio_active: Array.from({ length: count }, () => true),
    active_direction: Array.from({ length: count }, () => 'uplink'),
    uplink: { margin_db: Array.from({ length: count }, () => 10) },
    downlink: { margin_db: Array.from({ length: count }, () => 10) },
  });
  const input = samples(5);
  const original = structuredClone(input);
  const layer = new GroundTrackLayer(2);
  layer.setSamples(input);
  assert.equal(layer.group.visible, false);
  layer.setEnabled(true, Infinity);
  layer.updateSample(2, input.satellite_position_ecef_m[2], 60);
  assert.equal(layer.group.visible, true);
  const trace = layer.group.getObjectByName('Ground track');
  const contact = layer.group.getObjectByName('Above-mask samples');
  const rf = layer.group.getObjectByName('Sampled RF opportunities');
  const markers = layer.group.getObjectByName('Sampled pass markers');
  const cursor = layer.group.getObjectByName('Current subsatellite point');
  assert.equal(rf.isPoints, true, 'RF evidence is shown only at returned samples');
  assert.equal(rf.geometry.drawRange.count, 3);
  assert.equal(markers.geometry.drawRange.count, 3, 'Coincident extrema share one circle');
  const glyphs = Array.from(markers.geometry.getAttribute('glyph').array.slice(0, 3));
  assert.deepEqual(glyphs, [0, 2, 1]);
  assert.ok(cursor.position.length() > 1 && cursor.position.length() < 1.001);
  assert.equal(markers.material.uniforms.pixelRatio.value, 2);
  assert.ok(layer.group.renderOrder > 2, 'The overlay sorts after transparent atmosphere');

  function checkGeometry(object) {
    const geometry = object.geometry;
    const positions = geometry.getAttribute('position');
    assert.equal(positions.array.length % 3, 0);
    assert.ok(Number.isInteger(positions.count));
    assert.ok(Number.isFinite(geometry.boundingSphere.radius));
    for (let i = 0; i < geometry.drawRange.count; i++) {
      const point = [positions.getX(i), positions.getY(i), positions.getZ(i)];
      assert.ok(point.every(Number.isFinite));
      const radius = Math.hypot(point[0], point[1] / WGS84_B_OVER_A, point[2]);
      assert.ok(radius > 1 && radius < 1.001);
    }
    if (object.isLineSegments) {
      for (let i = 0; i < geometry.drawRange.count; i += 2) {
        const x = (positions.getX(i) + positions.getX(i + 1)) / 2;
        const y = (positions.getY(i) + positions.getY(i + 1)) / 2;
        const z = (positions.getZ(i) + positions.getZ(i + 1)) / 2;
        assert.ok(Math.hypot(x, y / WGS84_B_OVER_A, z) > 1, 'Chord stays above Earth');
      }
    }
    assert.equal(object.material.depthTest, true);
    assert.equal(object.material.depthWrite, false);
  }
  [trace, contact, rf, markers].forEach(checkGeometry);
  const geometry = trace.geometry;
  const version = trace.geometry.getAttribute('position').version;
  const rfVersion = rf.geometry.getAttribute('position').version;
  layer.updateSample(2, input.satellite_position_ecef_m[3], 65);
  layer.updateSample(3, input.satellite_position_ecef_m[3], 90);
  assert.equal(trace.geometry, geometry);
  assert.equal(trace.geometry.getAttribute('position').version, version);
  assert.equal(rf.geometry.getAttribute('position').version, rfVersion);
  assert.deepEqual(input, original);

  const camera = new PerspectiveCamera();
  camera.position.set(3, 0, 0);
  layer.updateCamera(camera);
  assert.deepEqual(
    Array.from(markers.geometry.getAttribute('visibleMarker').array.slice(0, 3)),
    [1, 1, 1],
  );
  camera.position.set(-3, 0, 0);
  layer.updateCamera(camera);
  assert.deepEqual(
    Array.from(markers.geometry.getAttribute('visibleMarker').array.slice(0, 3)),
    [0, 0, 0],
  );
  assert.equal(cursor.geometry.getAttribute('visibleMarker').getX(0), 0);

  layer.setEnabled(true, 60);
  layer.updateSample(2, input.satellite_position_ecef_m[2], 60);
  assert.equal(layer.statistics.pointCount, 3);
  const shortVersion = contact.geometry.getAttribute('position').version;
  layer.updateSample(2, input.satellite_position_ecef_m[2], 60.2);
  assert.equal(contact.geometry.getAttribute('position').version, shortVersion);
  layer.updateSample(1, input.satellite_position_ecef_m[1], 30);
  assert.ok(contact.geometry.getAttribute('position').version > shortVersion);
  assert.equal(trace.geometry, geometry, 'Buffers are reused while capacity is sufficient');

  let releasedOldBuffer = false;
  geometry.addEventListener('dispose', () => (releasedOldBuffer = true));
  const large = samples(20000);
  layer.setSamples(large);
  layer.setEnabled(true, Infinity);
  layer.updateSample(10000, large.satellite_position_ecef_m[10000], 300000);
  assert.equal(releasedOldBuffer, true);
  assert.ok(layer.statistics.markerCount <= 64);
  assert.ok(layer.statistics.omittedMarkerCount > 0);
  [trace, contact, rf, markers].forEach(checkGeometry);
  const largeVersion = trace.geometry.getAttribute('position').version;
  const largeRfVersion = rf.geometry.getAttribute('position').version;
  layer.updateSample(10001, large.satellite_position_ecef_m[10001], 300030);
  assert.equal(trace.geometry.getAttribute('position').version, largeVersion);
  assert.equal(rf.geometry.getAttribute('position').version, largeRfVersion);

  layer.setEnabled(false);
  assert.equal(layer.group.visible, false);
  layer.setSamples(undefined);
  assert.equal(layer.statistics.pointCount, 0);
  const resources = new Set(
    layer.group.children.flatMap((object) => [object.geometry, object.material]),
  );
  const disposed = new Set();
  for (const resource of resources)
    resource.addEventListener('dispose', () => disposed.add(resource));
  layer.dispose();
  assert.equal(disposed.size, resources.size);
  assert.equal(layer.group.children.length, 0);
  console.log(
    'Ground-track layer passed: real Three buffers, finite bounds, raised surface chords, sampled RF dots, distinct pass glyphs, ellipsoid marker occlusion, immutable samples, cursor/window caching, 20k-sample reuse and resource disposal. GPU appearance remains a browser QA check.',
  );
}
