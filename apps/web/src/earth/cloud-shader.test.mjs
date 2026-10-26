import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { DataTexture, RedFormat, Texture } from 'three';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./atmosphereAdapter.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  external: ['three'],
});
const compiled = bundled.outputFiles[0].text.replace(
  /from ['"]three['"]/g,
  `from '${import.meta.resolve('three')}'`,
);
const { createEarthAppearance } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
);
const smoothstep = (lo, hi, x) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
// Evaluate the actual scalar GLSL helper, without maintaining a second shader formula.
const scalarShader = (shader, name) => {
  const match = shader.match(new RegExp(`float ${name}\\(([^)]*)\\)\\{([^}]+)\\}`));
  assert.ok(match, `Missing scalar shader ${name}`);
  const parameters = match[1]
    .split(',')
    .map((parameter) => parameter.trim().replace(/^float /, ''));
  const body = match[2].replace(/float /g, 'let ');
  return new Function(
    'sqrt',
    'pow',
    'max',
    'min',
    'smoothstep',
    'clamp',
    `return function(${parameters.join(',')}) {${body}}`,
  )(Math.sqrt, Math.pow, Math.max, Math.min, smoothstep, (x, lo, hi) =>
    Math.max(lo, Math.min(hi, x)),
  );
};
const textures = Array.from({ length: 4 }, () => new Texture());
const [day, cloud, ocean, night] = textures;
const appearance = createEarthAppearance(day, cloud, ocean, 9, night);
const fallback = createEarthAppearance(day, cloud, ocean, 0);
assert.equal(appearance.surface.uniforms.nightMap.value, night);
assert.equal(appearance.surface.uniforms.nightIntensity.value, 0.35);
assert.equal(fallback.surface.uniforms.nightIntensity.value, 0);
assert.equal(fallback.surface.uniforms.nightMap.value, day);
assert.equal(appearance.surface.uniforms.nightGrayscale.value, false);
const grayscale = new DataTexture(new Uint8Array([128]), 1, 1, RedFormat);
const detailed = createEarthAppearance(day, cloud, ocean, 0, grayscale);
assert.equal(detailed.surface.uniforms.nightGrayscale.value, true);
assert.equal(detailed.surface.uniforms.regionalNightOpacity.value, 0);
const bounds = [0.1, 0.2, 0.3, 0.4];
detailed.setNightDetail({ texture: grayscale, bounds, opacity: 0.73 });
assert.equal(detailed.surface.uniforms.regionalNightMap.value, grayscale);
assert.equal(detailed.surface.uniforms.regionalNightOpacity.value, 0.73);
assert.deepEqual(detailed.surface.uniforms.regionalNightBounds.value.toArray(), bounds);
assert.match(detailed.surface.fragmentShader, /texture2DGradEXT\(regionalNightMap/);
assert.match(detailed.surface.fragmentShader, /lights=mix\(lights,nativeLights,nightMix\)/);
assert.match(detailed.surface.fragmentShader, /nightIntensity\*nightLightFade\(ndl\)/);
detailed.setNightDetail({ texture: null, bounds, opacity: 1 });
assert.equal(detailed.surface.uniforms.regionalNightOpacity.value, 0);
assert.equal(detailed.surface.uniforms.regionalNightMap.value, grayscale);
const decodeNight = scalarShader(detailed.surface.fragmentShader, 'nightDisplayToLinear');
assert.equal(decodeNight(0), 0);
assert.equal(decodeNight(1), 1);
assert.ok(Math.abs(decodeNight(0.5) - 0.21404114048223255) < 1e-12);
assert.ok(Math.abs(decodeNight(0.04045 - 1e-8) - decodeNight(0.04045 + 1e-8)) < 1e-8);
detailed.dispose();
grayscale.dispose();
assert.equal(fallback.clouds.fragmentShader.includes('nativeCloudMaps'), false);
for (const name of ['cloudMap', 'nativeCloudMaps', 'nativeCloudOpacity', 'nativeCloudFeather']) {
  assert.equal(appearance.surface.uniforms[name], appearance.clouds.uniforms[name]);
}
const sunlight = scalarShader(appearance.clouds.fragmentShader, 'cloudSunlight');
const combine = scalarShader(appearance.clouds.fragmentShader, 'combineCloudCoverage');
const nightFade = scalarShader(appearance.surface.fragmentShader, 'nightLightFade');
const radius = 1 + 8000 / 6378137;
const horizon = -Math.sqrt(1 - 1 / radius ** 2);
assert.ok(Math.abs((Math.asin(horizon) * 180) / Math.PI + 2.8682) < 0.001);
// The elevated shell still sees the Sun at the ground terminator, but not through Earth.
assert.ok(sunlight(0, radius) > 0.2);
assert.equal(sunlight(-1, radius), 0);
assert.equal(sunlight(horizon - 0.00465, radius), 0);
assert.ok(Math.abs(sunlight(1, radius) - 1) < 1e-12);
for (const r of [1, radius, 1.01255, 1.02]) {
  let previous = 0;
  for (let i = 0; i <= 20000; i++) {
    const mu = -1 + i / 10000;
    const value = sunlight(mu, r);
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1 + 1e-12);
    assert.ok(value >= previous - 1e-12);
    previous = value;
  }
}
for (const mu of [horizon - 0.00465, horizon, horizon + 0.00465, 0]) {
  assert.ok(Math.abs(sunlight(mu + 1e-7, radius) - sunlight(mu - 1e-7, radius)) < 1e-5);
}
// Known coverage is a convex blend; overlapping native gutters are order-independent.
assert.equal(combine(0.3, 0, 0), 0.3);
assert.ok(Math.abs(combine(0.2, 0.9 * 0.5, 0.5) - 0.55) < 1e-12);
const samples = [
  { coverage: 0.1, weight: 0.9 },
  { coverage: 0.8, weight: 0.3 },
  { coverage: 0.6, weight: 0.7 },
];
const blend = (list) =>
  combine(
    0.2,
    list.reduce((total, sample) => total + sample.coverage * sample.weight, 0),
    list.reduce((total, sample) => total + sample.weight, 0),
  );
