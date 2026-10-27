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
  NormalBlending,
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
assert.equal((cloudVolumeFragment.match(/throughAtmosphere\(/g) || []).length, 2);
assert.doesNotMatch(functionBody(cloudVolumeFragment, 'cloudVolumeRay'), /throughAtmosphere/);
assert.doesNotMatch(functionBody(cloudVolumeFragment, 'cloudDensity'), /dFdx|dFdy|cloudCoverage\(/);
assert.match(cloudVolumeFragment, /result=mix\(shell,volume,cloudVolumeMix\)/);
assert.match(cloudVolumeFragment, /result.rgb\/result.a/);
assert.match(cloudVolumeFragment, /gl_FragDepth=depth/);
assert.match(cloudVolumeFragment, /resolvedCloudVolume\(gl_FragCoord.xy\/cloudOutputSize/);
const fastResolve = cloudVolumeFragment.match(
  /if\(cloudResolved&&cloudVolumeMix>=1\.\)\{([^}]+)\}/,
)[1];
assert.match(fastResolve, /atmosphereIntersection\(origin,ray,cloudTop\)/);
assert.match(fastResolve, /outputCloud\(result,depth\);return/);
assert.doesNotMatch(
  fastResolve,
  /cloudUv|cloudSegments|cloudCoverage|cloudVolumeRay|throughAtmosphere|dFdx|dFdy/,
);
assert.ok(
  cloudVolumeFragment.indexOf(fastResolve) <
    cloudVolumeFragment.indexOf('vec4 spans=cloudSegments(origin,ray)'),
);
assert.match(cloudVolumeFragment, /cloudCoverageGrad\(shellUv,shellDx,shellDy\)/);
assert.ok(
  cloudVolumeFragment.indexOf('dFdx(shellUv)') <
    cloudVolumeFragment.indexOf('if(cloudResolved&&cloudVolumeMix<1.)'),
);
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
  const parentTarget = { width: 2000, height: 1000 };
  const originalColor = new Color(0.1, 0.2, 0.3);
  let current = parentTarget;
  let color = originalColor.clone();
  let clearAlpha = 0.7;
  let throwOnPass = '';
  let renders = 0;
  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 2, 0.0001, 4);
  camera.position.set(1.1, 0, 0);
  camera.updateMatrixWorld();
  const inputs = [new Texture(), new Texture(), new Texture()];
  const appearance = createEarthAppearance(...inputs, 0, null, false);
  const material = appearance.clouds;
  const renderer = {
    autoClear: true,
    extensions: { has: () => hdr },
    domElement: { dataset: {} },
    getDrawingBufferSize: (v) => v.set(3840, 2160),
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
      assert.equal(object, scene);
      if (!material.uniforms.cloudResolved.value) {
        assert.equal(material.depthWrite, true);
        assert.notEqual(current, parentTarget);
        assert.equal(material.uniforms.cloudVolumeColor.value, null);
        assert.equal(material.uniforms.cloudVolumeDepth.value, null);
        if (throwOnPass === 'volume') throw new Error('injected draw failure');
      } else {
        assert.equal(current, parentTarget);
        assert.equal(material.depthWrite, false);
        assert.equal(material.blending, NormalBlending);
        assert.equal(material.depthTest, true);
        assert.deepEqual(material.uniforms.cloudOutputSize.value.toArray(), [2000, 1000]);
        if (material.uniforms.cloudVolumeMix.value > 0) {
          assert.equal(material.uniforms.cloudVolumeColor.value, pass.target.texture);
          assert.equal(material.uniforms.cloudVolumeDepth.value, pass.target.depthTexture);
        } else {
          assert.equal(material.uniforms.cloudVolumeColor.value, null);
          assert.equal(material.uniforms.cloudVolumeDepth.value, null);
        }
        if (throwOnPass === 'resolve') throw new Error('injected draw failure');
      }
    },
  };
  const pass = new CloudVolumePass(renderer);
  pass.resize();
  assert.deepEqual([pass.target.width, pass.target.height], cloudPassSize(3840, 2160));
  assert.equal(pass.target.samples, 0);
  assert.ok(pass.target.depthTexture);
  for (const weight of [0, 0.25, 1]) {
    material.uniforms.cloudVolumeMix.value = weight;
    renders = 0;
    pass.render(scene, camera, material);
    assert.equal(renders, weight ? 2 : 1);
    assert.equal(material.uniforms.cloudResolved.value, false);
    assert.equal(material.uniforms.cloudVolumeColor.value, null);
    assert.equal(material.uniforms.cloudVolumeDepth.value, null);
  }
  assert.equal(current, parentTarget);
  assert.equal(renderer.autoClear, true);
  assert.equal(clearAlpha, 0.7);
  assert.ok(color.equals(originalColor));
  for (const failingPass of ['volume', 'resolve']) {
    throwOnPass = failingPass;
    assert.throws(() => pass.render(scene, camera, material), /injected draw failure/);
    assert.equal(current, parentTarget);
    assert.equal(renderer.autoClear, true);
    assert.equal(material.depthWrite, false);
    assert.equal(material.uniforms.cloudResolved.value, false);
    assert.equal(material.uniforms.cloudVolumeColor.value, null);
    assert.equal(material.uniforms.cloudVolumeDepth.value, null);
    assert.equal(clearAlpha, 0.7);
    assert.ok(color.equals(originalColor));
  }
  let released = 0;
  pass.target.addEventListener('dispose', () => released++);
  pass.dispose();
  assert.equal(released, 1);
  appearance.dispose();
  inputs.forEach((texture) => texture.dispose());
}

