import * as THREE from 'three';
import { QUALITY } from '../core/quality.js';
import { mulberry32 } from '../core/math.js';

// Hair rendering. The physics simulates ~1,000 guide strands per dog (see Fur); this draws a
// whole coat around them, the way game hair systems do it: every guide grows a clump of locks
// whose roots are scattered over the skin around it. Each lock follows its guide's simulated curve
// on the GPU (a Catmull-Rom spline through the guide's particles, read from a float texture) and
// adds its own offset, waviness and length, so the whole coat moves with the physics while only
// the guides are simulated. A lock is a soft ribbon holding several fine hairs (drawn in the
// fragment shader), which is what makes the coat read as fur rather than as strands.
//
// Locks fan apart when a coat is blow-dried, gather into points when it is wet, soapy or muddy,
// and are shaded as hair: dark near the skin and under the body where light can't reach, a bright
// Kajiya-Kay sheen along the strands, and light glowing through backlit tips.

// How the hair looks per coat type. Each drawn strip is a lock: a ribbon `card` times wider than
// a single hair, filled with `strands` fine hairs that wave, end at their own lengths, thin to a
// point and gather toward the lock's tip.
//   width   lock width at the root (m), before `card`   segs   curve points along each lock
//   frizz   wiggle amplitude (m) and frequency          fan    how far blow-dried locks fan out
//   lock    how tightly locks gather toward the tips (1 = not at all)
//   under   share of soft undercoat (double coats only)
//   loft    how far tips lift off the layer below (m), so the coat has depth
const STYLES = {
  fluffy: { width: 0.0021, card: 2.6, strands: 6, segs: 8, frizz: 0.0045, freq: 13, fan: 1.0, lock: 0.7, loft: 0.012, under: 0 },
  curly: { width: 0.0019, card: 2.2, strands: 5, segs: 12, frizz: 0.0055, freq: 34, fan: 0.75, lock: 0.95, loft: 0.01, under: 0 },
  silky: { width: 0.0018, card: 3.0, strands: 7, segs: 9, frizz: 0.0012, freq: 7, fan: 0.3, lock: 0.42, loft: 0.01, under: 0 },
  wiry: { width: 0.0022, card: 1.8, strands: 4, segs: 6, frizz: 0.0028, freq: 40, fan: 0.5, lock: 0.85, loft: 0.006, under: 0 },
  double: { width: 0.0019, card: 2.4, strands: 6, segs: 6, frizz: 0.0018, freq: 9, fan: 0.6, lock: 0.9, loft: 0.008, under: 0.42 },
};

// Shared by every hair material: world size of one pixel per metre of distance, so hairs never
// get thinner than about a pixel (they fade out instead, which keeps distant coats from shimmering).
const shared = { uPx: { value: 0.0012 }, uThin: { value: 1 } };
export function setHairPixelScale(camera, heightPx) {
  shared.uPx.value = 2 / (camera.projectionMatrix.elements[5] * Math.max(1, heightPx));
}

// Share of the hairs actually drawn (0.35–1). The game lowers it on devices that struggle; hairs
// are ordered so that dropping the tail end thins every guide's clump evenly.
let density = 1;
export function setHairDensity(d) {
  density = Math.min(1, Math.max(0.35, d));
  // Fewer locks are drawn wider, so the coat keeps covering the skin.
  shared.uThin.value = Math.pow(density, -0.6);
}
export function hairDensity() {
  return density;
}

