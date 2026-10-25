import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer } from 'three';

/** Compatibility renderer boundary. Numerical state never depends on this adapter. */
export function createRenderer() {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  return { renderer, label: 'WebGL 2' };
}