// Evaluate the actual shader mix and compare against a weighted composite reference.
const blendExpression = cloudVolumeFragment.match(
  /result=(mix\(shell,volume,cloudVolumeMix\));/,
)[1];
const layerMix = new Function(
  'shell',
  'volume',
  'cloudVolumeMix',
  'mix',
  `return ${blendExpression};`,
);
const vectorMix = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
for (const shellAlpha of [0, 0.02, 0.5, 1]) {
  for (const volumeAlpha of [0, 0.1, 0.9, 1]) {
    for (const weight of [0, 1e-6, 0.2, 0.5, 0.9, 1 - 1e-6, 1]) {
      const shell = [0.8 * shellAlpha, 0.9 * shellAlpha, shellAlpha, shellAlpha];
      const volume = [0.2 * volumeAlpha, 0.3 * volumeAlpha, 0.4 * volumeAlpha, volumeAlpha];
      const combined = layerMix(shell, volume, weight, vectorMix);
      const background = [0.12, 0.18, 0.24];
      for (let channel = 0; channel < 3; channel++) {
        const actual = combined[channel] + (1 - combined[3]) * background[channel];
        const expected =
          (1 - weight) * (shell[channel] + (1 - shellAlpha) * background[channel]) +
          weight * (volume[channel] + (1 - volumeAlpha) * background[channel]);
        assert.ok(Math.abs(actual - expected) < 1e-14);
      }
      assert.ok(Math.abs(combined[3] - ((1 - weight) * shellAlpha + weight * volumeAlpha)) < 1e-14);
    }
  }
}
// Derivative helper invocations beyond the limb must approach the true tangent,
// not the intersection miss sentinel or camera origin. Valid ray endpoints stay exact.
const footprintDistance = scalar('cloudFootprintDistance', 'distance,closest,hit');
const shaderUv = new Function(
  'vec3',
  'vec2',
  'normalize',
  'atan',
  'asin',
  'clamp',
  `return p=>{${functionBody(cloudVolumeFragment, 'cloudUv').replace('vec3 n=', 'const n=')}}`,
)(
  (x, y, z) => ({ x, y, z }),
  vec2,
  (p) => {
    const length = Math.hypot(p.x, p.y, p.z);
    return { x: p.x / length, y: p.y / length, z: p.z / length };
  },
  Math.atan2,
  Math.asin,
  clamp,
);
const shaderDelta = new Function(
  'delta',
  'floor',
  functionBody(cloudVolumeFragment, 'cloudUvDelta'),
);
const chooseShellDistance = new Function(
  'shellHit',
  `return ${cloudVolumeFragment.match(/float shellDistance=([^;]+);/)[1]};`,
);
const shellVisibility = new Function(
  'shellDistance',
  'ground',
  `return ${cloudVolumeFragment.match(/if\((shellDistance>0\.&&\(ground\.x<=0\.\|\|shellDistance<ground\.x\))\)/)[1]};`,
);
const horizonCamera = new PerspectiveCamera(34, 2243 / 847, 0.1, 6);
horizonCamera.position.set(3, 0, 0);
horizonCamera.lookAt(0, 0, 0);
horizonCamera.updateMatrixWorld();
const shellRadius = 1 + 8 / radiusKm;
const tangentNdc =
  Math.tan(Math.asin(shellRadius / 3)) / (Math.tan((17 * Math.PI) / 180) * horizonCamera.aspect);
