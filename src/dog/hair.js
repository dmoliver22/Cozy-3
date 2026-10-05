import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { mulberry32 } from '../core/math.js';

// Hair rendering. The physics simulates ~1,000 guide strands per dog (see Fur); this draws a
// whole coat of fine hairs around them, the way game hair systems do it: every guide grows a
// clump of child hairs whose roots are scattered over the skin around it. Each child follows its
// guide's simulated curve on the GPU (a Catmull-Rom spline through the guide's particles, read
// from a float texture) and adds its own offset, waviness and length, so the whole coat moves with
// the physics while only the guides are simulated.
//
// Child hairs fan apart when a coat is blow-dried, gather into points when it is wet, soapy or
// muddy, and are shaded as hair: dark near the skin where light can't reach, a bright
// Kajiya-Kay sheen along the strands, and light glowing through backlit tips.

// How the fine hairs look per coat type.
//   width   hair thickness at the root (m)       segs   curve points along each hair
//   frizz   wiggle amplitude (m) and frequency   fan    how far blow-dried hairs fan out
//   lock    how tightly hairs gather into locks toward the tips (1 = not at all)
//   under   share of soft undercoat hairs (double coats only)
//   loft    how far hair tips lift off the layer below (m), so the coat has depth
const STYLES = {
  fluffy: { width: 0.0021, segs: 8, frizz: 0.0045, freq: 13, fan: 1.0, lock: 0.7, loft: 0.012, under: 0 },
  curly: { width: 0.0019, segs: 12, frizz: 0.0055, freq: 34, fan: 0.75, lock: 0.95, loft: 0.01, under: 0 },
  silky: { width: 0.0018, segs: 9, frizz: 0.0012, freq: 7, fan: 0.3, lock: 0.42, loft: 0.01, under: 0 },
  wiry: { width: 0.0022, segs: 6, frizz: 0.0028, freq: 40, fan: 0.5, lock: 0.85, loft: 0.006, under: 0 },
  double: { width: 0.0019, segs: 6, frizz: 0.0018, freq: 9, fan: 0.6, lock: 0.9, loft: 0.008, under: 0.42 },
};

// Shared by every hair material: world size of one pixel per metre of distance, so hairs never
// get thinner than about a pixel (they fade out instead, which keeps distant coats from shimmering).
const shared = { uPx: { value: 0.0012 } };
export function setHairPixelScale(camera, heightPx) {
  shared.uPx.value = 2 / (camera.projectionMatrix.elements[5] * Math.max(1, heightPx));
}

// Share of the hairs actually drawn (0.35–1). The game lowers it on devices that struggle; hairs
// are ordered so that dropping the tail end thins every guide's clump evenly.
let density = 1;
export function setHairDensity(d) {
  density = Math.min(1, Math.max(0.35, d));
}
export function hairDensity() {
  return density;
}

