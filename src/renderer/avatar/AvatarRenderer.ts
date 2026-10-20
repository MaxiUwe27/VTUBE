// Renders a VRM avatar with three.js and applies solved AvatarPoses.
// Used by the app window and by the OBS output page (output.html).
//
// Conventions: AvatarPose bone rotations are local rotations of three-vrm *normalized* bones in
// the VRM 1.0 convention (avatar faces +Z, its left is +X, up is +Y). For VRM 0.x models (which
// three-vrm keeps in their native −Z-facing frame and rotates the scene by 180°) the renderer
// converts automatically, so the solver never needs to know the model version.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils, type VRMHumanBoneName } from '@pixiv/three-vrm';
import type { AvatarPose, HumanBone, VrmInfo } from '../../shared/types';
import type { ViewSettings } from '../../shared/settings';
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/settings';
import { ExpressionMap, PERFECT_SYNC_MIN } from './expressions';
import { type BodyMetrics, defaultMetrics, frameCamera } from './framing';
import { buildRestPose, computeIdle, IDLE_BONES, toVrm0 } from './bodyPose';
import { Readback } from './readback';

export interface AvatarRendererOptions {
  /** Kept for API compatibility; the canvas is always created with an alpha channel. */
  transparentCapable?: boolean;
  /** Keep the drawing buffer (only needed if someone reads the canvas directly). */
  preserveDrawingBuffer?: boolean;
}

const TRACKED_BONES: readonly HumanBone[] = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'];

/** Internal light scales (three.js uses physical light units since r155). Tuned so the
 *  ViewSettings defaults (1.6 / 0.6) give natural MToon shading: directional ≈ 2.2, ambient ≈ 0.5. */
const LIGHT_SCALE = 2.2 / 1.6;
const AMBIENT_SCALE = 0.5 / 0.6;

/** Smoothing rate (1/s) for bone/gaze interpolation between tracking frames. */
const BONE_RATE = 28;
const MAX_DT = 1 / 20;

interface ManagedBone {
  name: VRMHumanBoneName;
  node: THREE.Object3D;
  tracked: boolean;
  current: THREE.Quaternion;   // smoothed tracked rotation (VRM1 convention)
  target: THREE.Quaternion;    // latest tracked target (VRM1 convention)
}

