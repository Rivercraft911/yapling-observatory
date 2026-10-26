import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  Texture,
  BackSide,
  NoColorSpace,
  RGFormat,
  RepeatWrapping,
  Color,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  Vector3,
  Vector4,
} from 'three';

const bundle = await build({
  stdin: {
    contents: `export * from './cloudVolume.ts'; export * from './atmosphereAdapter.ts'; export * from './CloudVolumePass.ts';`,
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  external: ['three'],
});
const compiled = bundle.outputFiles[0].text.replace(
  /from ['"](three(?:\/[^'"]+)?)['"]/g,
  (_, specifier) => `from '${import.meta.resolve(specifier)}'`,
);
const {
  createCloudNoise,
  cloudVolumeWeight,
  cloudVolumeFragment,
  createEarthAppearance,
  CloudVolumePass,
  cloudPassSize,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const noise = createCloudNoise();
const second = createCloudNoise();
assert.deepEqual([noise.image.width, noise.image.height, noise.image.depth], [64, 64, 64]);
assert.equal(noise.image.data.byteLength, 524288);
assert.equal(noise.image.data, second.image.data);
assert.notEqual(noise, second);
assert.equal(noise.format, RGFormat);
assert.equal(noise.colorSpace, NoColorSpace);
assert.equal(noise.generateMipmaps, true);
assert.equal(noise.wrapS, RepeatWrapping);
assert.equal(noise.wrapT, RepeatWrapping);
assert.equal(noise.wrapR, RepeatWrapping);
assert.ok(new Set(noise.image.data).size > 150);
noise.dispose();
second.dispose();

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mix = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function functionBody(source, name) {
  const start = source.indexOf('{', source.indexOf(`${name}(`));
  assert.ok(start >= 0, `Missing ${name}`);
  let depth = 1;
  let end = start;
  while (depth) {
    end++;
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    assert.ok(end < source.length);
  }
  return source.slice(start + 1, end);
}
function scalar(name, parameters, dependencies = {}) {
  const body = functionBody(cloudVolumeFragment, name).replace(/\bfloat\b/g, 'let');
  const globals = { clamp, max: Math.max, log: Math.log, ...dependencies };
  return new Function(...Object.keys(globals), `return (${parameters})=>{${body}}`)(
    ...Object.values(globals),
  );
}
const integral = scalar('cloudProfileIntegral', 'u');
const opticalDepth = scalar('cloudOpticalDepth', 'coverage');
assert.equal(integral(-1), 0);
assert.equal(integral(2), 1);
assert.equal(integral(0.5), 0.5);
for (const coverage of [0, 0.02, 0.05, 0.1, 0.2, 0.5, 0.75, 1])
  assert.ok(Math.abs(1 - Math.exp(-opticalDepth(coverage)) - 0.94 * coverage) < 1e-14);

// Exercise the actual scalar density section with controlled noise/constant coverage.
// This isolates the appearance budget from spatial atlas gradients and GPU filtering.
const densityBody = functionBody(cloudVolumeFragment, 'cloudDensity')
  .slice(functionBody(cloudVolumeFragment, 'cloudDensity').indexOf('float strong='))
  .replace(/float height=[^;]+;/, '')
  .replace('first.g-second.g', 'erosion')
  .replace(/\bfloat\b/g, 'let');
const density = new Function(
  'smoothstep',
  'mix',
  'max',
  'cloudProfileIntegral',
  'cloudOpticalDepth',
  `return (coverage,height,body,erosion,verticalFootprintKm)=>{${densityBody}}`,
)(smoothstep, mix, Math.max, integral, opticalDepth);
for (const coverage of [0.02, 0.05, 0.1, 0.2, 0.5, 0.75, 1]) {
  for (const steps of [8, 12, 24, 96]) {
    for (const body of [0.2, 0.5, 0.8]) {
      for (const erosion of [-0.6, 0, 0.6]) {
        const step = 8 / steps;
        let tau = 0;
        for (let i = 0; i < steps; i++)
          tau += density(coverage, 2 + (i + 0.5) * step, body, erosion, step) * step;
        const alpha = 1 - Math.exp(-tau);
        assert.ok(Math.abs(alpha - 0.94 * coverage) < 0.0001, `${coverage}/${steps}: ${alpha}`);
      }
    }
  }
}

// Evaluate the shader's actual interval selection using minimal vector constructors.
class Vec extends Array {
  get x() {
    return this[0];
  }
  set x(v) {
    this[0] = v;
  }
  get y() {
    return this[1];
  }
  set y(v) {
    this[1] = v;
  }
  get z() {
    return this[2];
  }
  set z(v) {
    this[2] = v;
  }
  get w() {
    return this[3];
  }
  set w(v) {
    this[3] = v;
  }
  get xy() {
    return new Vec(this.x, this.y);
  }
  set xy(v) {
    [this.x, this.y] = v;
  }
  get zw() {
    return new Vec(this.z, this.w);
  }
  set zw(v) {
    [this.z, this.w] = v;
  }
}
const vec2 = (...v) => new Vec(...(v.length === 1 ? [v[0], v[0]] : v));
const vec4 = (...v) => new Vec(...v);
const radiusKm = 6378.137;
const bottom = 1 + 2 / radiusKm;
const top = 1 + 10 / radiusKm;
const intersect = (o, d, r) => {
  const b = o.reduce((s, x, i) => s + x * d[i], 0);
  const h = b * b - o.reduce((s, x) => s + x * x, 0) + r * r;
  return h < 0 ? vec2(1e5, -1e5) : vec2(-b - Math.sqrt(h), -b + Math.sqrt(h));
};
const segments = new Function(
  'atmosphereIntersection',
  'max',
  'min',
  'cloudTop',
  'cloudBottom',
  'vec2',
  'vec4',
  `return (origin,ray)=>{${functionBody(cloudVolumeFragment, 'cloudSegments').replace(/\b(float|vec[24]) (?=\w+=)/g, 'let ')}}`,
)(intersect, Math.max, Math.min, top, bottom, vec2, vec4);
const occupiedKm = (s) => (s.y - s.x + s.w - s.z) * radiusKm;
assert.ok(Math.abs(occupiedKm(segments([1.1, 0, 0], [-1, 0, 0])) - 8) < 1e-8);
assert.ok(Math.abs(occupiedKm(segments([1 + 6 / radiusKm, 0, 0], [1, 0, 0])) - 4) < 1e-8);
assert.ok(Math.abs(occupiedKm(segments([1 + 6 / radiusKm, 0, 0], [-1, 0, 0])) - 4) < 1e-8);
assert.ok(Math.abs(occupiedKm(segments([1 + 1.3 / radiusKm, 0, 0], [1, 0, 0])) - 8) < 1e-8);
assert.equal(occupiedKm(segments([1.1, 0, 0], [1, 0, 0])), 0);
assert.equal(occupiedKm(segments([1.1, 0, 0], [0, 1, 0])), 0);
const limb = segments([1.1, 0, 0], [-Math.sqrt(1 - (1.0002 / 1.1) ** 2), 1.0002 / 1.1, 0]);
assert.ok(limb.y > limb.x && limb.z > limb.y && limb.w > limb.z);

let previous = 1;
for (let radius = 1; radius <= 2; radius += 0.001) {
  const weight = cloudVolumeWeight(radius);
  assert.ok(weight >= 0 && weight <= 1 && weight <= previous);
  assert.equal(cloudVolumeWeight(radius, false), 0);
  previous = weight;
}
const textures = [new Texture(), new Texture(), new Texture()];
const appearance = createEarthAppearance(...textures, 9, null, true);
assert.equal(appearance.clouds.side, BackSide);
assert.equal(appearance.clouds.depthWrite, false);
assert.equal(appearance.clouds.depthTest, true);
assert.equal(appearance.setCloudView({ x: 1.1, y: 0, z: 0 }, 0.00001), 1);
assert.equal(appearance.clouds.uniforms.cloudCameraNear.value, 0.00001);
assert.equal(appearance.setCloudView({ x: 2, y: 0, z: 0 }, 0.01), 0);
let released = 0;
appearance.clouds.uniforms.cloudNoise.value.addEventListener('dispose', () => released++);
appearance.dispose();
assert.equal(released, 1);
textures.forEach((t) => t.dispose());

assert.match(cloudVolumeFragment, /for\(int i=0;i<12;i\+\+\)/);
assert.match(cloudVolumeFragment, /for\(int j=0;j<2;j\+\+\)/);
assert.equal((cloudVolumeFragment.match(/throughAtmosphere\(/g) || []).length, 1);
assert.doesNotMatch(functionBody(cloudVolumeFragment, 'cloudDensity'), /dFdx|dFdy|cloudCoverage\(/);
assert.match(cloudVolumeFragment, /result=mix\(result,volume,cloudVolumeMix\)/);
assert.match(cloudVolumeFragment, /result.rgb\/result.a/);
assert.match(cloudVolumeFragment, /gl_FragDepth=clamp/);
assert.match(cloudVolumeFragment, /length\(ray\*earthAxes\)/);
assert.match(cloudVolumeFragment, /length\(light\*earthAxes\)/);
assert.match(cloudVolumeFragment, /if\(density<=0\.\)continue/);

// A near plane is axial view distance, not distance along a transformed slant ray.
const nearExpression = cloudVolumeFragment.match(/float tNear=([^;]+);/)[1];
const nearDistance = new Function(
  'cloudCameraNear',
  'axialPerT',
  'max',
  `return ${nearExpression};`,
);
const depthCamera = new PerspectiveCamera(70, 2, 0.0001, 4);
depthCamera.position.set(0.8, 0.5, 0.2).setLength(1.001);
depthCamera.lookAt(0, 0, 0);
depthCamera.updateMatrixWorld();
const axes = new Vector3(1, 0.9966471893, 1);
const origin = depthCamera.position.clone().divide(axes);
for (const x of [-0.95, 0, 0.95]) {
  for (const y of [-0.95, 0, 0.95]) {
    const ray = new Vector3(x, y, 0.5)
      .unproject(depthCamera)
      .sub(depthCamera.position)
      .divide(axes)
      .normalize();
    const direction = ray.clone().multiply(axes);
    const axial = -new Vector4(direction.x, direction.y, direction.z, 0).applyMatrix4(
      depthCamera.matrixWorldInverse,
    ).z;
    const t = nearDistance(depthCamera.near, axial, Math.max) * 1.01;
    const projected = origin.clone().addScaledVector(ray, t).multiply(axes).project(depthCamera);
    assert.ok(Number.isFinite(projected.z) && projected.z > -1 && projected.z < 1);
    if (x && y) {
      const old = origin
        .clone()
        .addScaledVector(ray, depthCamera.near * 1.01)
        .multiply(axes)
        .project(depthCamera);
      assert.ok(old.z < -1, 'Regression must expose the old off-axis floor');
    }
  }
}

for (const [width, height] of [
  [1, 1],
  [1000, 400],
  [2243, 847],
  [7680, 4320],
]) {
  const [w, h] = cloudPassSize(width, height);
  assert.ok(w >= 1 && h >= 1 && w * h <= 500000);
  assert.ok(w <= Math.max(1, width / 2) && h <= Math.max(1, height / 2));
}
for (const hdr of [true, false]) {
  const parentTarget = {};
  const originalColor = new Color(0.1, 0.2, 0.3);
  let current = parentTarget;
  let color = originalColor.clone();
  let clearAlpha = 0.7;
  let throwOnCloud = false;
  let renders = 0;
  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 2, 0.0001, 4);
  camera.position.set(1.1, 0, 0);
  camera.updateMatrixWorld();
  const material = new ShaderMaterial({ depthWrite: false });
  const renderer = {
    autoClear: true,
    extensions: { has: () => hdr },
    domElement: { dataset: {} },
    getDrawingBufferSize: (v) => v.set(2243, 847),
    getRenderTarget: () => current,
    setRenderTarget: (v) => {
      current = v;
    },
    getClearAlpha: () => clearAlpha,
    getClearColor: (v) => v.copy(color),
    setClearColor: (v, alpha) => {
      color.set(v);
      clearAlpha = alpha;
    },
    clear: (rgb, depth, stencil) => {
      assert.deepEqual([rgb, depth, stencil], [true, true, false]);
      assert.equal(color.getHex(), 0);
      assert.equal(clearAlpha, 0);
    },
    render: (object) => {
      renders++;
      if (object === scene) {
        assert.equal(material.depthWrite, true);
        assert.notEqual(current, parentTarget);
        if (throwOnCloud) throw new Error('injected draw failure');
      } else {
        assert.equal(current, parentTarget);
        assert.equal(material.depthWrite, false);
        assert.equal(object.material.blendSrc, OneFactor);
        assert.equal(object.material.blendDst, OneMinusSrcAlphaFactor);
        assert.equal(object.material.depthWrite, false);
        assert.equal(object.material.depthTest, true);
        assert.equal(object.material.toneMapped, false);
      }
    },
  };
  const pass = new CloudVolumePass(renderer);
  pass.resize();
  assert.deepEqual([pass.target.width, pass.target.height], cloudPassSize(2243, 847));
  assert.equal(pass.target.samples, 0);
  assert.ok(pass.target.depthTexture);
  pass.render(scene, camera, material);
  assert.equal(renders, 2);
  assert.equal(current, parentTarget);
  assert.equal(renderer.autoClear, true);
  assert.equal(clearAlpha, 0.7);
  assert.ok(color.equals(originalColor));
  throwOnCloud = true;
  assert.throws(() => pass.render(scene, camera, material), /injected draw failure/);
  assert.equal(current, parentTarget);
  assert.equal(renderer.autoClear, true);
  assert.equal(material.depthWrite, false);
  assert.equal(clearAlpha, 0.7);
  assert.ok(color.equals(originalColor));
  let released = 0;
  pass.target.addEventListener('dispose', () => released++);
  pass.material.addEventListener('dispose', () => released++);
  pass.dispose();
  assert.equal(released, 2);
  material.dispose();
}
console.log(
  'Cloud volume checks passed: bounded shared noise, actual optical-depth/profile calibration, outside/inside/below/limb ray intervals, continuous shell fallback and material/resource contract. GPU appearance and frame timing remain separate.',
);