const VERT_PARS = /* glsl */ `
uniform highp sampler2D tPos;
uniform highp sampler2D tAttr;
uniform float uK;
uniform float uWidth;
uniform float uSpacing;
uniform float uPx;
uniform vec4 uStyle; // frizz, freq, fan, lock
uniform float uLoft;
attribute float aGuide;
attribute vec2 aOff;
attribute vec4 aRnd; // length, width/colour jitter, phase, undercoat threshold (0 = guard hair)
varying vec3 vHairCol;
varying float vWet;
varying float vGloss;
varying vec3 vHairTan;
varying float vU;
varying float vAlpha;
vec3 hairPos;
vec3 hairNrm;

vec3 guideP(int j, int row) { return texelFetch(tPos, ivec2(j, row), 0).xyz; }

void growHair() {
  int row = int(aGuide + 0.5);
  int K = int(uK + 0.5);
  vec4 a0 = texelFetch(tAttr, ivec2(0, row), 0); // colour, wet
  vec4 a1 = texelFetch(tAttr, ivec2(1, row), 0); // root normal, gloss
  vec4 a2 = texelFetch(tAttr, ivec2(2, row), 0); // fan, undercoat left, clump, length vs the coat
  bool under = aRnd.w > 0.0;
  float u = position.x;
  float len = under ? 0.38 + 0.22 * aRnd.x : 0.74 + 0.26 * aRnd.x;
  float uu = u * len;

  // Point on the guide's curve.
  float x = uu * float(K);
  int i = min(int(x), K - 1);
  float t = x - float(i);
  vec3 p0 = guideP(max(i - 1, 0), row), p1 = guideP(i, row), p2 = guideP(i + 1, row), p3 = guideP(min(i + 2, K), row);
  vec3 c2 = 2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3, c3 = -p0 + 3.0 * p1 - 3.0 * p2 + p3;
  vec3 c = 0.5 * (2.0 * p1 + (p2 - p0) * t + c2 * t * t + c3 * t * t * t);
  vec3 dc = 0.5 * ((p2 - p0) + 2.0 * c2 * t + 3.0 * c3 * t * t);

  // Frame on the skin at the root: N out of the skin, T1 across the lie of the coat, T2 along it.
  vec3 N = a1.xyz;
  vec3 T1 = cross(N, guideP(1, row) - guideP(0, row));
  if (dot(T1, T1) < 1e-12) T1 = cross(N, vec3(0.31, 0.95, 0.0));
  T1 = normalize(T1);
  vec3 T2 = cross(T1, N);

  float wet = a0.w;
  // Blow-dried hairs fan apart toward the tips; wet, soapy or muddy ones gather into points.
  float spread = 1.0 + uStyle.z * a2.x * uu;
  spread *= mix(1.0, uStyle.w, smoothstep(0.25, 1.0, uu) * (1.0 - a2.x));
  spread *= mix(1.0, 0.15, max(wet, a2.z) * smoothstep(0.05, 0.75, uu));
  vec3 p = c + (T1 * aOff.x + T2 * aOff.y) * (uSpacing * spread);
  // Hairs don't all lie in one layer: each lifts a little toward its tip, so the coat has depth.
  // Short hair (faces, paws) stays sleek: loft and frizz scale with how long the hair is.
  float lenK = a2.w;
  p += N * (uLoft * lenK * fract(aRnd.y * 3.7 + aRnd.x * 1.3) * smoothstep(0.0, 0.8, uu) * (1.0 - 0.7 * wet));

  // Waves and frizz (undercoat is finely crimped), growing from nothing at the root.
  float ph = aRnd.z * 6.2832;
  float amp = (under ? 0.0022 : uStyle.x * lenK) * (1.0 - 0.65 * wet) * smoothstep(0.0, 0.35, uu);
  float fq = under ? 46.0 : uStyle.y;
  float ws = sin(uu * fq + ph), wc = cos(uu * fq * 1.31 + ph * 1.7);
  p += (T1 * ws + N * (0.55 * wc) + T2 * (0.35 * sin(uu * fq * 0.77 + ph))) * amp;
  vec3 tan = normalize(dc * float(K) + (T1 * cos(uu * fq + ph) - N * (0.72 * sin(uu * fq * 1.31 + ph * 1.7))) * (fq * amp));

  // A thin ribbon turned to face the eye, tapering to a point.
  vec3 V = cameraPosition - p;
  float dist = length(V);
  V /= max(dist, 1e-5);
  vec3 side = cross(tan, V);
  float sl = length(side);
  side = sl > 1e-6 ? side / sl : T1;
  // Short hair is drawn finer so faces and paws read as a smooth pile, not blobs.
  float w = uWidth * (0.75 + 0.5 * aRnd.y) * (1.0 - 0.8 * u) * (under ? 0.85 : 1.0) * clamp(sqrt(lenK), 0.55, 1.0);
  // Brushed-out undercoat is gone.
  if (under && aRnd.w > a2.y) w = 0.0;
  float wd = w;
  #ifndef HAIR_DEPTH
    // Never thinner than about a pixel: wider but fainter instead.
    wd = max(w, 0.7 * dist * uPx);
  #endif
  vAlpha = wd > 0.0 ? sqrt(w / wd) : 0.0;
  hairPos = p + side * (position.y * 0.5 * wd);
  hairNrm = normalize(N * 0.7 + normalize(V - tan * dot(V, tan)) * 0.3);

  // Colour: shadowed near the skin, a little different hair to hair, sun-bleached tips.
  vec3 col = a0.rgb * (0.82 + 0.26 * fract(aRnd.y * 7.31 + aRnd.z * 3.17));
  if (under) col = mix(col, vec3(0.9, 0.87, 0.82), 0.45);
  vHairCol = col * mix(0.4, 0.97, smoothstep(0.0, 0.7, u));
  vWet = wet;
  vGloss = a1.w;
  vU = u;
  vHairTan = normalize(mat3(modelViewMatrix) * tan);
}
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vHairCol;
varying float vWet;
varying float vGloss;
varying vec3 vHairTan;
varying float vU;
varying float vAlpha;
`;

