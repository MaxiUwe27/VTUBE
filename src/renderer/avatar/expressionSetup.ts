// Expression setup after loading a VRM: repairs what three-vrm's importer drops, maps the expression
// names the solver emits onto models that name them differently (or never set them up), trims huge
// morph-target sets, and produces a diagnostics report for the UI ("Modell → Ausdrücke (Diagnose)").
//
// Why: many real-world models (VRChat → VRM conversions, UniVRM default clips) work in VSeeFace but
// not with a plain three-vrm load:
//  - three-vrm drops a whole bind if ONE primitive of the bound mesh lacks that morph target
//    (meshes split into primitives per material, some without targets) → expression silently empty.
//  - VRM0 presetName is matched case-sensitively ("Blink_L", "Joy" → treated as custom names).
//  - Duplicate clip names: three-vrm keeps the first (often an empty default clip) and ignores the rest.
//  - Clips exist but have no binds (UniVRM creates them empty) while the mesh has usable morphs
//    (vrc.blink, vrc.v_aa, Fcl_EYE_Close, まばたき, ARKit names …).
//  - VRM0 bind weights written as 0..1 instead of 0..100 (expression moves ~1 %).
//  - Faces with hundreds of morph targets: three.js uploads ALL of them into one float texture per
//    geometry (vertices × targets); that can exceed GPU limits/memory and then fails silently (the mesh
//    renders, morphs do nothing). Unused targets are removed.
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRMExpression, VRMExpressionLoaderPlugin, VRMExpressionMaterialColorBind, VRMExpressionMorphTargetBind,
  VRMExpressionTextureTransformBind, type VRM, type VRMExpressionBind,
} from '@pixiv/three-vrm';
import { ARKIT_BLENDSHAPES, PERFECT_SYNC_MIN } from './expressions';

export type ExpressionKind = 'preset' | 'custom' | 'mapped';

export interface ExpressionReportEntry {
  /** Name in the expression manager (what AvatarPose names are matched against). */
  name: string;
  kind: ExpressionKind;
  /** For kind 'mapped': where the binds come from (morph names or the model expression). */
  source?: string;
  morphBinds: number;
  materialBinds: number;
  uvBinds: number;
  /** Has at least one bind that can visibly change something (morph with data, material, UV). */
  effective: boolean;
  isBinary: boolean;
  /** Reparatur, die beim Laden an diesem Ausdruck vorgenommen wurde (deutsch). */
  note?: string;
  /** An empty model expression that a mapped one of the same name replaced. */
  replaced?: boolean;
}

export interface MeshMorphList { mesh: string; primitives: number; names: string[] }

/** Expression definitions as stored in the file (VRM0 blendShapeGroups / VRM1 expressions). */
export interface SourceClip { name: string; preset: string; morphBinds: number; materialBinds: number; isBinary: boolean }

export interface ExpressionReport {
  entries: ExpressionReportEntry[];
  morphs: MeshMorphList[];
  /** Reparaturen beim Laden (deutsch, für UI und Diagnose). */
  repairs: string[];
  mapped: { name: string; source: string }[];
  /** Model expressions (as loaded) without any effect. */
  empty: string[];
  /** Registered expression names that have an effect. */
  usable: string[];
  /** ARKit names (canonical) that are usable on the model. */
  perfectSyncNames: string[];
  /** Raw expression definitions from the file (for the support dump). */
  sourceClips: SourceClip[];
  /** Estimated GPU morph-texture size (MB) before/after removing unused morph targets. */
  morphTextureMB: { before: number; after: number; removedTargets: number };
}

export interface ExpressionSetupOptions {
  /** gl.MAX_ARRAY_TEXTURE_LAYERS (three.js puts one morph target per layer). */
  maxArrayLayers?: number;
}

const PRESETS = new Set(['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'happy', 'angry', 'sad',
  'relaxed', 'surprised', 'neutral', 'lookUp', 'lookDown', 'lookLeft', 'lookRight']);