interface LoadedModel {
  vrm: VRM;
  info: VrmInfo;
  isVrm0: boolean;
  exprMap: ExpressionMap | null;
  exprWeights: Float32Array;
  perfectSyncNames: string[];
  bones: ManagedBone[];
  boneByName: Map<VRMHumanBoneName, ManagedBone>;
  hipsNode: THREE.Object3D | null;
  hipsRest: THREE.Vector3;
  hipsOffset: THREE.Vector3;       // smoothed (VRM1 convention)
  hipsOffsetTarget: THREE.Vector3;
  gazeTarget: { yaw: number; pitch: number };
  metrics: BodyMetrics;
  gotPose: boolean;
  needsSpringReset: number;        // frames until springBoneManager.reset()
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _box = new THREE.Box3();

function hasDocument(): boolean {
  return typeof document !== 'undefined';
}

export class AvatarRenderer {
  readonly canvas: HTMLCanvasElement;
  onFrame: ((dtSeconds: number) => void) | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
  private readonly vcamCamera = new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 100);
  private readonly dirLight = new THREE.DirectionalLight(0xffffff, Math.PI);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 1);
  private readonly loader: GLTFLoader;
  private readonly clock = new THREE.Clock(false);
  private readback: Readback | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private view: ViewSettings = structuredClone(DEFAULT_SETTINGS.view);
  private bgColor = new THREE.Color('#00ff00');
  private model: LoadedModel | null = null;
  private loadToken = 0;
  private pose: AvatarPose | null = null;
  private poseDirty = false;
  private restPose = buildRestPose(DEFAULT_SETTINGS.view.armPose);
  private readonly idle = new Map<VRMHumanBoneName, THREE.Quaternion>();
  private idleAmount = 1;
  private gaze = { yaw: 0, pitch: 0 };

  private running = false;
  private rafId = 0;
  private timerId: ReturnType<typeof setTimeout> | 0 = 0;
  private lastTickMs = 0;
  private lastRenderMs = 0;
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private _fps = 0;
  private elapsed = 0;
  private sizeDirty = true;
  private disposed = false;
  private contextLost = false;

  constructor(canvas: HTMLCanvasElement, opts: AvatarRendererOptions = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserveDrawingBuffer,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));

    this.loader = new GLTFLoader();
    this.loader.setCrossOrigin('anonymous');
    this.loader.register((parser) => new VRMLoaderPlugin(parser));

    // Key light from the front, upper left as seen by the viewer (avatar's right side).
    this.dirLight.position.set(-0.6, 1.6, 2.0);
    this.dirLight.target.position.set(0, 1.0, 0);
    this.scene.add(this.dirLight, this.dirLight.target, this.ambient);

    canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => { this.sizeDirty = true; });
      this.resizeObserver.observe(canvas);
    }
    if (hasDocument()) document.addEventListener('visibilitychange', this.onVisibility);

    this.setView(this.view);
  }

  // ---------------------------------------------------------------- public API

  get vrmInfo(): VrmInfo | null {
    return this.model ? { ...this.model.info, expressionNames: this.model.info.expressionNames.slice() } : null;
  }

  /** The loaded three-vrm instance (read-only use: debugging, advanced UI). */
  get vrm(): VRM | null {
    return this.model?.vrm ?? null;
  }

  /** ARKit names (canonical spelling) found on the current model. */
  get perfectSyncNames(): string[] {
    return this.model ? this.model.perfectSyncNames.slice() : [];
  }

  get fps(): number {
    return this._fps;
  }

  async loadVRM(source: ArrayBuffer | string): Promise<VrmInfo> {
    if (this.disposed) throw new Error('AvatarRenderer is disposed');
    if (typeof source !== 'string') {
      const head = new Uint8Array(source, 0, Math.min(4, source.byteLength));
      const magic = String.fromCharCode(...head);
      if (magic !== 'glTF') throw new Error('Not a VRM file (no glTF binary header).');
    }
    const token = ++this.loadToken;
    let gltf;
    try {
      gltf = typeof source === 'string'
        ? await this.loader.loadAsync(source)
        : await this.loader.parseAsync(source, '');
    } catch (err) {
      throw new Error(`Could not read VRM file: ${errMessage(err)}`);
    }
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      disposeObject(gltf.scene);
      throw new Error('The file is a glTF/GLB but not a VRM model (no VRM extension found).');
    }
    if (token !== this.loadToken || this.disposed) {
      // A newer load (or unload/dispose) superseded this one.
      disposeObject(vrm.scene);
      throw new Error('Load superseded');
    }

    try {
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
    } catch {
      /* optimisations only */
    }
    VRMUtils.rotateVRM0(vrm);
    vrm.scene.traverse((o) => { o.frustumCulled = false; });

    if (vrm.lookAt) {
      vrm.lookAt.autoUpdate = false;
      vrm.lookAt.target = null;
    }

    const model = this.buildModel(vrm);
    this.unloadVRM(false);
    this.model = model;
    this.scene.add(vrm.scene);
    this.gaze = { yaw: 0, pitch: 0 };

    // Bring the model into its rest pose once so measurements and spring bones start stable.
    this.applyBones(model, 0, true);
    vrm.humanoid.update();
    vrm.scene.updateMatrixWorld(true);
    model.metrics = this.measure(model);
    try { vrm.springBoneManager?.reset(); } catch { /* ignore */ }
    model.needsSpringReset = 2;
    this.updateCameras();
    if (this.pose) this.poseDirty = true;
    return this.vrmInfo!;
  }

  unloadVRM(bumpToken = true): void {
    if (bumpToken) this.loadToken++;
    const m = this.model;
    if (!m) return;
    this.model = null;
    this.scene.remove(m.vrm.scene);
    disposeObject(m.vrm.scene);
  }

  applyPose(pose: AvatarPose): void {
    if (!pose || typeof pose !== 'object') return;
    this.pose = pose;
    this.poseDirty = true;
  }

  setView(view: ViewSettings): void {
    const prevArm = this.view.armPose;
    // Tolerate partial/older view objects by filling gaps with defaults.
    this.view = structuredClone(mergeSettings(DEFAULT_SETTINGS.view, view ?? {}));
    const v = this.view;
    if (!this.restPose || prevArm !== v.armPose) this.restPose = buildRestPose(v.armPose);

    this.dirLight.color.set(safeColor(v.lightColor, '#ffffff'));
    this.dirLight.intensity = Math.max(0, v.lightIntensity) * LIGHT_SCALE;
    this.ambient.color.set(safeColor(v.lightColor, '#ffffff')).lerp(new THREE.Color(1, 1, 1), 0.5);
    this.ambient.intensity = Math.max(0, v.ambientIntensity) * AMBIENT_SCALE;

    this.bgColor.set(safeColor(v.background?.color, '#00ff00'));
    if (v.background?.mode === 'transparent') {
      this.renderer.setClearColor(this.bgColor, 0);
    } else {
      this.renderer.setClearColor(this.bgColor, 1);
    }
    this.scene.background = null;
    this.updateCameras();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastTickMs = 0;
    this.lastRenderMs = 0;
    this.fpsWindowStart = performance.now();
    this.fpsFrames = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timerId) clearTimeout(this.timerId);
    this.rafId = 0;
    this.timerId = 0;
    this._fps = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.unloadVRM();
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (hasDocument()) document.removeEventListener('visibilitychange', this.onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored, false);
    this.readback?.dispose();
    this.readback = null;
    this.renderer.dispose();
    this.onFrame = null;
  }

  /**
   * Renders the current state off-screen at width×height (independent of the window size)
   * and returns RGBA pixels, top-down rows. The background is always opaque (the configured
   * background colour, also in transparent mode) because the virtual camera has no alpha.
   * Returns a fresh buffer each call (safe to transfer). null if not possible.
   */
  readPixels(width: number, height: number): Uint8Array | null {
    if (this.disposed || this.contextLost) return null;
    const w = Math.floor(width);
    const h = Math.floor(height);
    if (!(w > 0 && h > 0 && w <= 8192 && h <= 8192)) return null;
    try {
      if (!this.readback) this.readback = new Readback(this.renderer);
      if (this.vcamCamera.aspect !== w / h) {
        this.vcamCamera.aspect = w / h;
        this.frameVcam();
      }
      const prevBg = this.scene.background;
      this.scene.background = this.bgColor;
      try {
        return this.readback.read(this.scene, this.vcamCamera, w, h);
      } finally {
        this.scene.background = prevBg;
      }
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- loop

  private schedule(): void {
    if (!this.running) return;
    const hidden = hasDocument() && document.visibilityState === 'hidden';
    if (hidden || typeof requestAnimationFrame === 'undefined') {
      // rAF may be paused for hidden windows; keep rendering for OBS / virtual camera.
      const interval = 1000 / Math.max(1, this.view.targetFps || 60);
      this.timerId = setTimeout(this.tick, Math.max(4, interval));
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (): void => {
    this.rafId = 0;
    this.timerId = 0;
    if (!this.running) return;
    const now = performance.now();
    const target = Math.max(1, this.view.targetFps || 60);
    const interval = 1000 / target;
    // Skip frames to honour the FPS limit (1 ms tolerance to avoid beating with vsync).
    if (this.lastRenderMs && now - this.lastRenderMs < interval - 1.0) {
      this.schedule();
      return;
    }
    const dt = this.lastRenderMs ? (now - this.lastRenderMs) / 1000 : 1 / target;
    // Keep cadence stable: advance by whole intervals rather than drifting.
    this.lastRenderMs = this.lastRenderMs && now - this.lastRenderMs < interval * 2
      ? this.lastRenderMs + interval * Math.floor((now - this.lastRenderMs) / interval)
      : now;

    try {
      this.renderFrame(dt);
    } catch (err) {
      reportOnce('render', err);
    }

    this.fpsFrames++;
    const span = now - this.fpsWindowStart;
    if (span >= 1000) {
      this._fps = (this.fpsFrames * 1000) / span;
      this.fpsFrames = 0;
      this.fpsWindowStart = now;
    }

    if (this.onFrame) {
      try {
        this.onFrame(dt);
      } catch (err) {
        reportOnce('onFrame', err);
      }
    }
    this.schedule();
  };

  /** Advances the avatar by dt (s) and renders one frame to the canvas. */
  private renderFrame(dtRaw: number): void {
    if (this.contextLost) return;
    const dt = Math.min(Math.max(dtRaw, 0), MAX_DT);
    this.elapsed += dt;
    if (this.sizeDirty) this.updateSize();

    const m = this.model;
    if (m) {
      // Idle fades in/out smoothly when toggled.
      const idleTarget = this.view.idleAnimation ? 1 : 0;
      this.idleAmount += (idleTarget - this.idleAmount) * (1 - Math.exp(-dt * 3));
      computeIdle(this.elapsed, this.idleAmount, this.idle);

      const snap = this.poseDirty && !m.gotPose;
      if (this.poseDirty && this.pose) {
        this.consumePose(m, this.pose);
        if (snap) m.gotPose = true;
      }
      this.poseDirty = false;
      this.applyBones(m, dt, snap);
      this.applyGaze(m, dt, snap);

      if (snap) m.needsSpringReset = Math.max(m.needsSpringReset, 1);
      if (m.needsSpringReset > 0) {
        m.vrm.humanoid.update();
        m.vrm.scene.updateMatrixWorld(true);
        try { m.vrm.springBoneManager?.reset(); } catch { /* ignore */ }
        m.needsSpringReset--;
      }
      m.vrm.update(dt);
    }
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- pose

  private consumePose(m: LoadedModel, pose: AvatarPose): void {
    // Expressions: every model expression gets the pose value or 0.
    if (m.exprMap && m.vrm.expressionManager) {
      const w = m.exprWeights;
      w.fill(0);
      const ex = pose.expressions;
      if (ex) {
        for (const key in ex) {
          const val = ex[key];
          if (typeof val !== 'number' || !(val > 0)) continue;
          const i = m.exprMap.indexOf(key);
          if (i >= 0 && val > w[i]) w[i] = Math.min(1, val);
        }
      }
      const names = m.exprMap.names;
      const mgr = m.vrm.expressionManager;
      for (let i = 0; i < names.length; i++) mgr.setValue(names[i], w[i]);
    }

    // Tracked bones.
    const bones = pose.bones || {};
    for (const b of TRACKED_BONES) {
      const mb = m.boneByName.get(b);
      if (!mb) continue;
      const q = bones[b];
      if (q && isFinite(q.x) && isFinite(q.y) && isFinite(q.z) && isFinite(q.w)) {
        mb.target.set(q.x, q.y, q.z, q.w);
        if (mb.target.lengthSq() < 1e-8) mb.target.identity();
        else mb.target.normalize();
      } else {
        mb.target.identity();
      }
    }

    const o = pose.hipsOffset;
    m.hipsOffsetTarget.set(
      o && isFinite(o.x) ? o.x : 0,
      o && isFinite(o.y) ? o.y : 0,
      o && isFinite(o.z) ? o.z : 0,
    );

    if (pose.lookAt && isFinite(pose.lookAt.yaw) && isFinite(pose.lookAt.pitch)) {
      m.gazeTarget.yaw = THREE.MathUtils.clamp(pose.lookAt.yaw, -90, 90);
      m.gazeTarget.pitch = THREE.MathUtils.clamp(pose.lookAt.pitch, -90, 90);
    } else {
      m.gazeTarget.yaw = 0;
      m.gazeTarget.pitch = 0;
    }
  }

  private applyBones(m: LoadedModel, dt: number, snap: boolean): void {
    const alpha = snap ? 1 : 1 - Math.exp(-dt * BONE_RATE);
    for (const mb of m.bones) {
      if (mb.tracked) {
        if (alpha >= 1) mb.current.copy(mb.target);
        else mb.current.slerp(mb.target, alpha);
        _q.copy(mb.current);
      } else {
        _q.identity();
      }
      const rest = this.restPose.get(mb.name);
      const idle = this.idle.get(mb.name);
      if (mb.tracked || !rest) {
        // Tracked (or unposed) bones: idle is a local offset on top of the tracking.
        if (rest) _q.multiply(rest);
        if (idle) _q.multiply(idle);
      } else {
        // Limbs: idle swing happens in the parent frame (premultiply), then the rest pose.
        if (idle) _q.copy(idle).multiply(rest);
        else _q.copy(rest);
      }
      if (m.isVrm0) toVrm0(_q);
      mb.node.quaternion.copy(_q);
    }

    if (m.hipsNode) {
      if (alpha >= 1) m.hipsOffset.copy(m.hipsOffsetTarget);
      else m.hipsOffset.lerp(m.hipsOffsetTarget, alpha);
      _v.copy(m.hipsOffset);
      if (m.isVrm0) { _v.x = -_v.x; _v.z = -_v.z; }
      m.hipsNode.position.copy(m.hipsRest).add(_v);
    }
  }

  private applyGaze(m: LoadedModel, dt: number, snap: boolean): void {
    const la = m.vrm.lookAt;
    if (!la) return;
    const alpha = snap ? 1 : 1 - Math.exp(-dt * BONE_RATE * 1.5);
    this.gaze.yaw += (m.gazeTarget.yaw - this.gaze.yaw) * alpha;
    this.gaze.pitch += (m.gazeTarget.pitch - this.gaze.pitch) * alpha;
    // VRMLookAt: yaw > 0 = looks to its own left (same as AvatarPose), but pitch > 0 = DOWN
    // (see three-vrm VRMLookAtExpressionApplier: pitch < 0 -> "lookUp"), so negate.
    la.yaw = this.gaze.yaw;
    la.pitch = -this.gaze.pitch;
  }

  // ---------------------------------------------------------------- model setup

  private buildModel(vrm: VRM): LoadedModel {
    const meta = vrm.meta as { metaVersion?: string; name?: string; title?: string } | undefined;
    const isVrm0 = meta?.metaVersion === '0';
    const name = ((isVrm0 ? meta?.title : meta?.name) || meta?.name || meta?.title || 'VRM Model').trim();

    const mgr = vrm.expressionManager;
    const exprNames = mgr ? mgr.expressions.map((e) => e.expressionName) : [];
    const exprMap = mgr ? new ExpressionMap(exprNames) : null;
    const perfectSyncNames = exprMap ? exprMap.matchArkit() : [];

    const bones: ManagedBone[] = [];
    const boneByName = new Map<VRMHumanBoneName, ManagedBone>();
    const names = new Set<VRMHumanBoneName>([
      ...(TRACKED_BONES as VRMHumanBoneName[]),
      ...this.restPoseBoneNames(),
      ...IDLE_BONES,
    ]);
    for (const n of names) {
      const node = vrm.humanoid.getNormalizedBoneNode(n);
      if (!node) continue;
      const mb: ManagedBone = {
        name: n,
        node,
        tracked: (TRACKED_BONES as readonly string[]).includes(n),
        current: new THREE.Quaternion(),
        target: new THREE.Quaternion(),
      };
      bones.push(mb);
      boneByName.set(n, mb);
    }
    const hipsNode = vrm.humanoid.getNormalizedBoneNode('hips');

    return {
      vrm,
      info: {
        name,
        version: isVrm0 ? '0' : '1',
        expressionNames: exprNames,
        hasPerfectSync: perfectSyncNames.length >= PERFECT_SYNC_MIN,
        hasLookAt: !!vrm.lookAt,
      },
      isVrm0,
      exprMap,
      exprWeights: new Float32Array(exprNames.length),
      perfectSyncNames,
      bones,
      boneByName,
      hipsNode,
      hipsRest: hipsNode ? hipsNode.position.clone() : new THREE.Vector3(),
      hipsOffset: new THREE.Vector3(),
      hipsOffsetTarget: new THREE.Vector3(),
      gazeTarget: { yaw: 0, pitch: 0 },
      metrics: defaultMetrics(),
      gotPose: false,
      needsSpringReset: 0,
    };
  }

  private restPoseBoneNames(): VRMHumanBoneName[] {
    // All bones the rest pose may touch, independent of the current armPose value.
    return [...buildRestPose(70).keys()];
  }

  /** Measures the avatar in its rest pose (scene space; avatar faces +Z). */
  private measure(m: LoadedModel): BodyMetrics {
    const h = m.vrm.humanoid;
    const met = defaultMetrics();
    const pos = (n: VRMHumanBoneName, out: THREE.Vector3): THREE.Vector3 | null => {
      const node = h.getNormalizedBoneNode(n);
      return node ? node.getWorldPosition(out) : null;
    };
    const head = pos('head', new THREE.Vector3());
    if (!head) return met;
    met.head.copy(head);
    const neck = pos('neck', _v);
    met.neckY = neck ? neck.y : head.y - 0.08;
    const hips = pos('hips', _v);
    met.hipsY = hips ? hips.y : head.y * 0.6;
    const chest = pos('upperChest', _v) || pos('chest', _v) || pos('spine', _v);
    met.chestY = chest ? chest.y : (met.hipsY + met.neckY) / 2;
    const la = pos('leftUpperArm', _v);
    const ra = la ? pos('rightUpperArm', _v2) : null;
    if (la && ra) met.shoulderWidth = la.distanceTo(ra);
    else met.shoulderWidth = Math.max(0.2, (head.y - met.hipsY) * 0.55);

    const le = pos('leftEye', _v);
    met.eyeY = le ? le.y : head.y + 0.07;

    // Bounding box of the skinned meshes in the current (rest) pose.
    let top = -Infinity;
    let bottom = Infinity;
    try {
      m.vrm.scene.traverse((o) => {
        const sm = o as THREE.SkinnedMesh;
        if (sm.isSkinnedMesh && sm.skeleton) sm.skeleton.update();
      });
      _box.makeEmpty();
      m.vrm.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.visible) return;
        const sm = o as THREE.SkinnedMesh;
        if (sm.isSkinnedMesh) {
          sm.computeBoundingBox();
          _box.union(sm.boundingBox!.clone().applyMatrix4(sm.matrixWorld));
        } else if (mesh.geometry) {
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          _box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
        }
      });
      if (!_box.isEmpty()) {
        top = _box.max.y;
        bottom = _box.min.y;
      }
    } catch {
      /* fall back to estimates */
    }
    const headUnit = Math.max(0.05, head.y - met.neckY); // neck length ≈ ⅓–½ head height
    const minTop = Math.max(met.eyeY, head.y) + headUnit * 0.9;
    const maxTop = head.y + Math.max(0.45, headUnit * 5);
    met.headTopY = isFinite(top) ? THREE.MathUtils.clamp(top, minTop, maxTop) : head.y + 0.22;
    const footL = pos('leftFoot', _v);
    const footY = footL ? Math.min(footL.y - 0.08, 0) : 0;
    met.feetY = isFinite(bottom) ? Math.min(Math.max(bottom, footY - 0.2), footY + 0.2) : footY;
    if (!isFinite(met.feetY)) met.feetY = 0;
    return met;
  }

  // ---------------------------------------------------------------- camera / size

  private updateSize(): void {
    this.sizeDirty = false;
    const c = this.canvas;
    const w = Math.max(1, Math.round(c.clientWidth || c.width || 1));
    const h = Math.max(1, Math.round(c.clientHeight || c.height || 1));
    const pr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (this.renderer.getPixelRatio() !== pr) this.renderer.setPixelRatio(pr);
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.updateCameras();
  }

  private updateCameras(): void {
    const metrics = this.model?.metrics ?? defaultMetrics();
    frameCamera(this.camera, metrics, this.view);
    this.frameVcam();
  }

  private frameVcam(): void {
    frameCamera(this.vcamCamera, this.model?.metrics ?? defaultMetrics(), this.view);
  }

  // ---------------------------------------------------------------- events

  private readonly onVisibility = (): void => {
    if (!this.running) return;
    // Switch between rAF and timer scheduling.
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timerId) clearTimeout(this.timerId);
    this.rafId = 0;
    this.timerId = 0;
    this.schedule();
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.sizeDirty = true;
    this.readback?.dispose();
    this.readback = null;
  };
}

// ------------------------------------------------------------------ helpers

function disposeObject(obj: THREE.Object3D): void {
  try {
    VRMUtils.deepDispose(obj);
  } catch {
    /* ignore */
  }
}

function safeColor(c: string | undefined, fallback: string): string {
  if (typeof c === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim())) return c.trim();
  return fallback;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

const reported = new Set<string>();
function reportOnce(where: string, err: unknown): void {
  const key = `${where}:${errMessage(err)}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[AvatarRenderer] ${where} failed:`, err);
}
