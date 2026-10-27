import { HalfFloatType, UnsignedByteType, Vector2, WebGLRenderTarget } from 'three';
import type { WebGLRenderer } from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export function earthCompositeSize(width: number, height: number) {
  const scale = Math.min(1, Math.sqrt(4_000_000 / (width * height)));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))] as const;
}

/** Blend Earth radiance in linear light, then apply the display transform once. */
export class EarthComposite {
  private readonly target: WebGLRenderTarget;
  private readonly output = new OutputPass();
  private readonly size = new Vector2();

  constructor(private readonly renderer: WebGLRenderer) {
    const hdr = renderer.extensions.has('EXT_color_buffer_float');
    this.target = new WebGLRenderTarget(1, 1, {
      type: hdr ? HalfFloatType : UnsignedByteType,
      samples: Math.min(2, renderer.capabilities.maxSamples),
      depthBuffer: true,
      stencilBuffer: false,
      resolveDepthBuffer: false,
    });
    renderer.domElement.dataset.earthComposition = hdr
      ? 'linear HDR / single output'
      : 'linear LDR / single output';
  }

  resize() {
    this.renderer.getDrawingBufferSize(this.size);
    const [width, height] = earthCompositeSize(this.size.x, this.size.y);
    this.target.setSize(width, height);
    this.renderer.domElement.dataset.earthCompositeSize = `${width}x${height} / ${this.target.samples} samples`;
  }

  render(draw: () => void) {
    const previous = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(this.target);
      draw();
      this.output.renderToScreen = previous === null;
      this.output.render(this.renderer, previous || this.target, this.target, 0, false);
    } finally {
      this.renderer.setRenderTarget(previous);
    }
  }

  dispose() {
    this.target.dispose();
    this.output.dispose();
  }
}