const VERT_PARS = /* glsl */ `
uniform highp sampler2D tPos;
uniform highp sampler2D tAttr;
uniform float uK;
uniform float uWidth;
uniform float uThin;
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
varying float vAcross;
varying float vSeed;
vec3 hairPos;
vec3 hairNrm;

vec3 guideP(int j, int row) { return texelFetch(tPos, ivec2(j, row), 0).xyz; }

void growHair() {
  int row = int(aGuide + 0.5);
  int K = int(uK + 0.5);
  vec4 a0 = texelFetch(tAttr, ivec2(0, row), 0); // colour, wet
  vec4 a1 = texelFetch(tAttr, ivec2(1, row), 0); // root normal, gloss
  vec4 a2 = texelFetch(tAttr, ivec2(2, row), 0); // fan, undercoat left, clump, length vs the coat
  vec4 a3 = texelFetch(tAttr, ivec2(3, row), 0); // length (m), radius of the clump's patch, skin curvature
  bool under = aRnd.w > 0.0;
  float u = position.x;
  // Short fur gets very uneven lengths so the edges of each clump's patch don't show.
  float shortK = 1.0 - smoothstep(0.02, 0.05, a3.x);
  float len = under ? 0.38 + 0.22 * aRnd.x : mix(0.74, 0.4, shortK) + mix(0.26, 0.6, shortK) * aRnd.x;
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
  // Short fur (faces, paws, smooth coats) does neither: it stays a flat, even pile.
  float longK = smoothstep(0.02, 0.06, a3.x);
  float spread = 1.0 + uStyle.z * a2.x * uu * longK;
  spread *= mix(1.0, uStyle.w, smoothstep(0.25, 1.0, uu) * (1.0 - a2.x) * longK);
  // Wet locks clump but still lie over each other, so they gather only part way.
  spread *= mix(1.0, mix(0.15, 0.45, wet * (1.0 - a2.z)), max(wet, a2.z) * smoothstep(0.05, 0.75, uu) * mix(0.2, 1.0, longK));
  vec2 o = aOff * (a3.y * spread);
  vec3 p = c + T1 * o.x + T2 * o.y;
  // The clump's patch of skin curves away like the skin does, so its outer hairs don't float
  // above the coat.
  float lo = length(o);
  p -= N * clamp(0.25 * a3.z * lo * lo, -0.5 * lo, 0.5 * lo);
  // Hairs don't all lie in one layer: each lifts a little toward its tip, so the coat has depth.
  // Short hair (faces, paws) stays sleek: loft and frizz scale with how long the hair is.
  float lenK = a2.w;
  p += N * (uLoft * lenK * fract(aRnd.y * 3.7 + aRnd.x * 1.3) * smoothstep(0.0, 0.8, uu) * (1.0 - 0.7 * wet));
  // Each lock starts just under the skin and rises out of the fur.
  p -= N * (0.0012 * (1.0 - smoothstep(0.0, 0.08, uu)));

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
  // A lock is narrow where it leaves the skin and spreads out above it. Short hair is drawn finer
  // so faces and paws read as a smooth pile, not blobs. When the game draws fewer locks to keep
  // up, the rest widen so the coat stays just as full.
  float w =uWidth * uThin * (0.75 + 0.5 * aRnd.y) * (1.0 - 0.4 * u) * mix(0.45, 1.0, smoothstep(0.0, 0.25, u)) * (under ? 0.85 : 1.0) * clamp(sqrt(lenK), 0.55, 1.0) * mix(1.0, 0.6, shortK);
  // Brushed-out undercoat is gone.
  if (under && aRnd.w > a2.y) w = 0.0;
  float wd = w;
  #ifndef HAIR_DEPTH
    // Never thinner than about a pixel: wider but fainter instead.
    wd = max(w, 0.7 * dist * uPx);
  #endif
  vAlpha = wd > 0.0 ? sqrt(w / wd) : 0.0;
  // A lock seen end-on (pointing at the eye) would flip and show its edge: fade it out.
  vAlpha *= smoothstep(0.06, 0.3, sl);
  hairPos = p + side * (position.y * 0.5 * wd);
  hairNrm = normalize(N * 0.7 + normalize(V - tan * dot(V, tan)) * 0.3);

  // Colour: shadowed near the skin, a little different hair to hair, sun-bleached tips, and
  // darker under the body where little light reaches (so pale coats keep their shape).
  vec3 col = a0.rgb * (0.82 + 0.26 * fract(aRnd.y * 7.31 + aRnd.z * 3.17)) * mix(0.68, 1.0, smoothstep(-0.7, 0.45, N.y));
  if (under) col = mix(col, vec3(0.9, 0.87, 0.82), 0.45);
  // Long coats are dark down at the skin; short fur lies on top and barely darkens at the root.
  vHairCol = col * mix(mix(0.55, 0.86, shortK), 0.97, smoothstep(0.0, 0.7, u));
  vWet = wet;
  vGloss = a1.w;
  vU = u;
  vAcross = position.y;
  vSeed = aRnd.z * 61.7 + aRnd.y * 17.3;
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
varying float vAcross;
varying float vSeed;
uniform float uStrands;
float hairTilt = 0.0;

// The fine hairs inside a lock: spread across it, each a little wavy, ending at its own length
// and thinning to a point, gathering toward the lock's tip (more when wet). Far away the hairs
// blur together into a soft, translucent lock. Returns coverage; shade varies hair to hair.
float lockHairs(float x, float u, float seed, float wet, out float shade, out float tilt) {
  float m = 0.0, cover = 0.0;
  shade = 1.0;
  tilt = 0.0;
  float aa = fwidth(x) * 0.75 + 1e-4;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    if (fi >= uStrands) break;
    float h1 = fract(sin(seed * 12.9898 + fi * 78.233) * 43758.5453);
    float h2 = fract(sin(seed * 39.3468 + fi * 11.135) * 24634.6345);
    float h3 = fract(sin(seed * 73.156 + fi * 27.719) * 51832.1937);
    // Hairs come up out of the coat one by one rather than along a straight edge.
    float start = 0.16 * h3 * h3;
    float end = 0.7 + 0.3 * h2;
    if (u < start || u > end) continue;
    float base = ((fi + 0.5) / uStrands * 2.0 - 1.0) * 0.85 + (h1 - 0.5) * (1.4 / uStrands);
    float gather = 1.0 - (0.25 + 0.42 * wet) * smoothstep(0.15, 1.0, u);
    float cx = base * gather + 0.1 * sin(u * (5.0 + 7.0 * h1) + h2 * 6.283) * (1.0 - 0.7 * wet);
    // Each hair keeps its thickness most of the way and thins to a point toward its own end; the
    // ones at the edges of the lock are finer, so a lock has a soft outline instead of a hard one.
    float hw = (0.95 / uStrands) * sqrt(1.0 - smoothstep(0.3 * end, end, u)) * smoothstep(start, start + 0.07, u) * (1.0 - 0.4 * abs(base));
    cover += hw;
    float mi = 1.0 - smoothstep(hw - aa, hw + aa, abs(x - cx));
    if (mi > m) {
      m = mi;
      shade = 0.9 + 0.2 * h1;
      // Every hair lies at its own slight angle, so its highlight sits somewhere else.
      tilt = (h2 - 0.5) * 0.5;
    }
  }
  // Too fine to make out (far away, or on a small screen), a lock's hairs blur together: it
  // then covers as much as its hairs do on average instead of turning see-through.
  float avg = min(1.0, cover / 0.85) * (1.0 - smoothstep(0.8, 1.0, abs(x)));
  return mix(m, max(m, avg), smoothstep(0.6, 1.6, aa * uStrands / 0.95));
}
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
  vec3 Ta = normalize(T + normal * (hairTilt - 0.12));
  vec3 Tb = normalize(T + normal * (hairTilt + 0.2));
  float ta = dot(Ta, H), tb = dot(Tb, H);
  float sa = pow(sqrt(max(0.0, 1.0 - ta * ta)), 80.0);
  float sb = pow(sqrt(max(0.0, 1.0 - tb * tb)), 18.0);
  float lit = saturate(dot(normal, L) * 0.5 + 0.5);
  float g = (vGloss + 0.12) * (1.0 + vWet * 0.8);
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
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float shade;
          float m = lockHairs(vAcross, vU, vSeed, vWet, shade, hairTilt);
          if (m < 0.02) discard;
          diffuseColor.rgb *= vHairCol * shade;
          diffuseColor.a *= vAlpha * m * (1.0 - 0.5 * smoothstep(0.8, 1.0, vU));
        }`
      )
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
    this.spacing = (fur.spacing ?? 0.02) * 0.85;
    const counts = new Uint16Array(S);
    let n = 0;
    for (let s = 0; s < S; s++) {
      counts[s] = Math.round(C * Math.min(3.2, Math.max(0.7, Math.pow(ref / Math.max(0.005, fur.natLen[s]), 0.6))));
      n += counts[s];
    }
    // Round-robin order (every guide's first hair, then every guide's second...) so drawing only
    // the first part of the list still covers the whole dog.
    const guide = new Float32Array(n), off = new Float32Array(n * 2), rnd = new Float32Array(n * 4);
    const maxC = Math.max(...counts);
    const phase = new Float32Array(S).map(() => rng());
    for (let c = 0, i = 0; c < maxC; c++) {
      for (let s = 0; s < S; s++) {
        if (c >= counts[s]) continue;
        guide[i] = s;
        // Evenly spread out from the centre (so the first few roots of a clump already cover its
        // whole patch, and drawing fewer hairs thins the coat evenly), at random angles: a
        // sunflower spiral would show its spiral arms in short fur.
        const r = Math.sqrt((phase[s] + c * 0.618034) % 1), th = rng() * Math.PI * 2;
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
    this.attrData = new Float32Array(4 * S * 4);
    const tex = (data, w) => {
      const t = new THREE.DataTexture(data, w, S, THREE.RGBAFormat, THREE.FloatType);
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      return t;
    };
    this.tPos = tex(this.posData, W);
    this.tAttr = tex(this.attrData, 4);
    const uniforms = {
      tPos: { value: this.tPos },
      tAttr: { value: this.tAttr },
      uK: { value: K },
      uWidth: { value: style.width * style.card * Math.sqrt(30 / C) },
      uStrands: { value: style.strands },
      uThin: shared.uThin,
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
      const a = s * 16;
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
      // Children spread over the patch of skin each guide stands for, overlapping a little.
      A[a + 12] = f.natLen[s];
      A[a + 13] = this.spacing * f.disc[s];
      A[a + 14] = f.curv[s];
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
