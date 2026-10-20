// Off-screen render + pixel readback at an arbitrary target size (virtual camera).
//
// three.js only applies the output colour-space conversion when rendering to the canvas,
// so the scene is rendered into a (half-float, multisampled) linear render target and then
// resolved by a full-screen pass that converts linear -> sRGB and flips rows, into an
// 8-bit target whose readPixels output is already top-down RGBA.
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = vec2(uv.x, 1.0 - uv.y);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
void main() {
  vec4 s = texture2D(tSrc, vUv);
  gl_FragColor = vec4(toSRGB(s.rgb), clamp(s.a, 0.0, 1.0));
}`;

export class Readback {
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private outRT: THREE.WebGLRenderTarget | null = null;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private w = 0;
  private h = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.material = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  private ensure(w: number, h: number): void {
    if (this.sceneRT && this.outRT && this.w === w && this.h === h) return;
    this.sceneRT?.dispose();
    this.outRT?.dispose();
    const ext = this.renderer.extensions;
    const floatOk = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 4,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.outRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.w = w;
    this.h = h;
  }

  /** Renders `scene` with `camera` at w×h and returns RGBA, top-down rows. */
  read(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): Uint8Array {
    this.ensure(w, h);
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    const prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.autoClear = true;
    try {
      r.setRenderTarget(this.sceneRT);
      r.render(scene, camera);
      this.material.uniforms.tSrc.value = this.sceneRT!.texture;
      r.setRenderTarget(this.outRT);
      r.render(this.quadScene, this.quadCam);
      const out = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(this.outRT!, 0, 0, w, h, out);
      return out;
    } finally {
      this.material.uniforms.tSrc.value = null;
      r.setRenderTarget(prevTarget);
      r.autoClear = prevAutoClear;
      r.xr.enabled = prevXr;
    }
  }

  dispose(): void {
    this.sceneRT?.dispose();
    this.outRT?.dispose();
    this.sceneRT = this.outRT = null;
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
