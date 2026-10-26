import {
  Color,
  CustomBlending,
  DepthTexture,
  HalfFloatType,
  Matrix4,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import type { PerspectiveCamera, Scene, WebGLRenderer } from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

export function cloudPassSize(width: number, height: number) {
  const scale = Math.min(0.5, Math.sqrt(500_000 / (width * height)));
  return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))] as const;
}

/** Fixed spatial reduction; no history, jitter or frame-dependent quality changes. */
export class CloudVolumePass {
  private readonly target: WebGLRenderTarget;
  private readonly size = new Vector2();
  private readonly clearColor = new Color();
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor(private readonly renderer: WebGLRenderer) {
    this.target = new WebGLRenderTarget(1, 1, {
      type: renderer.extensions.has('EXT_color_buffer_float') ? HalfFloatType : UnsignedByteType,
      depthTexture: new DepthTexture(1, 1, UnsignedIntType),
      depthBuffer: true,
      stencilBuffer: false,
      samples: 0,
    });
    this.material = new ShaderMaterial({
      uniforms: {
        cloudColor: { value: this.target.texture },
        cloudDepth: { value: this.target.depthTexture },
        cloudTexel: { value: new Vector2(1, 1) },
        cloudProjectionInverse: { value: new Matrix4() },
        cloudCameraWorld: { value: new Matrix4() },
        cloudCameraPosition: { value: new Vector3() },
      },
      depthTest: true,
      depthWrite: false,
      transparent: true,
      blending: CustomBlending,
      blendSrc: OneFactor,
      blendDst: OneMinusSrcAlphaFactor,
      toneMapped: false,
      vertexShader: `varying vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`,
      fragmentShader: `
uniform sampler2D cloudColor;uniform sampler2D cloudDepth;uniform vec2 cloudTexel;
uniform mat4 cloudProjectionInverse;uniform mat4 cloudCameraWorld;uniform vec3 cloudCameraPosition;
varying vec2 vUv;
void main(){
 vec4 color=texture2D(cloudColor,vUv);if(color.a<.001)discard;
 vec3 axes=vec3(1.,.9966471893,1.);
 vec4 view=cloudProjectionInverse*vec4(vUv*2.-1.,1.,1.);
 vec3 ray=normalize((cloudCameraWorld*vec4(view.xyz/view.w,0.)).xyz/axes);
 vec3 origin=cloudCameraPosition/axes;
 float b=dot(origin,ray),top=1.+10./6378.137;
 float h=b*b-dot(origin,origin)+top*top;
 if(h<0.||-b+sqrt(max(0.,h))<=0.)discard;
 vec2 base=(floor(vUv/cloudTexel-.5)+.5)*cloudTexel;
 float depth=min(min(texture2D(cloudDepth,base).r,texture2D(cloudDepth,base+vec2(cloudTexel.x,0.)).r),
                 min(texture2D(cloudDepth,base+vec2(0.,cloudTexel.y)).r,texture2D(cloudDepth,base+cloudTexel).r));
 if(depth>=1.)discard;
 gl_FragDepth=depth;
 gl_FragColor=color;
}`,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  resize() {
    this.renderer.getDrawingBufferSize(this.size);
    const [width, height] = cloudPassSize(this.size.x, this.size.y);
    this.target.setSize(width, height);
    this.material.uniforms.cloudTexel.value.set(1 / width, 1 / height);
    this.renderer.domElement.dataset.cloudPassSize = `${width}x${height} / 1 sample`;
  }

  render(scene: Scene, camera: PerspectiveCamera, cloudMaterial: ShaderMaterial) {
    const previous = this.renderer.getRenderTarget();
    const autoClear = this.renderer.autoClear;
    const alpha = this.renderer.getClearAlpha();
    const depthWrite = cloudMaterial.depthWrite;
    this.renderer.getClearColor(this.clearColor);
    try {
      this.renderer.setRenderTarget(this.target);
      this.renderer.setClearColor(0, 0);
      this.renderer.autoClear = false;
      this.renderer.clear(true, true, false);
      // Normal blending into transparent black stores premultiplied linear radiance.
      cloudMaterial.depthWrite = true;
      this.renderer.render(scene, camera);
      cloudMaterial.depthWrite = depthWrite;
      this.renderer.setRenderTarget(previous);
      this.material.uniforms.cloudProjectionInverse.value.copy(camera.projectionMatrixInverse);
      this.material.uniforms.cloudCameraWorld.value.copy(camera.matrixWorld);
      this.material.uniforms.cloudCameraPosition.value.copy(camera.position);
      this.quad.render(this.renderer);
    } finally {
      cloudMaterial.depthWrite = depthWrite;
      this.renderer.setRenderTarget(previous);
      this.renderer.setClearColor(this.clearColor, alpha);
      this.renderer.autoClear = autoClear;
    }
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