const FRAG_SHADE = /* glsl */ `
{
  // Hair sheen (Kajiya-Kay): a white highlight shifted toward the root and a coloured one
  // shifted toward the tip, plus light scattering through backlit hair.
  vec3 T = normalize(vHairTan);
  vec3 V = normalize(vViewPosition);
  #if NUM_DIR_LIGHTS > 0
    vec3 L = directionalLights[0].direction;
    vec3 Lc = directionalLights[0].color;
  #else
    vec3 L = normalize((viewMatrix * vec4(-0.8, 0.5, 0.2, 0.0)).xyz);
    vec3 Lc = vec3(1.0);
  #endif
  vec3 H = normalize(L + V);
  vec3 Ta = normalize(T - normal * 0.12);
  vec3 Tb = normalize(T + normal * 0.2);
  float ta = dot(Ta, H), tb = dot(Tb, H);
  float sa = pow(sqrt(max(0.0, 1.0 - ta * ta)), 80.0);
  float sb = pow(sqrt(max(0.0, 1.0 - tb * tb)), 18.0);
  float lit = saturate(dot(normal, L) * 0.5 + 0.5);
  float g = (vGloss + 0.12) * (1.0 + vWet * 1.4);
  outgoingLight += (vec3(1.0, 0.97, 0.92) * sa * 0.16 + diffuseColor.rgb * sb * 0.22) * g * lit * Lc;
  float back = pow(saturate(dot(-V, L)), 3.0) * vU;
  outgoingLight += diffuseColor.rgb * back * 0.22 * Lc;
}
`;

function hairMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <beginnormal_vertex>', 'growHair();\nvec3 objectNormal = hairNrm;')
      .replace('#include <begin_vertex>', 'vec3 transformed = hairPos;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vHairCol;\ndiffuseColor.a *= vAlpha * (1.0 - 0.85 * smoothstep(0.72, 1.0, vU));')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, vWet);')
      .replace('#include <opaque_fragment>', `${FRAG_SHADE}\n#include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'dog-hair-1';
  return mat;
}

function hairDepthMaterial(uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n#define HAIR_DEPTH\n${VERT_PARS}`)
      .replace('#include <begin_vertex>', 'growHair();\nvec3 transformed = hairPos;');
  };
  mat.customProgramCacheKey = () => 'dog-hair-depth-1';
  return mat;
}

const _col = [0, 0, 0];

export class HairView {
  constructor(fur, { seed = 1 } = {}) {
    this.fur = fur;
    const S = fur.S, K = fur.K;
    const style = STYLES[fur.type] ?? STYLES.fluffy;
    const C = QUALITY.hairs;
    const rng = mulberry32(seed * 131 + 7);

    // One hair: a strip of (segs + 1) pairs of vertices; x = how far along, y = which edge.
    const segs = style.segs;
    const base = new Float32Array((segs + 1) * 2 * 3);
    for (let k = 0; k <= segs; k++) {
      base[k * 6] = base[k * 6 + 3] = k / segs;
      base[k * 6 + 1] = -1;
      base[k * 6 + 4] = 1;
    }
    const index = [];
    for (let k = 0; k < segs; k++) {
      const a = k * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
    geo.setIndex(index);

    // Child hairs: roots scattered evenly over the disc of skin around their guide. Short hair
    // covers less skin per hair, so short-haired guides grow more of them.
    const ref = (this.refLen = fur.breed.fur.len);
    const counts = new Uint16Array(S);
    let n = 0;
    for (let s = 0; s < S; s++) {
      counts[s] = Math.round(C * Math.min(2.6, Math.max(0.7, Math.pow(ref / Math.max(0.005, fur.natLen[s]), 0.6))));
      n += counts[s];
    }
    // Round-robin order (every guide's first hair, then every guide's second...) so drawing only
    // the first part of the list still covers the whole dog.
    const guide = new Float32Array(n), off = new Float32Array(n * 2), rnd = new Float32Array(n * 4);
    const maxC = Math.max(...counts);
    const angle = new Float32Array(S).map(() => rng() * Math.PI * 2);
    const phase = new Float32Array(S).map(() => rng());
    for (let c = 0, i = 0; c < maxC; c++) {
      for (let s = 0; s < S; s++) {
        if (c >= counts[s]) continue;
        guide[i] = s;
        // Low-discrepancy spiral: the first few roots of a clump already cover its whole patch, so
        // drawing fewer hairs thins the coat evenly.
        const r = Math.sqrt((phase[s] + c * 0.618034) % 1), th = angle[s] + c * 2.39996 + (rng() - 0.5) * 0.5;
        off[i * 2] = Math.cos(th) * r;
        off[i * 2 + 1] = Math.sin(th) * r;
        rnd[i * 4] = rng();
        rnd[i * 4 + 1] = rng();
        rnd[i * 4 + 2] = rng();
        rnd[i * 4 + 3] = rng() < style.under ? 0.02 + 0.98 * rng() : 0;
        i++;
      }
    }
    this.total = n;
    geo.setAttribute('aGuide', new THREE.InstancedBufferAttribute(guide, 1));
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
    geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 4));
    geo.instanceCount = n;