assert.ok(Math.abs(blend(samples) - blend([...samples].reverse())) < 1e-12);
for (const base of [0, 0.3, 1]) {
  for (const coverage of [0, 0.4, 1]) {
    for (const weight of [0, 1e-8, 0.1, 0.999, 1, 1.001, 2, 9]) {
      const result = combine(base, coverage * weight, weight);
      assert.ok(Number.isFinite(result) && result >= 0 && result <= 1 + 1e-12);
      if (weight >= 1) assert.ok(Math.abs(result - coverage) < 1e-12);
    }
  }
}
// Edge support uses real 8-pixel gutters rather than dropping a neighbor abruptly.
assert.match(appearance.clouds.fragmentShader, /vec2 gutter=vec2\(16\.\)\/vec2\(textureSize/);
assert.match(appearance.clouds.fragmentShader, /nativeCoverage\+=tile\*blend;nativeWeight\+=blend/);
assert.doesNotMatch(appearance.clouds.fragmentShader, /base=mix\(base,tile,blend\)/);
assert.equal(nightFade(1), 0);
assert.equal(nightFade(0.02), 0);
assert.equal(nightFade(-1), 1);
let previous = 1;
for (let i = 0; i <= 2000; i++) {
  const value = nightFade(-1 + i / 1000);
  assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  assert.ok(value <= previous);
  previous = value;
}
appearance.dispose();
fallback.dispose();
textures.forEach((texture) => texture.dispose());
console.log(
  'Cloud shader checks passed: geometric elevated horizon, bounded continuous illumination, shared shadow/alpha, convex order-independent gutter blend and optional night-map dusk fade. GPU/visual review remains separate.',
);
