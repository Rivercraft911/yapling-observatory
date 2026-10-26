import {
  Color,
  DepthTexture,
  HalfFloatType,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  WebGLRenderTarget,
} from 'three';
import type { PerspectiveCamera, Scene, ShaderMaterial, WebGLRenderer } from 'three';

export function cloudPassSize(width: number, height: number) {
  const scale = Math.min(0.5, Math.sqrt(500_000 / (width * height)));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))] as const;
}

/** Bound the volume march; resolve source-matched distant clouds at scene resolution. */
export class CloudVolumePass {
  private readonly target: WebGLRenderTarget;
  private readonly size = new Vector2();
  private readonly clearColor = new Color();

  constructor(private readonly renderer: WebGLRenderer) {
    this.target = new WebGLRenderTarget(1, 1, {
      type: renderer.extensions.has('EXT_color_buffer_float') ? HalfFloatType : UnsignedByteType,
      depthTexture: new DepthTexture(1, 1, UnsignedIntType),
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
  }

  resize() {
    this.renderer.getDrawingBufferSize(this.size);
    const [width, height] = cloudPassSize(this.size.x, this.size.y);
    this.target.setSize(width, height);
    this.renderer.domElement.dataset.cloudPassSize = `${width}x${height} / volume only`;
  }

  render(scene: Scene, camera: PerspectiveCamera, cloudMaterial: ShaderMaterial) {
    const previous = this.renderer.getRenderTarget();
    const autoClear = this.renderer.autoClear;
    const alpha = this.renderer.getClearAlpha();
    const depthWrite = cloudMaterial.depthWrite;
    const uniforms = cloudMaterial.uniforms;
    const resolved = uniforms.cloudResolved.value;
    const volumeColor = uniforms.cloudVolumeColor.value;
    const volumeDepth = uniforms.cloudVolumeDepth.value;
    this.renderer.getClearColor(this.clearColor);
    try {
      this.renderer.autoClear = false;
      // Clear all feedback bindings, including samplers behind uniform branches.
      uniforms.cloudResolved.value = false;
      uniforms.cloudVolumeColor.value = null;
      uniforms.cloudVolumeDepth.value = null;
      if (uniforms.cloudVolumeMix.value > 0) {
        this.renderer.setRenderTarget(this.target);
        this.renderer.setClearColor(0, 0);
        this.renderer.clear(true, true, false);
        cloudMaterial.depthWrite = true;
        this.renderer.render(scene, camera);
        uniforms.cloudVolumeColor.value = this.target.texture;
        uniforms.cloudVolumeDepth.value = this.target.depthTexture;
      }
      cloudMaterial.depthWrite = depthWrite;
      this.renderer.setRenderTarget(previous);
      uniforms.cloudResolved.value = true;
      uniforms.cloudVolumeTexel.value.set(1 / this.target.width, 1 / this.target.height);
      if (previous) uniforms.cloudOutputSize.value.set(previous.width, previous.height);
      else this.renderer.getDrawingBufferSize(uniforms.cloudOutputSize.value);
      // One full-resolution blend combines shell and already-premultiplied volume.
      this.renderer.render(scene, camera);
    } finally {
      cloudMaterial.depthWrite = depthWrite;
      uniforms.cloudResolved.value = resolved;
      uniforms.cloudVolumeColor.value = volumeColor;
      uniforms.cloudVolumeDepth.value = volumeDepth;
      this.renderer.setRenderTarget(previous);
      this.renderer.setClearColor(this.clearColor, alpha);
      this.renderer.autoClear = autoClear;
    }
  }

  dispose() {
    this.target.dispose();
  }
}