    // Guide curves (root + K points per row) and per-guide state, refreshed every frame.
    const W = K + 1;
    this.posData = new Float32Array(W * S * 4);
    this.attrData = new Float32Array(3 * S * 4);
    const tex = (data, w) => {
      const t = new THREE.DataTexture(data, w, S, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.tPos = tex(this.posData, W);
    this.tAttr = tex(this.attrData, 3);
    const uniforms = {
      tPos: { value: this.tPos },
      tAttr: { value: this.tAttr },
      uK: { value: K },
      uWidth: { value: style.width * Math.sqrt(30 / C) },
      // Children spread over the patch of skin each guide stands for, overlapping a little.
      uSpacing: { value: (fur.spacing ?? 0.02) * 0.85 },
      uStyle: { value: new THREE.Vector4(style.frizz, style.freq, style.fan, style.lock) },
      uLoft: { value: style.loft },
      uPx: shared.uPx,
    };
    this.mesh = new THREE.Mesh(geo, hairMaterial(uniforms));
    this.mesh.customDepthMaterial = hairDepthMaterial(uniforms);
    this.mesh.frustumCulled = false;
    // The body casts the dog's shadow; tens of thousands of hairs in the shadow pass cost too much.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.update();
  }

  update(hint = false) {
    const f = this.fur;
    const S = f.S, K = f.K, W = K + 1;
    const P = this.posData, A = this.attrData;
    const pos = f.pos, root = f.rootPos, rn = f.rootN;
    const silky = f.glossBase > 0;
    for (let s = 0; s < S; s++) {
      let o = s * W * 4;
      P[o] = root[s * 3];
      P[o + 1] = root[s * 3 + 1];
      P[o + 2] = root[s * 3 + 2];
      for (let k = 0; k < K; k++) {
        o += 4;
        const j = (s * K + k) * 3;
        P[o] = pos[j];
        P[o + 1] = pos[j + 1];
        P[o + 2] = pos[j + 2];
      }
      f.strandColor(s, hint, _col);
      const wet = f.wet[s];
      const a = s * 12;
      A[a] = _col[0];
      A[a + 1] = _col[1];
      A[a + 2] = _col[2];
      A[a + 3] = wet;
      A[a + 4] = rn[s * 3];
      A[a + 5] = rn[s * 3 + 1];
      A[a + 6] = rn[s * 3 + 2];
      const dirt = Math.min(1, f.dirt[s] * 1.3 + f.loose[s]);
      A[a + 7] = silky ? f.glossOf(s) : 0.2 * (1 - dirt) * (1 - wet * 0.3);
      // How blown out (fanned) the strand is, how much undercoat is left, and what clumps it.
      A[a + 8] = Math.min(1, f.blown[s] * (1 - wet) * (1 - dirt * 0.6));
      A[a + 9] = f.shed0[s] > 0 ? f.shed[s] / f.shed0[s] : 0;
      const m = f.mat[s];
      A[a + 10] = Math.min(1, f.lather[s] * 1.5 + dirt * 0.45 + (m >= 0 ? f.mats[m].health * 0.8 : 0));
      A[a + 11] = Math.min(1.5, Math.max(0.15, f.len[s] / this.refLen));
    }
    this.tPos.needsUpdate = true;
    this.tAttr.needsUpdate = true;
    this.mesh.geometry.instanceCount = Math.round(this.total * density);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.customDepthMaterial.dispose();
    this.tPos.dispose();
    this.tAttr.dispose();
  }
}