/** Expressions the solver emits (VRM1 presets), in mapping order. */
export const SOLVER_PRESETS = ['blink', 'blinkLeft', 'blinkRight', 'aa', 'ih', 'ou', 'ee', 'oh',
  'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;

/** Alternative names per solver preset, in priority order (matched case-insensitively, ignoring
 *  spaces . _ -, also after prefixes like "Face.", "blendShape1.", "A_", "PS_"). */
const PRESET_ALIASES: Record<string, string[]> = {
  blink: ['blink', 'blink_both', 'blinks', 'vrc.blink', 'Fcl_EYE_Close', 'eye_close', 'eyes_close', 'eye_closed',
    'eyes_closed', 'close_eyes', 'close_eye', 'eyeclose_both', 'まばたき', '目閉じ', 'eyeBlink'],
  blinkLeft: ['blinkLeft', 'blink_l', 'blink_left', 'left_blink', 'vrc.blink_left', 'Fcl_EYE_Close_L', 'eye_close_l',
    'eye_close_left', 'eyes_closed_l', 'eyeBlinkLeft', 'eyeBlink_L', 'eye_blink_left', 'eye_left_blink', 'EyeClosedLeft',
    'wink_l', 'wink_left', 'winkLeft', 'ウィンク', 'ウィンク２', 'wink'],
  blinkRight: ['blinkRight', 'blink_r', 'blink_right', 'right_blink', 'vrc.blink_right', 'Fcl_EYE_Close_R', 'eye_close_r',
    'eye_close_right', 'eyes_closed_r', 'eyeBlinkRight', 'eyeBlink_R', 'eye_blink_right', 'eye_right_blink', 'EyeClosedRight',
    'wink_r', 'wink_right', 'winkRight', 'ウィンク右', 'ウィンク２右'],
  aa: ['aa', 'a', 'vrc.v_aa', 'v_aa', 'viseme_aa', 'viseme_a', 'Fcl_MTH_A', 'mth_a', 'mouth_a', 'lip_a', 'vowel_a', 'ah', 'あ'],
  ih: ['ih', 'i', 'vrc.v_ih', 'v_ih', 'viseme_ih', 'viseme_i', 'Fcl_MTH_I', 'mth_i', 'mouth_i', 'lip_i', 'vowel_i', 'い'],
  ou: ['ou', 'u', 'vrc.v_ou', 'v_ou', 'viseme_ou', 'viseme_u', 'Fcl_MTH_U', 'mth_u', 'mouth_u', 'lip_u', 'vowel_u', 'う'],
  ee: ['ee', 'e', 'vrc.v_e', 'vrc.v_ee', 'v_e', 'v_ee', 'viseme_e', 'viseme_ee', 'Fcl_MTH_E', 'mth_e', 'mouth_e', 'lip_e', 'vowel_e', 'え'],
  oh: ['oh', 'o', 'vrc.v_oh', 'v_oh', 'viseme_oh', 'viseme_o', 'Fcl_MTH_O', 'mth_o', 'mouth_o', 'lip_o', 'vowel_o', 'お'],
  happy: ['happy', 'joy', 'Fcl_ALL_Joy', 'smile', 'laugh', 'happiness', 'emotion_happy', 'face_happy', 'face_joy', 'face_smile', '笑い', '喜び'],
  angry: ['angry', 'anger', 'mad', 'Fcl_ALL_Angry', 'emotion_angry', 'face_angry', '怒り'],
  sad: ['sad', 'sorrow', 'Fcl_ALL_Sorrow', 'sadness', 'cry', 'emotion_sad', 'face_sad', 'face_sorrow', '困る', '悲しい', '悲しみ'],
  relaxed: ['relaxed', 'fun', 'relax', 'calm', 'Fcl_ALL_Fun', 'emotion_relaxed', 'face_fun', 'face_relaxed', 'face_relax', 'にこり'],
  surprised: ['surprised', 'surprise', 'shock', 'shocked', 'Fcl_ALL_Surprised', 'emotion_surprised', 'face_surprised', 'face_surprise', 'びっくり', '驚き'],
};

/** Extra names for single ARKit shapes (VRChat face tracking / SRanipal / Unified Expressions). */
const ARKIT_EXTRA: Record<string, string[]> = {
  eyeBlinkLeft: ['Eye_Left_Blink', 'EyeClosedLeft', 'vrc.blink_left'],
  eyeBlinkRight: ['Eye_Right_Blink', 'EyeClosedRight', 'vrc.blink_right'],
  eyeWideLeft: ['Eye_Left_Wide', 'EyeWideLeft'],
  eyeWideRight: ['Eye_Right_Wide', 'EyeWideRight'],
  eyeSquintLeft: ['Eye_Left_Squeeze', 'EyeSquintLeft', 'vrc.lowerlid_left'],
  eyeSquintRight: ['Eye_Right_Squeeze', 'EyeSquintRight', 'vrc.lowerlid_right'],
  jawOpen: ['Jaw_Open', 'MouthOpen'],
  jawLeft: ['Jaw_Left'],
  jawRight: ['Jaw_Right'],
  jawForward: ['Jaw_Forward'],
  mouthPucker: ['Mouth_Pout'],
  mouthSmileLeft: ['Mouth_Smile_Left', 'MouthCornerPullLeft'],
  mouthSmileRight: ['Mouth_Smile_Right', 'MouthCornerPullRight'],
  mouthFrownLeft: ['Mouth_Sad_Left'],
  mouthFrownRight: ['Mouth_Sad_Right'],
  cheekPuff: ['Cheek_Puff_Left'],
  tongueOut: ['Tongue_LongStep1', 'TongueOut'],
};

/** Last resort for the presets on models that only have ARKit-style shapes: [arkit name, weight]. */
const ARKIT_COMPOSITES: Record<string, [string, number][]> = {
  aa: [['jawOpen', 1]],
  ih: [['jawOpen', 0.25], ['mouthStretchLeft', 0.5], ['mouthStretchRight', 0.5]],
  ou: [['mouthPucker', 1], ['jawOpen', 0.15]],
  ee: [['jawOpen', 0.3], ['mouthStretchLeft', 0.6], ['mouthStretchRight', 0.6]],
  oh: [['mouthFunnel', 1], ['jawOpen', 0.6]],
  happy: [['mouthSmileLeft', 1], ['mouthSmileRight', 1], ['cheekSquintLeft', 0.5], ['cheekSquintRight', 0.5]],
  angry: [['browDownLeft', 1], ['browDownRight', 1], ['noseSneerLeft', 0.4], ['noseSneerRight', 0.4]],
  sad: [['mouthFrownLeft', 1], ['mouthFrownRight', 1], ['browInnerUp', 1]],
  relaxed: [['mouthSmileLeft', 0.5], ['mouthSmileRight', 0.5], ['eyeSquintLeft', 0.3], ['eyeSquintRight', 0.3]],
  surprised: [['browInnerUp', 1], ['eyeWideLeft', 1], ['eyeWideRight', 1], ['jawOpen', 0.3]],
};

const PREFIX_RE = /^(?:a|ps|arkit|bs|blendshape\d*|blend_shape\d*|shape|shapes|morph|face|head|body)[_.:|](.+)$/i;

/** Lower case without spaces / . _ - */
export function normName(s: string): string {
  return s.toLowerCase().replace(/[\s._\-]+/g, '');
}

/** All lookup keys of a model-side name (full, after the last ".", from "Fcl_", without known prefix). */
export function nameKeys(name: string): string[] {
  const s = name.trim();
  const keys = new Set<string>([normName(s)]);
  const dot = s.lastIndexOf('.');
  if (dot >= 0 && dot < s.length - 1) keys.add(normName(s.slice(dot + 1)));
  const fcl = s.search(/fcl_/i);
  if (fcl > 0) keys.add(normName(s.slice(fcl)));
  const m = PREFIX_RE.exec(s);
  if (m) keys.add(normName(m[1]));
  keys.delete('');
  return [...keys];
}

function arkitAliases(n: string): string[] {
  const out = [n];
  const lr = n.replace(/Left$/, '_L').replace(/Right$/, '_R');
  if (lr !== n) out.push(lr);
  out.push(...(ARKIT_EXTRA[n] ?? []));
  return out;
}

// --------------------------------------------------------------------------------------------- helpers

interface GltfJson {
  meshes?: { name?: string; extras?: { targetNames?: unknown }; primitives?: { extras?: { targetNames?: unknown } }[] }[];
  nodes?: { mesh?: number }[];
  extensions?: {
    VRM?: { blendShapeMaster?: { blendShapeGroups?: V0Group[] } };
    VRMC_vrm?: { expressions?: { preset?: Record<string, V1Expr>; custom?: Record<string, V1Expr> } };
  };
}
interface V0Group {
  name?: string; presetName?: string; isBinary?: boolean;
  binds?: { mesh?: number; index?: number; weight?: number }[]; materialValues?: unknown[];
}
interface V1Expr {
  isBinary?: boolean; morphTargetBinds?: { node?: number; index?: number; weight?: number }[];
  materialColorBinds?: unknown[]; textureTransformBinds?: unknown[];
}
interface Assoc { meshes?: number; primitives?: number; nodes?: number }

const isMorphBind = (b: VRMExpressionBind): b is VRMExpressionMorphTargetBind => b instanceof VRMExpressionMorphTargetBind;
const morphCount = (m: THREE.Mesh) => (Array.isArray(m.morphTargetInfluences) ? m.morphTargetInfluences.length : 0);

/** Does the morph target `index` of this primitive exist with non-zero position data? */
const dataCache = new WeakMap<object, boolean>();
export function morphHasData(mesh: THREE.Mesh, index: number): boolean {
  if (index >= morphCount(mesh)) return false;
  const attr = mesh.geometry?.morphAttributes?.position?.[index] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  if (!attr) return false; // e.g. removed by removeUnnecessaryVertices because all deltas are zero
  const cached = dataCache.get(attr);
  if (cached !== undefined) return cached;
  let has = false;
  for (let i = 0, n = attr.count; i < n && !has; i++) {
    if (Math.abs(attr.getX(i)) > 1e-7 || Math.abs(attr.getY(i)) > 1e-7 || Math.abs(attr.getZ(i)) > 1e-7) has = true;
  }
  dataCache.set(attr, has);
  return has;
}

function bindEffective(b: VRMExpressionBind): boolean {
  if (isMorphBind(b)) return b.weight !== 0 && b.primitives.some((p) => morphHasData(p, b.index));
  return b instanceof VRMExpressionMaterialColorBind || b instanceof VRMExpressionTextureTransformBind;
}
export function expressionEffective(e: VRMExpression): boolean {
  return e.binds.some(bindEffective);
}

function countBinds(e: VRMExpression): { morph: number; material: number; uv: number } {
  let morph = 0, material = 0, uv = 0;
  for (const b of e.binds) {
    if (isMorphBind(b)) morph++;
    else if (b instanceof VRMExpressionMaterialColorBind) material++;
    else if (b instanceof VRMExpressionTextureTransformBind) uv++;
  }
  return { morph, material, uv };
}

/** Estimated size of three.js' morph texture for a geometry (bytes). */
function morphTextureBytes(g: THREE.BufferGeometry): number {
  const ma = g.morphAttributes;
  const n = (ma.position ?? ma.normal ?? ma.color)?.length ?? 0;
  if (!n || !g.attributes.position) return 0;
  const per = ma.color ? 3 : ma.normal ? 2 : 1;
  return g.attributes.position.count * per * 16 * n; // RGBA32F texels
}

// --------------------------------------------------------------------------------------------- main

/**
 * Must run after the VRMUtils optimisations and after three-vrm's (non-awaited) bind promises have
 * settled (await one macrotask after loading).
 */
export function setupExpressions(vrm: VRM, gltf: GLTF, opts: ExpressionSetupOptions = {}): ExpressionReport {
  const json = (gltf.parser?.json ?? {}) as GltfJson;
  const assocMap = (gltf.parser?.associations ?? new Map()) as Map<object, Assoc>;
  const mgr = vrm.expressionManager;
  const repairs: string[] = [];
  const notes = new Map<VRMExpression, string[]>();
  const note = (e: VRMExpression, s: string) => { const l = notes.get(e) ?? []; l.push(s); notes.set(e, l); };

  // ---- scene inventory: primitives per glTF mesh / node, morph names
  const meshPrims = new Map<number, THREE.Mesh[]>();
  const nodeObjs = new Map<number, THREE.Object3D>();
  const allMeshes: THREE.Mesh[] = [];
  vrm.scene.traverse((o) => {
    const a = assocMap.get(o);
    if (a?.nodes !== undefined && !nodeObjs.has(a.nodes)) nodeObjs.set(a.nodes, o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    allMeshes.push(mesh);
    if (a?.meshes !== undefined && a.primitives !== undefined) {
      const l = meshPrims.get(a.meshes) ?? [];
      l.push(mesh);
      meshPrims.set(a.meshes, l);
    }
  });

  const morphNames = (mesh: THREE.Mesh): string[] => {
    const n = morphCount(mesh);
    if (!n) return [];
    const a = assocMap.get(mesh);
    if (a?.meshes !== undefined) {
      const md = json.meshes?.[a.meshes];
      for (const names of [md?.extras?.targetNames, md?.primitives?.[a.primitives ?? 0]?.extras?.targetNames]) {
        if (Array.isArray(names) && names.length === n) return names.map((x) => String(x));
      }
    }
    const out = Array.from({ length: n }, (_, i) => `#${i}`);
    for (const [k, i] of Object.entries(mesh.morphTargetDictionary ?? {})) {
      if (i >= 0 && i < n && !/^\d+$/.test(k)) out[i] = k;
    }
    return out;
  };

  // Diagnostics list per glTF mesh (or per three.js mesh without association).
  const morphs: MeshMorphList[] = [];
  {
    const seen = new Set<string>();
    for (const m of allMeshes) {
      if (!morphCount(m)) continue;
      const a = assocMap.get(m);
      const key = a?.meshes !== undefined ? `m${a.meshes}` : m.uuid;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = (a?.meshes !== undefined ? json.meshes?.[a.meshes]?.name : undefined) || m.name || m.parent?.name || 'Mesh';
      morphs.push({ mesh: label, primitives: a?.meshes !== undefined ? (meshPrims.get(a.meshes)?.length ?? 1) : 1, names: morphNames(m) });
    }
  }

  const sourceClips: SourceClip[] = [];
  const len = (a: unknown) => (Array.isArray(a) ? a.length : 0);
  for (const g of json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups ?? []) {
    if (!g || typeof g !== 'object') continue;
    sourceClips.push({ name: String(g.name ?? ''), preset: String(g.presetName ?? ''), morphBinds: len(g.binds),
      materialBinds: len(g.materialValues), isBinary: !!g.isBinary });
  }
  for (const [kind, table] of [['preset', json.extensions?.VRMC_vrm?.expressions?.preset], ['custom', json.extensions?.VRMC_vrm?.expressions?.custom]] as const) {
    for (const [name, d] of Object.entries(table ?? {})) {
      sourceClips.push({ name, preset: kind === 'preset' ? name : 'custom', morphBinds: len(d?.morphTargetBinds),
        materialBinds: len(d?.materialColorBinds) + len(d?.textureTransformBinds), isBinary: !!d?.isBinary });
    }
  }

  const originalExpressions = mgr ? mgr.expressions.slice() : [];
  const synthetic = new Map<VRMExpression, string>(); // expression → source description
  const replaced: ExpressionReportEntry[] = [];

  if (mgr) {
    // ---- VRM 0.x: restore binds three-vrm dropped, duplicates, preset case, 0..1 weights
    const groups = json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups;
    const presetAliases = new Map<string, VRMExpression>();
    if (Array.isArray(groups)) {
      const map = VRMExpressionLoaderPlugin.v0v1PresetNameMap as Record<string, string | undefined>;
      const firstOf = new Map<string, number>();
      let restored = 0, fromDuplicates = 0;
      groups.forEach((g, gi) => {
        if (!g || typeof g !== 'object') return;
        const threeName = (g.presetName != null ? map[g.presetName] : undefined) ?? g.name;
        if (threeName == null) return;
        const expr = mgr.getExpression(threeName);
        if (!expr) return;
        const isFirst = !firstOf.has(threeName);
        if (isFirst) firstOf.set(threeName, gi);
        const binds = (Array.isArray(g.binds) ? g.binds : []).filter((b) => Number.isInteger(b?.mesh) && Number.isInteger(b?.index));
        if (isFirst || (!expressionEffective(expr) && binds.length > 0)) {
          let added = 0;
          for (const b of binds) {
            const prims = (meshPrims.get(b.mesh!) ?? []).filter((p) => morphCount(p) > b.index!);
            if (!prims.length) continue;
            const has = expr.binds.some((x) => isMorphBind(x) && x.index === b.index && x.primitives.some((p) => prims.includes(p)));
            if (has) continue;
            expr.addBind(new VRMExpressionMorphTargetBind({ primitives: prims, index: b.index!, weight: 0.01 * (b.weight ?? 100) }));
            added++;
          }
          if (added && isFirst) {
            restored += added;
            note(expr, `${added} Morph-Bindung(en) wiederhergestellt (Mesh-Teile ohne diesen Morph-Target)`);
          } else if (added) {
            fromDuplicates++;
            expr.isBinary = !!g.isBinary;
            note(expr, `Bindungen aus doppeltem Clip Nr. ${gi} übernommen (der erste Clip dieses Namens war leer)`);
          }
        }
        // presetName written in another case ("Joy", "Blink_L") → three-vrm used the clip name.
        const preset = g.presetName ? map[g.presetName.toLowerCase()] : undefined;
        if (preset && preset !== threeName && (!presetAliases.has(preset) || !expressionEffective(presetAliases.get(preset)!))) {
          presetAliases.set(preset, expr);
        }
      });
      if (restored) repairs.push(`${restored} Morph-Bindung(en) wiederhergestellt, die three-vrm verworfen hatte (Mesh-Teile ohne diesen Morph-Target).`);
      if (fromDuplicates) repairs.push(`${fromDuplicates} doppelte(r) BlendShape-Clip(s) statt eines leeren ersten Clips gleichen Namens verwendet.`);

      // Weights written as 0..1 instead of 0..100.
      const weights = groups.flatMap((g) => (Array.isArray(g?.binds) ? g.binds : []).map((b) => b?.weight ?? 100));
      if (weights.length && weights.every((w) => w <= 1) && weights.some((w) => w > 0)) {
        for (const e of mgr.expressions) {
          for (const b of e.binds.slice()) {
            if (!isMorphBind(b)) continue;
            e.deleteBind(b);
            e.addBind(new VRMExpressionMorphTargetBind({ primitives: b.primitives, index: b.index, weight: Math.min(1, b.weight * 100) }));
          }
        }
        repairs.push('Alle VRM0-Gewichte sind ≤ 1 (als 0..1 statt 0..100 gespeichert) – mit 100 multipliziert.');
      }
    }

    // ---- VRM 1.0: restore morph binds three-vrm dropped
    const v1 = json.extensions?.VRMC_vrm?.expressions;
    if (v1) {
      let restored = 0;
      for (const table of [v1.preset, v1.custom]) {
        for (const [name, def] of Object.entries(table ?? {})) {
          const expr = mgr.getExpression(name);
          if (!expr || !Array.isArray(def?.morphTargetBinds)) continue;
          for (const b of def.morphTargetBinds) {
            if (!Number.isInteger(b?.node) || !Number.isInteger(b?.index)) continue;
            const nodeObj = nodeObjs.get(b.node!);
            const meshIndex = json.nodes?.[b.node!]?.mesh;
            if (!nodeObj || meshIndex === undefined) continue;
            const prims: THREE.Mesh[] = [];
            nodeObj.traverse((o) => {
              if ((o as THREE.Mesh).isMesh && assocMap.get(o)?.meshes === meshIndex && morphCount(o as THREE.Mesh) > b.index!) prims.push(o as THREE.Mesh);
            });
            if (!prims.length) continue;
            if (expr.binds.some((x) => isMorphBind(x) && x.index === b.index && x.primitives.some((p) => prims.includes(p)))) continue;
            expr.addBind(new VRMExpressionMorphTargetBind({ primitives: prims, index: b.index!, weight: b.weight ?? 1 }));
            restored++;
            note(expr, 'Morph-Bindung wiederhergestellt (Mesh-Teile ohne diesen Morph-Target)');
          }
        }
      }
      if (restored) repairs.push(`${restored} VRM1-Morph-Bindung(en) wiederhergestellt, die three-vrm verworfen hatte (Mesh-Teile ohne diesen Morph-Target).`);
    }

    // ---- morph catalog (only targets with data)
    const morphByName = new Map<string, Map<THREE.Mesh, number>>();
    for (const m of allMeshes) {
      const names = morphNames(m);
      names.forEach((n, i) => {
        if (n.startsWith('#') || !morphHasData(m, i)) return;
        let refs = morphByName.get(n);
        if (!refs) morphByName.set(n, (refs = new Map()));
        if (!refs.has(m)) refs.set(m, i);
      });
    }
    const morphByKey = new Map<string, string[]>();
    for (const n of morphByName.keys()) {
      for (const k of nameKeys(n)) {
        const l = morphByKey.get(k) ?? [];
        if (!l.includes(n)) l.push(n);
        morphByKey.set(k, l);
      }
    }
    const findMorph = (aliases: string[]): string | null => {
      for (const a of aliases) {
        const hit = morphByKey.get(normName(a));
        if (hit?.length) return hit[0];
      }
      return null;
    };

    // ---- existing expressions by key (effective ones only)
    const usableNow = () => mgr.expressions.filter(expressionEffective);
    const exprByKey = new Map<string, VRMExpression[]>();
    for (const e of usableNow()) {
      for (const k of nameKeys(e.expressionName)) {
        const l = exprByKey.get(k) ?? [];
        l.push(e);
        exprByKey.set(k, l);
      }
    }
    const lowerUsable = (name: string): VRMExpression | undefined => {
      const l = name.toLowerCase();
      return mgr.expressions.find((e) => e.expressionName.toLowerCase() === l && expressionEffective(e));
    };
    const findExpr = (target: string, aliases: string[]): VRMExpression | null => {
      for (const a of aliases) {
        for (const e of exprByKey.get(normName(a)) ?? []) {
          if (e.expressionName !== target && !synthetic.has(e)) return e;
        }
      }
      return null;
    };

    type Plan = { source: string; binds: VRMExpressionBind[]; isBinary: boolean };
    const morphBinds = (name: string, weight: number): VRMExpressionMorphTargetBind[] => {
      const byIndex = new Map<number, THREE.Mesh[]>();
      for (const [mesh, i] of morphByName.get(name) ?? []) {
        const l = byIndex.get(i) ?? [];
        l.push(mesh);
        byIndex.set(i, l);
      }
      return [...byIndex].map(([index, primitives]) => new VRMExpressionMorphTargetBind({ primitives, index, weight }));
    };
    const meshCount = (name: string) => new Set([...(morphByName.get(name)?.keys() ?? [])].map((m) => assocMap.get(m)?.meshes ?? m.uuid)).size;
    const planFor = (target: string, aliases: string[], composites?: [string, number][]): Plan | null => {
      const pa = presetAliases.get(target);
      if (pa && expressionEffective(pa)) {
        return { source: `Ausdruck „${pa.expressionName}“ (Preset)`, binds: pa.binds.slice(), isBinary: pa.isBinary };
      }
      const ex = findExpr(target, aliases);
      if (ex) return { source: `Ausdruck „${ex.expressionName}“`, binds: ex.binds.slice(), isBinary: ex.isBinary };
      const morph = findMorph(aliases);
      if (morph) {
        const n = meshCount(morph);
        return { source: `Morph „${morph}“${n > 1 ? ` (${n} Meshes)` : ''}`, binds: morphBinds(morph, 1), isBinary: false };
      }
      if (composites) {
        const parts = composites.map(([n, w]) => [findMorph(arkitAliases(n)), w] as const).filter((p): p is [string, number] => !!p[0]);
        if (parts.length && parts.length * 2 >= composites.length) {
          return {
            source: `ARKit-Morphs ${parts.map(([n, w]) => (w === 1 ? n : `${n}×${w}`)).join(' + ')}`,
            binds: parts.flatMap(([n, w]) => morphBinds(n, w)),
            isBinary: false,
          };
        }
      }
      return null;
    };
    const register = (target: string, plan: Plan) => {
      const old = mgr.getExpression(target);
      if (old && old.expressionName === target) {
        // Empty model expression of exactly this name: replace it (keeps the name unique).
        const c = countBinds(old);
        replaced.push({ name: old.expressionName, kind: PRESETS.has(old.expressionName) ? 'preset' : 'custom',
          morphBinds: c.morph, materialBinds: c.material, uvBinds: c.uv, effective: false, isBinary: old.isBinary, replaced: true });
        mgr.unregisterExpression(old);
      }
      const e = new VRMExpression(target);
      e.isBinary = plan.isBinary;
      for (const b of plan.binds) e.addBind(b);
      mgr.registerExpression(e);
      synthetic.set(e, plan.source);
    };

    // ---- presets the solver emits
    const compositesAllowed = morphByKey.size > 0;
    for (const target of SOLVER_PRESETS) {
      if (lowerUsable(target)) continue;
      const plan = planFor(target, PRESET_ALIASES[target], compositesAllowed ? ARKIT_COMPOSITES[target] : undefined);
      if (plan) register(target, plan);
    }

    // ---- ARKit (perfect sync): only if enough of them end up usable
    const arkPlans = new Map<string, Plan>();
    let arkUsable = 0;
    for (const n of ARKIT_BLENDSHAPES) {
      if (lowerUsable(n)) { arkUsable++; continue; }
      const plan = planFor(n, arkitAliases(n));
      if (plan) arkPlans.set(n, plan);
    }
    if (arkPlans.size && arkUsable + arkPlans.size >= PERFECT_SYNC_MIN) {
      for (const [n, plan] of arkPlans) register(n, plan);
    }
  }

  // ---- trim unused morph targets when the morph textures get large
  const morphTextureMB = pruneMorphs(vrm, allMeshes, opts, repairs);

  // ---- report
  const entries: ExpressionReportEntry[] = [];
  const empty: string[] = replaced.map((r) => r.name);
  const all = mgr ? mgr.expressions : [];
  for (const e of originalExpressions) {
    if (!all.includes(e)) continue;
    const c = countBinds(e);
    const effective = expressionEffective(e);
    if (!effective) empty.push(e.expressionName);
    entries.push({
      name: e.expressionName, kind: PRESETS.has(e.expressionName) ? 'preset' : 'custom',
      morphBinds: c.morph, materialBinds: c.material, uvBinds: c.uv, effective, isBinary: e.isBinary,
      note: notes.get(e)?.join('; '),
    });
  }
  entries.push(...replaced);
  const mapped: { name: string; source: string }[] = [];
  for (const e of all) {
    const source = synthetic.get(e);
    if (source === undefined) continue;
    const c = countBinds(e);
    entries.push({ name: e.expressionName, kind: 'mapped', source, morphBinds: c.morph, materialBinds: c.material, uvBinds: c.uv,
      effective: expressionEffective(e), isBinary: e.isBinary });
    mapped.push({ name: e.expressionName, source });
  }
  const usable = all.filter(expressionEffective).map((e) => e.expressionName);
  const lower = new Set(usable.map((n) => n.toLowerCase()));
  const perfectSyncNames = ARKIT_BLENDSHAPES.filter((n) => lower.has(n.toLowerCase()));
  return { entries, morphs, repairs, mapped, empty, usable, perfectSyncNames, sourceClips, morphTextureMB };
}

/** Thresholds for removing morph targets no expression uses. */
const PRUNE_MIN_TARGETS = 64;
const PRUNE_MIN_BYTES = 64 * 1024 * 1024;

/**
 * Removes morph targets that no expression references from every geometry, if any geometry has many
 * targets or the textures are large. three.js keeps ALL targets of a geometry in one float texture
 * (one layer per target) and loops over all of them per vertex; a 300-target VRChat face can exceed
 * GPU limits (MAX_ARRAY_TEXTURE_LAYERS, memory), and then morphs fail silently.
 */
function pruneMorphs(vrm: VRM, meshes: THREE.Mesh[], opts: ExpressionSetupOptions, repairs: string[]): ExpressionReport['morphTextureMB'] {
  const mb = (b: number) => Math.round((b / (1024 * 1024)) * 10) / 10;
  const geoMeshes = new Map<THREE.BufferGeometry, THREE.Mesh[]>();
  for (const m of meshes) {
    if (!m.geometry) continue;
    const l = geoMeshes.get(m.geometry) ?? [];
    l.push(m);
    geoMeshes.set(m.geometry, l);
  }
  let before = 0, maxTargets = 0;
  for (const g of geoMeshes.keys()) {
    before += morphTextureBytes(g);
    maxTargets = Math.max(maxTargets, (g.morphAttributes.position ?? g.morphAttributes.normal ?? []).length);
  }
  const layers = opts.maxArrayLayers && opts.maxArrayLayers > 0 ? opts.maxArrayLayers : 256;
  if (!(maxTargets > Math.min(PRUNE_MIN_TARGETS, layers) || before > PRUNE_MIN_BYTES)) {
    return { before: mb(before), after: mb(before), removedTargets: 0 };
  }

  const mgr = vrm.expressionManager;
  const used = new Map<THREE.BufferGeometry, Set<number>>();
  for (const e of mgr?.expressions ?? []) {
    for (const b of e.binds) {
      if (!isMorphBind(b)) continue;
      for (const p of b.primitives) {
        const s = used.get(p.geometry) ?? new Set<number>();
        s.add(b.index);
        used.set(p.geometry, s);
      }
    }
  }
  const remap = new Map<THREE.BufferGeometry, Map<number, number>>();
  let removed = 0;
  for (const [g, ms] of geoMeshes) {
    const ma = g.morphAttributes;
    const n = (ma.position ?? ma.normal ?? ma.color)?.length ?? 0;
    if (!n) continue;
    const keep = [...(used.get(g) ?? [])].filter((i) => i < n).sort((a, b) => a - b);
    if (keep.length === n) continue;
    const map = new Map<number, number>(keep.map((old, i) => [old, i]));
    remap.set(g, map);
    const next: typeof g.morphAttributes = {};
    for (const key of Object.keys(ma) as (keyof typeof ma)[]) {
      const arr = ma[key];
      if (Array.isArray(arr) && arr.length === n) next[key] = keep.map((i) => arr[i]);
    }
    g.morphAttributes = keep.length ? next : {};
    for (const m of ms) {
      const inf = m.morphTargetInfluences ?? [];
      const dict = m.morphTargetDictionary ?? {};
      const names = new Map<number, string>();
      for (const [k, i] of Object.entries(dict)) names.set(i, k);
      m.morphTargetInfluences = keep.map((i) => inf[i] ?? 0);
      m.morphTargetDictionary = Object.fromEntries(keep.map((old, i) => [names.get(old) ?? String(old), i]));
    }
    removed += n - keep.length;
  }
  if (!remap.size) return { before: mb(before), after: mb(before), removedTargets: 0 };

  // Rebind: one bind per new index (primitives of different geometries may get different indices).
  const rebound = new Map<VRMExpressionMorphTargetBind, VRMExpressionMorphTargetBind[]>();
  for (const e of mgr?.expressions ?? []) {
    for (const b of e.binds.slice()) {
      if (!isMorphBind(b) || !b.primitives.some((p) => remap.has(p.geometry))) continue;
      let nb = rebound.get(b);
      if (!nb) {
        const byIndex = new Map<number, THREE.Mesh[]>();
        for (const p of b.primitives) {
          const idx = remap.get(p.geometry)?.get(b.index) ?? (remap.has(p.geometry) ? -1 : b.index);
          if (idx < 0) continue;
          const l = byIndex.get(idx) ?? [];
          l.push(p);
          byIndex.set(idx, l);
        }
        nb = [...byIndex].map(([index, primitives]) => new VRMExpressionMorphTargetBind({ primitives, index, weight: b.weight }));
        rebound.set(b, nb);
      }
      e.deleteBind(b);
      for (const x of nb) e.addBind(x);
    }
  }
  let after = 0;
  for (const g of geoMeshes.keys()) after += morphTextureBytes(g);
  repairs.push(`${removed} ungenutzte Morph-Targets entfernt (größtes Mesh hatte ${maxTargets}; Morph-Texturen ${mb(before)} MB → ${mb(after)} MB).`);
  return { before: mb(before), after: mb(after), removedTargets: removed };
}