const horizonSample = (ndc) => {
  const ray = new Vector3(ndc, 0, 0.5)
    .unproject(horizonCamera)
    .sub(horizonCamera.position)
    .normalize();
  const hit = intersect(horizonCamera.position.toArray(), ray.toArray(), shellRadius);
  const distance = chooseShellDistance(hit);
  const valid = hit.y > 0;
  const extended = footprintDistance(
    Math.max(0, distance),
    -horizonCamera.position.dot(ray),
    valid,
  );
  if (valid)
    assert.equal(extended, distance, 'Hit samples must keep their original endpoint/depth');
  else
    assert.equal(
      shellVisibility(distance, intersect(horizonCamera.position.toArray(), ray.toArray(), 1)),
      false,
    );
  const oldPoint = horizonCamera.position.clone().addScaledVector(ray, Math.max(0, distance));
  const newPoint = horizonCamera.position.clone().addScaledVector(ray, extended);
  return { valid, oldUv: shaderUv(oldPoint), newUv: shaderUv(newPoint) };
};
const uvSpan = (a, b) => Math.hypot(...shaderDelta(vec2(b.x - a.x, b.y - a.y), Math.floor));
const left = horizonSample(tangentNdc - 1 / 2243);
const right = horizonSample(tangentNdc + 1 / 2243);
assert.equal(left.valid, true);
assert.equal(right.valid, false);
assert.ok(uvSpan(left.oldUv, right.oldUv) > 20 * uvSpan(left.newUv, right.newUv));
let previousSpan = 1;
for (const epsilon of [1e-3, 1e-5, 1e-7, 1e-9]) {
  const inside = horizonSample(tangentNdc - epsilon);
  const outside = horizonSample(tangentNdc + epsilon);
  const span = uvSpan(inside.newUv, outside.newUv);
  assert.ok(span < previousSpan);
  assert.ok(uvSpan(inside.oldUv, outside.oldUv) > 0.2);
  previousSpan = span;
}
assert.ok(previousSpan < 0.00002);
assert.equal(
  footprintDistance(0, 2.8, false),
  2.8,
  'An empty volume footprint extends to closest approach',
);
assert.equal(
  footprintDistance(0.0002, 2.8, true),
  0.0002,
  'Inside-layer positive footprint stays unchanged',
);
assert.equal(
  footprintDistance(0, -2, false),
  0,
  'Rays pointing away do not extend behind the camera',
);
assert.match(
  cloudVolumeFragment,
  /cloudFootprintDistance\(entryDistance,-dot\(origin,ray\),occupiedLength>0\.\)/,
);
assert.match(
  cloudVolumeFragment,
  /cloudFootprintDistance\(max\(0\.,shellDistance\),-dot\(origin,ray\),shellHit\.y>0\.\)/,
);
console.log(
  'Cloud volume checks passed: bounded shared noise, actual optical-depth/profile calibration, outside/inside/below/limb ray intervals, continuous shell fallback and material/resource contract. GPU appearance and frame timing remain separate.',
);
