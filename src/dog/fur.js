import * as THREE from 'three';
import { clamp01, smoothstep, fbm3, mulberry32 } from '../core/math.js';
import { SpatialHash } from '../core/spatialHash.js';
import { QUALITY } from '../core/quality.js';

// The coat's physics. Every strand is a root on the skeleton plus K verlet particles (K depends on
// the coat: long silky hair gets more segments so it can flow). Strands are pulled toward a
// groomed rest shape whose stiffness depends on how wet/fluffy they are, pushed by wind and
// water, held together by mat constraints, and collide with the body, the floor they stand on and
// the tub walls. These are guide strands: HairView (hair.js) draws a clump of fine hairs around
// each one, so the whole coat moves with them.
//
// Hair types change both the physics and the look:
//   fluffy  long shaggy hair (sheepdog)        curly   springy crimped curls (poodle, bichon)
//   silky   long glossy flowing locks with waves and feathering (golden, shih tzu)
//   wiry    harsh stiff hair with beard, brows and leg furnishings (schnauzer)
//   double  plush stand-up coat over a soft undercoat that sheds out in clumps (husky, corgi)
export const DEFAULT_K = 3;

export const REGION = {
  back: 0, belly: 1, chest: 2, rear: 3, neck: 4, headtop: 5, face: 6, ears: 7, legs: 8, paws: 9, tail: 10, tailtip: 11, brows: 12,
};
export const REGION_KEYS = Object.keys(REGION);
export const REGION_NAMES = ['back', 'belly', 'chest', 'rear', 'neck', 'head', 'face', 'ears', 'legs', 'paws', 'tail', 'tail tip', 'eyebrows'];
export const REGION_COUNT = REGION_KEYS.length;

const MUD = new THREE.Color('#6a4a2c');
const MUD_DRY = new THREE.Color('#8a6644');
const LATHER = new THREE.Color('#F7FAFA');
const HINT = new THREE.Color('#ff9ec4');
const MAT_HINT = new THREE.Color('#ff8a3d');
const UNDERCOAT = new THREE.Color('#e9e2d6');
const SHED_HINT = new THREE.Color('#b9a2ff');

const _c = new THREE.Color();

// The open-floor default: nothing to stand on but the salon floor, no walls.
export const OPEN_GROUND = { y: 0, x0: -1e9, x1: 1e9, z0: -1e9, z1: 1e9, below: 0, walls: false, top: 0 };

export class Fur {
  constructor({ parts, dog, breed, seed, cut, relocate = null }) {
    this.dog = dog;
    this.breed = breed;
    const rng = mulberry32(seed * 7919 + 13);
    this.rng = rng;
    const fb = breed.fur;
    const K = (this.K = fb.segs ?? DEFAULT_K);
    this.type = fb.type ?? 'fluffy';
    this.sDry = fb.stand;
    this.stiff = fb.stiff;
    this.curl = fb.curl;
    this.waveStep = fb.waveStep ?? 2.1;
    this.glossBase = fb.gloss ?? 0;
    // Effects per touched particle are tuned for 3 segments; longer strands share them out.
    this.kf = DEFAULT_K / K;

    const tmp = [];
    for (const part of parts) {
      const n = part.count;
      for (let i = 0; i < n; i++) {
        let lx, ly, lz, nx, ny, nz, t = 0;
        if (part.kind === 'ellipsoid') {
          const y = 1 - (2 * (i + 0.5)) / n;
          const r = Math.sqrt(Math.max(0, 1 - y * y));
          const phi = i * 2.399963 + (rng() - 0.5) * 0.35;
          const dx = Math.cos(phi) * r, dy = y, dz = Math.sin(phi) * r;
          // Re-map so the Fibonacci pole lies along the part's long axis when asked.
          let ux = dx, uy = dy, uz = dz;
          if (part.pole === 'z') { ux = dx; uy = dz; uz = dy; }
          const [rx, ry, rz] = part.radii;
          lx = part.center[0] + ux * rx;
          ly = part.center[1] + uy * ry;
          lz = part.center[2] + uz * rz;
          nx = ux / rx; ny = uy / ry; nz = uz / rz;
          const l = Math.hypot(nx, ny, nz);
          nx /= l; ny /= l; nz /= l;
        } else {
          t = (i + rng()) / n;
          const th = rng() * Math.PI * 2;
          const rad = part.radius(t);
          nx = Math.cos(th); ny = Math.sin(th); nz = 0;
          lx = nx * rad; ly = ny * rad; lz = t;
        }
        const P = [lx, ly, lz], N = [nx, ny, nz];
        if (part.exclude && part.exclude(P, N, t)) continue;
        const region = part.region(P, N, t);
        const lenMul = fb.regions?.[REGION_KEYS[region]] ?? 1;
        const len = fb.len * lenMul * (0.82 + rng() * 0.36) * (part.lenScale ? part.lenScale(P, N, t) : 1);
        const G = part.groom(P, N, t);
        const col = part.color(P, region, N, t, rng);
        const stiffMul = part.stiffMul ? part.stiffMul(P, N, t) : 1;
        const standMul = part.standMul ? part.standMul(P, N, t) : 1;
        // Sampled on simple shapes, then moved onto the dog's actual skin.
        const [Pr, Nr, curv = 0] = relocate ? relocate(part.bone, P, N) : [P, N];
        // disc: how wide this guide's clump of fine hairs spreads, relative to the usual;
        // curv: how the skin curves there (sum of principal curvatures, 1/m).
        const d = { bone: part.bone, P: Pr, N: Nr, G, len, region, col, part: part.name, stiffMul, standMul, disc: part.disc ?? 1, curv };
        // A last look at where the root really landed (faces keep clear of eyes and nose).
        if (part.after && part.after(d) === false) continue;
        tmp.push(d);
      }
    }

    const S = (this.S = tmp.length);
    this.partNames = [...new Set(tmp.map((d) => d.part))];
    this.partId = Uint8Array.from(tmp, (d) => this.partNames.indexOf(d.part));
    const NP = (this.NP = S * K);
    this.bone = new Uint8Array(S);
    this.rootLocal = new Float32Array(S * 3);
    this.normal = new Float32Array(S * 3);
    this.groom = new Float32Array(S * 3);
    this.t1 = new Float32Array(S * 3);
    this.t2 = new Float32Array(S * 3);
    this.messyDir = new Float32Array(S * 3);
    this.phase = new Float32Array(S);
    this.natLen = new Float32Array(S);
    this.len = new Float32Array(S);
    this.target = new Float32Array(S);
    this.puff = new Float32Array(S);
    this.region = new Uint8Array(S);
    this.color = new Float32Array(S * 3);
    this.wet = new Float32Array(S);
    this.dirt = new Float32Array(S);
    this.dirt0 = new Float32Array(S);
    this.loose = new Float32Array(S);
    this.soap = new Float32Array(S);
    this.lather = new Float32Array(S);
    this.brushed = new Float32Array(S);
    this.blown = new Float32Array(S);
    this.messy = new Float32Array(S);
    this.fluff = new Float32Array(S);
    this.fluffVel = new Float32Array(S);
    this.alpha = new Float32Array(S);
    this.radius = new Float32Array(S);
    this.stiffMul = new Float32Array(S);
    this.standMul = new Float32Array(S);
    this.shed = new Float32Array(S);
    this.shed0 = new Float32Array(S);
    this.disc = new Float32Array(S);
    this.curv = new Float32Array(S);
    this.mat = new Int16Array(S).fill(-1);
    this.coll = new Int8Array(S * 4).fill(-1);
    // How far into each of those colliders the strand may go (1 = to its surface): never deeper
    // than its own root sits, so hair lies on the real skin rather than on the padded shapes.
    this.collA = new Float32Array(S * 4).fill(1);
    this.rootPos = new Float32Array(S * 3);
    this.rootN = new Float32Array(S * 3);
    this.offs = new Float32Array(NP * 3);
    this.pos = new Float32Array(NP * 3);
    this.prev = new Float32Array(NP * 3);
    this.wind = new Float32Array(NP * 3);
    this.hash = new SpatialHash(0.05, 8192, NP);

    const dirtLevel = breed.dirt;
    const shedLevel = fb.shed ?? 0;
    for (let s = 0; s < S; s++) {
      const d = tmp[s];
      this.bone[s] = d.bone;
      this.rootLocal.set(d.P, s * 3);
      this.normal.set(d.N, s * 3);
      let [gx, gy, gz] = d.G;
      let gl = Math.hypot(gx, gy, gz) || 1;
      gx /= gl; gy /= gl; gz /= gl;
      // Hair groomed into the skin lies along it instead, so the strand is not forever pulled
      // inside the body and pushed back out (which parts the coat).
      {
        const [nx, ny, nz] = d.N;
        const dn = gx * nx + gy * ny + gz * nz;
        if (dn < 0) {
          const tx = gx - nx * dn, ty = gy - ny * dn, tz = gz - nz * dn;
          const tl = Math.hypot(tx, ty, tz);
          if (tl > 0.15) { gx = tx / tl; gy = ty / tl; gz = tz / tl; }
        }
      }
      this.groom.set([gx, gy, gz], s * 3);
      // Tangent frame for curls and waves.
      const [nx, ny, nz] = d.N;
      let ax = ny * gz - nz * gy, ay = nz * gx - nx * gz, az = nx * gy - ny * gx;
      let al = Math.hypot(ax, ay, az);
      if (al < 1e-3) { ax = 1; ay = 0; az = 0; al = 1; }
      ax /= al; ay /= al; az /= al;
      this.t1.set([ax, ay, az], s * 3);
      this.t2.set([ny * az - nz * ay, nz * ax - nx * az, nx * ay - ny * ax], s * 3);
      // A random direction that makes an ungroomed coat look scraggly.
      let mx = rng() - 0.5, my = rng() - 0.5, mz = rng() - 0.5;
      const ml = Math.hypot(mx, my, mz) || 1;
      this.messyDir.set([mx / ml, my / ml, mz / ml], s * 3);
      this.phase[s] = rng() * Math.PI * 2;
      this.disc[s] = d.disc;
      this.curv[s] = d.curv;
      this.natLen[s] = d.len;
      this.len[s] = d.len;
      // Fewer strands on phones are drawn a little puffier so the coat stays full.
      this.puff[s] = (fb.puff / Math.sqrt(QUALITY.fur)) * (0.85 + rng() * 0.3) * (d.region === REGION.face ? 0.75 : 1);
      this.region[s] = d.region;
      this.color.set(d.col, s * 3);
      this.stiffMul[s] = d.stiffMul;
      this.standMul[s] = d.standMul;

      // Mud: patchy noise, worse on paws, legs and belly.
      const [px, py, pz] = d.P;
      const n = fbm3(px * 9 + seed, py * 9, pz * 9 + d.bone * 3.1);
      let dirt = dirtLevel * (0.25 + 0.95 * smoothstep(0.35, 0.7, n));
      if (d.region === REGION.paws) dirt += 0.45 * dirtLevel;
      else if (d.region === REGION.legs) dirt += 0.28 * dirtLevel;
      else if (d.region === REGION.belly) dirt += 0.3 * dirtLevel;
      else if (d.region === REGION.face || d.region === REGION.headtop || d.region === REGION.brows) dirt *= 0.6;
      dirt = clamp01(dirt);
      this.dirt[s] = this.dirt0[s] = dirt;
      this.messy[s] = (this.type === 'wiry' ? 0.75 : 0.55) + rng() * 0.45;
      this.fluff[s] = 0.85;
      // Undercoat ready to blow out (double coats only), thickest on the body and tail.
      if (shedLevel > 0 && ![REGION.face, REGION.paws, REGION.ears, REGION.brows].includes(d.region)) {
        this.shed[s] = this.shed0[s] = shedLevel * (0.6 + rng() * 0.4);
      }
    }

    this.setCut(cut);
    this.mats = [];
    this.matCount = breed.mats;
    this.time = 0;
    let sh = 0;
    for (let s = 0; s < S; s++) sh += this.shed0[s];
    this.shedTotal = sh;
    this.shedFlyAcc = 0; // undercoat released since the last clump flew off
  }

  setCut(cut) {
    this.cut = cut;
    for (let s = 0; s < this.S; s++) {
      const want = cut.lengths[this.region[s]];
      this.target[s] = want == null ? this.natLen[s] : Math.min(this.natLen[s], want);
    }
  }

  // Called once the skeleton has valid frames: place particles, then grow mats.
  init(frames, colliders) {
    this.computeLocalTargets(0);
    this.place(frames);
    this.assignColliders(colliders);
    this.makeMats();
  }

  place(frames) {
    const K = this.K;
    for (let s = 0; s < this.S; s++) {
      this._root(s, frames);
      for (let k = 0; k < K; k++) {
        const i = s * K + k;
        this._target(s, k, frames, _tgt);
        this.pos[i * 3] = this.prev[i * 3] = _tgt[0];
        this.pos[i * 3 + 1] = this.prev[i * 3 + 1] = _tgt[1];
        this.pos[i * 3 + 2] = this.prev[i * 3 + 2] = _tgt[2];
      }
    }
  }

  assignColliders(colliders) {
    // For each strand keep up to 4 colliders whose surface is within reach of the strand.
    const list = colliders.list;
    for (let s = 0; s < this.S; s++) {
      const rx = this.rootPos[s * 3], ry = this.rootPos[s * 3 + 1], rz = this.rootPos[s * 3 + 2];
      const reach = this.natLen[s] + 0.04;
      const cands = [];
      for (let c = 0; c < list.length; c++) {
        const d = colliders.distance(c, rx, ry, rz);
        if (d < reach) cands.push([d, c]);
      }
      cands.sort((a, b) => a[0] - b[0]);
      for (let j = 0; j < Math.min(4, cands.length); j++) {
        const c = cands[j][1];
        this.coll[s * 4 + j] = c;
        this.collA[s * 4 + j] = Math.max(0.5, Math.min(1, colliders.depth(c, rx, ry, rz)));
      }
    }
  }

  makeMats() {
    const rng = this.rng;
    const eligible = [];
    for (let s = 0; s < this.S; s++) {
      const r = this.region[s];
      if ([REGION.back, REGION.rear, REGION.legs, REGION.ears, REGION.neck, REGION.chest, REGION.tail].includes(r)) eligible.push(s);
    }
    for (let m = 0; m < this.matCount && eligible.length; m++) {
      let seedS = -1;
      for (let tries = 0; tries < 20; tries++) {
        const c = eligible[Math.floor(rng() * eligible.length)];
        if (this.mat[c] === -1) { seedS = c; break; }
      }
      if (seedS < 0) break;
      const cx = this.rootPos[seedS * 3], cy = this.rootPos[seedS * 3 + 1], cz = this.rootPos[seedS * 3 + 2];
      const members = [];
      const rad = 0.045 + this.natLen[seedS] * 0.2;
      for (let s = 0; s < this.S; s++) {
        if (this.mat[s] !== -1 || this.bone[s] !== this.bone[seedS]) continue;
        const dx = this.rootPos[s * 3] - cx, dy = this.rootPos[s * 3 + 1] - cy, dz = this.rootPos[s * 3 + 2] - cz;
        if (dx * dx + dy * dy + dz * dz < rad * rad) members.push(s);
      }
      if (members.length < 4) continue;
      const id = this.mats.length;
      for (const s of members) {
        this.mat[s] = id;
        this.dirt[s] = this.dirt0[s] = clamp01(this.dirt0[s] + 0.25);
      }
      this.mats.push({ strands: members, health: 1, cx: 0, cy: 0, cz: 0 });
    }
  }

  get matsLeft() {
    let n = 0;
    for (const m of this.mats) if (m.health > 0) n++;
    return n;
  }

  // Squared distance from a point to the nearest of a strand's root-side, middle and tip particles.
  // Long hair can sit far from its root, so a single particle is not enough to test against.
  _near2(s, x, y, z) {
    const K = this.K, pos = this.pos;
    let best = Infinity;
    for (const k of K > 3 ? [1, (K >> 1) + 1, K - 1] : [1, K - 1]) {
      const i3 = (s * K + k) * 3;
      const dx = pos[i3] - x, dy = pos[i3 + 1] - y, dz = pos[i3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) best = d2;
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Per-frame: fluff springs, groomed rest shape in bone-local space.
  computeLocalTargets(dt) {
    const S = this.S, K = this.K;
    const sDry = this.sDry, stiff = this.stiff, curl = this.curl, waveStep = this.waveStep;
    const { normal, groom, t1, t2, messyDir, offs } = this;
    const silky = this.type === 'silky';
    for (let s = 0; s < S; s++) {
      const wet = this.wet[s];
      const dry = 1 - wet;
      const dirt = this.dirt[s] + this.loose[s] * 0.5;
      let ft = (0.42 + 0.58 * Math.pow(dry, 1.3)) * (1 - 0.32 * Math.min(1, dirt));
      ft += this.blown[s] * (silky ? 0.12 : 0.3) * dry + this.brushed[s] * 0.08 * dry;
      ft += this.lather[s] * 0.25;
      const m = this.mat[s];
      if (m >= 0) ft *= 1 - 0.4 * this.mats[m].health;
      if (dt > 0) {
        // Underdamped: drying fur overshoots and "boings" into volume.
        const a = 70 * (ft - this.fluff[s]) - 7.5 * this.fluffVel[s];
        this.fluffVel[s] += a * dt;
        this.fluff[s] += this.fluffVel[s] * dt;
      } else this.fluff[s] = ft;
      const f = this.fluff[s];
      const sm = smoothstep(0.42, 1, f);
      let sOut = (sDry * sm + 0.55 * Math.max(0, f - 1) * (silky ? 0.3 : 1)) * this.standMul[s];
      if (m >= 0) sOut *= 1 - 0.6 * this.mats[m].health;
      sOut = Math.min(0.92, sOut);
      this.alpha[s] = (stiff * (0.28 + 0.72 * sm) + 0.06 * Math.max(0, f - 1)) * this.stiffMul[s];
      // Short fur is naturally springier, and very short fur keeps the way it was groomed.
      if (this.len[s] < 0.04) this.alpha[s] = Math.max(this.alpha[s], this.len[s] < 0.025 ? 0.6 : 0.35);
      const lenF = Math.min(1, this.len[s] / Math.max(0.01, this.natLen[s]));
      // A coat still full of undercoat is puffier and scruffier.
      const shed = this.shed[s];
      this.radius[s] =
        this.puff[s] * (0.5 + 0.5 * sm) * (1 + 0.45 * Math.max(0, f - 1)) * (0.55 + 0.45 * Math.sqrt(lenF)) *
        (1 + this.lather[s] * 0.35) * (1 + shed * 0.22);

      const mw = (this.messy[s] * 0.5 + shed * 0.25) * (1 - wet * 0.6);
      const shortK = smoothstep(0.015, 0.045, this.natLen[s]);
      const seg = this.len[s] / K;
      const s3 = s * 3;
      let ax = 0, ay = 0, az = 0;
      for (let k = 0; k < K; k++) {
        const ph = this.phase[s] + k * waveStep;
        // Curls spring back when dry; waves stay a little even when wet.
        // (Short hair on faces and paws stays straight.)
        const amp = curl * (silky ? 0.45 + 0.55 * dry : dry) * shortK;
        const cc = Math.cos(ph) * amp, ss = Math.sin(ph) * amp;
        // Bend from "standing out" at the root toward the groom direction at the tip.
        const so = sOut * (1 - (k / Math.max(1, K - 1)) * 0.25);
        let dx = groom[s3] * (1 - so) + normal[s3] * so + messyDir[s3] * mw + t1[s3] * cc + t2[s3] * ss;
        let dy = groom[s3 + 1] * (1 - so) + normal[s3 + 1] * so + messyDir[s3 + 1] * mw + t1[s3 + 1] * cc + t2[s3 + 1] * ss;
        let dz = groom[s3 + 2] * (1 - so) + normal[s3 + 2] * so + messyDir[s3 + 2] * mw + t1[s3 + 2] * cc + t2[s3 + 2] * ss;
        const l = Math.hypot(dx, dy, dz) || 1;
        ax += (dx / l) * seg;
        ay += (dy / l) * seg;
        az += (dz / l) * seg;
        const o = (s * K + k) * 3;
        offs[o] = ax;
        offs[o + 1] = ay;
        offs[o + 2] = az;
      }
    }
  }

  _root(s, F) {
    const b = this.bone[s] * 13;
    const lx = this.rootLocal[s * 3], ly = this.rootLocal[s * 3 + 1], lz = this.rootLocal[s * 3 + 2] * F[b + 12];
    this.rootPos[s * 3] = F[b] + F[b + 3] * lx + F[b + 6] * ly + F[b + 9] * lz;
    this.rootPos[s * 3 + 1] = F[b + 1] + F[b + 4] * lx + F[b + 7] * ly + F[b + 10] * lz;
    this.rootPos[s * 3 + 2] = F[b + 2] + F[b + 5] * lx + F[b + 8] * ly + F[b + 11] * lz;
  }

  _target(s, k, F, out) {
    const b = this.bone[s] * 13;
    const o = (s * this.K + k) * 3;
    const lx = this.rootLocal[s * 3] + this.offs[o];
    const ly = this.rootLocal[s * 3 + 1] + this.offs[o + 1];
    const lz = this.rootLocal[s * 3 + 2] * F[b + 12] + this.offs[o + 2];
    out[0] = F[b] + F[b + 3] * lx + F[b + 6] * ly + F[b + 9] * lz;
    out[1] = F[b + 1] + F[b + 4] * lx + F[b + 7] * ly + F[b + 10] * lz;
    out[2] = F[b + 2] + F[b + 5] * lx + F[b + 8] * ly + F[b + 11] * lz;
  }

  // ------------------------------------------------------------------
  // One physics sub-step. `ground` says what the dog stands on (see OPEN_GROUND).
  step(h, F, colliders, ground = OPEN_GROUND) {
    const { pos, prev, wind, offs, rootLocal, rootPos } = this;
    const K = this.K;
    const C = colliders.data;
    const g = -9.81 * h * h;
    const hh = h * h;
    const floorIn = ground.y + 0.004, floorOut = ground.below + 0.004;
    const gx0 = ground.x0, gx1 = ground.x1, gz0 = ground.z0, gz1 = ground.z1;
    const walls = ground.walls, wallTop = ground.top;
    const wm = 0.012;
    for (let s = 0; s < this.S; s++) {
      const b = this.bone[s] * 13;
      const blen = F[b + 12];
      const Ox = F[b], Oy = F[b + 1], Oz = F[b + 2];
      const Xx = F[b + 3], Xy = F[b + 4], Xz = F[b + 5];
      const Yx = F[b + 6], Yy = F[b + 7], Yz = F[b + 8];
      const Zx = F[b + 9], Zy = F[b + 10], Zz = F[b + 11];
      const rlx = rootLocal[s * 3], rly = rootLocal[s * 3 + 1], rlz = rootLocal[s * 3 + 2] * blen;
      let px0 = Ox + Xx * rlx + Yx * rly + Zx * rlz;
      let py0 = Oy + Xy * rlx + Yy * rly + Zy * rlz;
      let pz0 = Oz + Xz * rlx + Yz * rly + Zz * rlz;
      rootPos[s * 3] = px0;
      rootPos[s * 3 + 1] = py0;
      rootPos[s * 3 + 2] = pz0;
      const nlx = this.normal[s * 3], nly = this.normal[s * 3 + 1], nlz = this.normal[s * 3 + 2];
      this.rootN[s * 3] = Xx * nlx + Yx * nly + Zx * nlz;
      this.rootN[s * 3 + 1] = Xy * nlx + Yy * nly + Zy * nlz;
      this.rootN[s * 3 + 2] = Xz * nlx + Yz * nly + Zz * nlz;
      const wet = this.wet[s];
      const seg = this.len[s] / K;
      const alpha = this.alpha[s];
      const damp = 0.986 - 0.05 * wet;
      // Wet or limp hair sags; very short fur just lies flatter on the skin.
      const droop = (wet * 0.6 + (1 - Math.min(1, this.fluff[s])) * 0.3) * seg * (this.len[s] < 0.025 ? 0.15 : 1);
      const c0 = this.coll[s * 4], c1 = this.coll[s * 4 + 1], c2 = this.coll[s * 4 + 2], c3 = this.coll[s * 4 + 3];
      const collA = this.collA;
      for (let k = 0; k < K; k++) {
        const i = s * K + k;
        const i3 = i * 3;
        const lx = rlx + offs[i3], ly = rly + offs[i3 + 1], lz = rlz + offs[i3 + 2];
        const tx = Ox + Xx * lx + Yx * ly + Zx * lz;
        const ty = Oy + Xy * lx + Yy * ly + Zy * lz - droop * (k + 1);
        const tz = Oz + Xz * lx + Yz * ly + Zz * lz;

        let px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
        const vx = (px - prev[i3]) * damp, vy = (py - prev[i3 + 1]) * damp, vz = (pz - prev[i3 + 2]) * damp;
        prev[i3] = px;
        prev[i3 + 1] = py;
        prev[i3 + 2] = pz;
        px += vx + wind[i3] * hh;
        py += vy + wind[i3 + 1] * hh + g;
        pz += vz + wind[i3 + 2] * hh;

        // Stiffer near the root, looser at the tip.
        const a = alpha * (1.3 - (0.6 * k) / Math.max(1, K - 1));
        px += (tx - px) * a;
        py += (ty - py) * a;
        pz += (tz - pz) * a;

        // Follow-the-leader length constraint.
        let dx = px - px0, dy = py - py0, dz = pz - pz0;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const f = seg / dl;
        px = px0 + dx * f;
        py = py0 + dy * f;
        pz = pz0 + dz * f;

        // Body collisions.
        if (c0 >= 0) {
          for (let cc = 0; cc < 4; cc++) {
            const ci = cc === 0 ? c0 : cc === 1 ? c1 : cc === 2 ? c2 : c3;
            if (ci < 0) break;
            const cb = ci * 16;
            const allow = collA[s * 4 + cc];
            if (C[cb] === 0) {
              const ex = px - C[cb + 1], ey = py - C[cb + 2], ez = pz - C[cb + 3];
              const rx = C[cb + 13], ry = C[cb + 14], rz = C[cb + 15];
              let lx2 = (ex * C[cb + 4] + ey * C[cb + 5] + ez * C[cb + 6]) / rx;
              let ly2 = (ex * C[cb + 7] + ey * C[cb + 8] + ez * C[cb + 9]) / ry;
              let lz2 = (ex * C[cb + 10] + ey * C[cb + 11] + ez * C[cb + 12]) / rz;
              const q = lx2 * lx2 + ly2 * ly2 + lz2 * lz2;
              if (q < allow * allow && q > 1e-8) {
                const inv = allow / Math.sqrt(q);
                lx2 *= inv * rx; ly2 *= inv * ry; lz2 *= inv * rz;
                px = C[cb + 1] + C[cb + 4] * lx2 + C[cb + 7] * ly2 + C[cb + 10] * lz2;
                py = C[cb + 2] + C[cb + 5] * lx2 + C[cb + 8] * ly2 + C[cb + 11] * lz2;
                pz = C[cb + 3] + C[cb + 6] * lx2 + C[cb + 9] * ly2 + C[cb + 12] * lz2;
              }
            } else {
              const ax = C[cb + 1], ay = C[cb + 2], az = C[cb + 3];
              const abx = C[cb + 4] - ax, aby = C[cb + 5] - ay, abz = C[cb + 6] - az;
              const r = C[cb + 7] * allow;
              const ab2 = abx * abx + aby * aby + abz * abz || 1e-6;
              let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ab2;
              t = t < 0 ? 0 : t > 1 ? 1 : t;
              const qx = px - (ax + abx * t), qy = py - (ay + aby * t), qz = pz - (az + abz * t);
              const d2 = qx * qx + qy * qy + qz * qz;
              if (d2 < r * r && d2 > 1e-10) {
                const k2 = r / Math.sqrt(d2);
                px = ax + abx * t + qx * k2;
                py = ay + aby * t + qy * k2;
                pz = az + abz * t + qz * k2;
              }
            }
          }
        }
        // Tub walls keep the coat inside the basin.
        if (walls && py < wallTop) {
          if (px < gx0 + wm) { px = gx0 + wm; prev[i3] = px; }
          else if (px > gx1 - wm) { px = gx1 - wm; prev[i3] = px; }
          if (pz < gz0 + wm) { pz = gz0 + wm; prev[i3 + 2] = pz; }
          else if (pz > gz1 - wm) { pz = gz1 - wm; prev[i3 + 2] = pz; }
        }
        // The floor under the dog only exists where there is a table top or tub floor.
        const fl = px > gx0 && px < gx1 && pz > gz0 && pz < gz1 ? floorIn : floorOut;
        if (py < fl) {
          py = fl;
          // Friction against the surface.
          prev[i3] = px - (px - prev[i3]) * 0.5;
          prev[i3 + 2] = pz - (pz - prev[i3 + 2]) * 0.5;
        }
        pos[i3] = px;
        pos[i3 + 1] = py;
        pos[i3 + 2] = pz;
        px0 = px;
        py0 = py;
        pz0 = pz;
      }
    }

    // Mats clump the tips of their strands together.
    for (const m of this.mats) {
      if (m.health <= 0) continue;
      let cx = 0, cy = 0, cz = 0;
      const n = m.strands.length;
      for (const s of m.strands) {
        const i3 = (s * K + K - 1) * 3;
        cx += pos[i3]; cy += pos[i3 + 1]; cz += pos[i3 + 2];
      }
      cx /= n; cy /= n; cz /= n;
      m.cx = cx; m.cy = cy; m.cz = cz;
      const st = 0.35 * m.health;
      for (const s of m.strands) {
        for (let k = 1; k < K; k++) {
          const i3 = (s * K + k) * 3;
          const w = st * (k / (K - 1));
          pos[i3] += (cx - pos[i3]) * w;
          pos[i3 + 1] += (cy - pos[i3 + 1]) * w;
          pos[i3 + 2] += (cz - pos[i3 + 2]) * w;
        }
      }
    }
  }

  endFrame() {
    this.wind.fill(0);
  }

  buildHash() {
    this.hash.build(this.pos, this.NP);
  }

  tipIndex(s) {
    return s * this.K + this.K - 1;
  }

  // ------------------------------------------------------------------
  // Grooming operations.

  // A water droplet touching fur near (x,y,z). `amt` is 1 for a normal spray drop.
  // Returns how muddy the water is as it leaves (0 clear … 1 brown), or -1 for a miss.
  water(x, y, z, amt, vx, vy, vz) {
    let carried = 0, hits = 0;
    const r = 0.05;
    const K = this.K;
    const a = amt * this.kf;
    const pos = this.pos, prev = this.prev;
    this.hash.query(x, y, z, r, (i) => {
      const i3 = i * 3;
      const dx = pos[i3] - x, dy = pos[i3 + 1] - y, dz = pos[i3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz > r * r) return;
      const s = (i / K) | 0;
      this.wet[s] = Math.min(1, this.wet[s] + 0.18 * a);
      const dl = Math.min(this.lather[s], 0.1 * a);
      this.lather[s] -= dl;
      this.soap[s] = Math.max(0, this.soap[s] - 0.1 * a);
      const dlo = Math.min(this.loose[s], 0.12 * a);
      this.loose[s] -= dlo;
      // Plain water only shifts the loosest mud; the rest needs shampoo.
      const floor = this.dirt0[s] * 0.42;
      let dd = 0;
      if (this.dirt[s] > floor) {
        dd = Math.min(this.dirt[s] - floor, 0.02 * a);
        this.dirt[s] -= dd;
      }
      carried += (dlo + dd) * 6 + dl * 0.5 + this.dirt[s] * 0.25;
      hits++;
      // Water pressure pushes the fur.
      const push = 0.0012;
      prev[i3] -= vx * push;
      prev[i3 + 1] -= vy * push;
      prev[i3 + 2] -= vz * push;
    });
    return hits ? Math.min(1, carried / hits) : -1;
  }

  // Shampoo gel landing on the coat.
  soapAt(x, y, z, r, amount) {
    let n = 0;
    for (let s = 0; s < this.S; s++) {
      const d2 = this._near2(s, x, y, z);
      if (d2 < r * r) {
        const f = 1 - Math.sqrt(d2) / r;
        this.soap[s] = Math.min(1.5, this.soap[s] + amount * (0.5 + f));
        n++;
      }
    }
    return n;
  }

  // Hands working the coat: spread shampoo, build lather and lift mud where soapy; pet where dry.
  scrub(x, y, z, r, sx, sy, sz, intensity, dt, mult = 1) {
    const K = this.K;
    const out = { lather: 0, dirtMoved: 0, dryPet: 0, touched: 0, needsWater: 0, bubbles: [] };
    const prev = this.prev;
    const near = this._near || (this._near = []);
    near.length = 0;
    let soapSum = 0, latherSum = 0;
    for (let s = 0; s < this.S; s++) {
      const d2 = this._near2(s, x, y, z);
      if (d2 > r * r) continue;
      near.push(s, 1 - Math.sqrt(d2) / r);
      soapSum += this.soap[s];
      latherSum += this.lather[s];
    }
    const n = near.length / 2;
    if (!n) return out;
    // Scrubbing smears shampoo and foam around the patch under your hand.
    const soapAvg = soapSum / n, latherAvg = latherSum / n;
    const mix = Math.min(1, dt * 4 * intensity);
    for (let j = 0; j < near.length; j += 2) {
      const s = near[j], f = near[j + 1];
      out.touched++;
      this.soap[s] += (soapAvg - this.soap[s]) * mix * f;
      if (this.wet[s] > 0.25) this.lather[s] += (latherAvg - this.lather[s]) * mix * f * 0.5;
      const wet = this.wet[s];
      if (this.soap[s] > 0.01) {
        if (wet < 0.25) out.needsWater++;
        else {
          const make = Math.min(this.soap[s], dt * 5 * intensity * f * mult);
          this.soap[s] -= make * 0.3;
          const before = this.lather[s];
          this.lather[s] = Math.min(1, this.lather[s] + make * 2);
          out.lather += this.lather[s] - before;
          if (Math.random() < this.lather[s] * f * dt * 18) out.bubbles.push(this.tipIndex(s));
        }
      }
      if (this.lather[s] > 0.05) {
        const mv = Math.min(this.dirt[s], this.lather[s] * dt * 4 * intensity * f * mult);
        this.dirt[s] -= mv;
        this.loose[s] += mv;
        out.dirtMoved += mv;
      } else if (wet < 0.3) {
        out.dryPet += f;
      }
      // Scrubbing pushes the coat around.
      for (let k = 0; k < K; k++) {
        const jj = (s * K + k) * 3;
        const w = 0.004 * f * ((k + 1) / K) * 3;
        prev[jj] -= sx * w;
        prev[jj + 1] -= sy * w;
        prev[jj + 2] -= sz * w;
      }
    }
    return out;
  }

  // Wind from the dryer: pushes particles, dries strands, flings droplets, blows out undercoat.
  blow(ox, oy, oz, dx, dy, dz, power, range, dt, cloudMult = 1) {
    const K = this.K;
    const out = { dried: 0, fling: [], face: 0, shedFly: [] };
    const pos = this.pos, wind = this.wind;
    const t = this.time;
    const mid = K >> 1;
    for (let s = 0; s < this.S; s++) {
      const i3 = (s * K + mid) * 3;
      const vx = pos[i3] - ox, vy = pos[i3 + 1] - oy, vz = pos[i3 + 2] - oz;
      const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (dist > range || dist < 1e-4) continue;
      const cos = (vx * dx + vy * dy + vz * dz) / dist;
      if (cos < 0.86) continue;
      const fall = smoothstep(0.86, 0.985, cos) * (1 - dist / range);
      if (fall <= 0) continue;
      const pw = power * fall;
      for (let k = 0; k < K; k++) {
        const j = (s * K + k) * 3;
        const tb = Math.sin(t * 31 + s * 1.7 + k) * 0.6, tc = Math.cos(t * 27 + s * 2.3 - k);
        const strength = 95 * pw * (1 - this.wet[s] * 0.45) * (0.6 + (k / Math.max(1, K - 1)) * 0.6);
        wind[j] += (dx + tb * 0.5) * strength;
        wind[j + 1] += (dy + tc * 0.5) * strength;
        wind[j + 2] += (dz + tb * 0.4) * strength;
      }
      const m = this.mat[s];
      const matSlow = m >= 0 && this.mats[m].health > 0 ? 0.35 : 1;
      const before = this.wet[s];
      this.wet[s] = Math.max(0, before - pw * dt * 1.05 * matSlow);
      out.dried += before - this.wet[s];
      if (this.wet[s] < 0.85) this.blown[s] = Math.min(1, this.blown[s] + pw * dt * 1.4 * cloudMult * (1 - this.wet[s]));
      if (before > 0.25 && Math.random() < before * pw * dt * 14) out.fling.push(this.tipIndex(s));
      if ((this.region[s] === REGION.headtop || this.region[s] === REGION.face) && pw > out.face) out.face = pw;
      // A strong dryer on a dry double coat blows loose undercoat out in drifting clumps.
      if (this.shed[s] > 0 && this.wet[s] < 0.4) {
        const rel = Math.min(this.shed[s], pw * dt * 0.4);
        this.shed[s] -= rel;
        this.shedFlyAcc += rel;
        if (this.shedFlyAcc > 2.5) {
          this.shedFlyAcc -= 2.5;
          out.shedFly.push(s);
        }
      }
    }
    return out;
  }

  brush(x, y, z, r, sx, sy, sz, speed, dt, matMult = 1) {
    const K = this.K;
    const out = { touched: 0, matsHit: [], matF: [], cleared: [], tangle: 0, shed: 0, shedAt: [] };
    const prev = this.prev;
    for (let s = 0; s < this.S; s++) {
      const d2 = this._near2(s, x, y, z);
      if (d2 > r * r) continue;
      const f = 1 - Math.sqrt(d2) / r;
      out.touched++;
      const m = this.mat[s];
      if (m >= 0 && this.mats[m].health > 0) {
        out.tangle += f;
        const k = out.matsHit.indexOf(m);
        if (k < 0) {
          out.matsHit.push(m);
          out.matF.push(f);
        } else out.matF[k] = Math.max(out.matF[k], f);
      }
      const dry = 1 - this.wet[s];
      this.messy[s] = Math.max(0, this.messy[s] - speed * dt * 0.25 * f);
      if (dry > 0.6) this.brushed[s] = Math.min(1, this.brushed[s] + speed * dt * 0.1 * f);
      // Brushing knocks dried mud loose.
      if (dry > 0.7 && this.dirt[s] > this.dirt0[s] * 0.25) this.dirt[s] -= Math.min(this.dirt[s], speed * dt * 0.002 * f);
      // ...and pulls dead undercoat out of a double coat.
      if (this.shed[s] > 0 && dry > 0.5) {
        const rel = Math.min(this.shed[s], (0.5 + speed) * dt * 0.3 * f * matMult);
        this.shed[s] -= rel;
        out.shed += rel;
        this.shedFlyAcc += rel;
        if (this.shedFlyAcc > 1.2 && out.shedAt.length < 3) {
          this.shedFlyAcc -= 1.2;
          out.shedAt.push(s);
        }
      }
      for (let k = 0; k < K; k++) {
        const j = (s * K + k) * 3;
        const w = 0.0016 * f * ((k + 1) / K) * 3;
        prev[j] -= sx * w;
        prev[j + 1] -= sy * w;
        prev[j + 2] -= sz * w;
      }
    }
    // Each stroke through a mat teases it apart a little.
    out.matsHit.forEach((m, k) => {
      const mat = this.mats[m];
      mat.health -= (0.6 + speed) * dt * 0.22 * matMult * Math.max(0.3, out.matF[k]);
      if (mat.health <= 0) {
        mat.health = 0;
        out.cleared.push(m);
      }
    });
    return out;
  }

  // Clippers: shorten strands near the blade down to the guard length. Returns cut-off bits.
  clip(x, y, z, r, guard) {
    const K = this.K;
    const cuts = [];
    const pos = this.pos, prev = this.prev, rootPos = this.rootPos;
    for (let s = 0; s < this.S; s++) {
      if (this.len[s] <= guard + 0.004) continue;
      let hit = false;
      for (let k = 0; k < K; k++) {
        const j = (s * K + k) * 3;
        const dx = pos[j] - x, dy = pos[j + 1] - y, dz = pos[j + 2] - z;
        if (dx * dx + dy * dy + dz * dz < r * r) { hit = true; break; }
      }
      if (!hit) continue;
      const old = this.len[s];
      const nl = guard;
      const f = nl / old;
      // Bits that fall away: the tip particles.
      const tip = this.tipIndex(s) * 3;
      cuts.push({
        x: pos[tip], y: pos[tip + 1], z: pos[tip + 2],
        vx: (pos[tip] - prev[tip]) * 60, vy: (pos[tip + 1] - prev[tip + 1]) * 60, vz: (pos[tip + 2] - prev[tip + 2]) * 60,
        r: this.radius[s] * 0.9, amount: (old - nl) / this.natLen[s], s,
      });
      this.len[s] = nl;
      if (this.mat[s] >= 0) {
        const mat = this.mats[this.mat[s]];
        if (nl < this.natLen[s] * 0.45) mat.health = Math.max(0, mat.health - 0.15);
      }
      const rx = rootPos[s * 3], ry = rootPos[s * 3 + 1], rz = rootPos[s * 3 + 2];
      for (let k = 0; k < K; k++) {
        const j = (s * K + k) * 3;
        pos[j] = rx + (pos[j] - rx) * f;
        pos[j + 1] = ry + (pos[j + 1] - ry) * f;
        pos[j + 2] = rz + (pos[j + 2] - rz) * f;
        prev[j] = rx + (prev[j] - rx) * f;
        prev[j + 1] = ry + (prev[j + 1] - ry) * f;
        prev[j + 2] = rz + (prev[j + 2] - rz) * f;
      }
    }
    return cuts;
  }

  // Ray against the actual fur puffs. Returns {t, s} or null.
  raycast(ox, oy, oz, dx, dy, dz, maxT = 3) {
    const K = this.K;
    let best = maxT, bs = -1, bi = -1;
    const pos = this.pos;
    for (let i = 0; i < this.NP; i++) {
      const i3 = i * 3;
      const vx = pos[i3] - ox, vy = pos[i3 + 1] - oy, vz = pos[i3 + 2] - oz;
      const tca = vx * dx + vy * dy + vz * dz;
      if (tca < 0 || tca > best + 0.1) continue;
      const s = (i / K) | 0;
      const r = this.radius[s] * 1.05;
      const d2 = vx * vx + vy * vy + vz * vz - tca * tca;
      if (d2 > r * r) continue;
      const t = tca - Math.sqrt(r * r - d2);
      if (t < best) {
        best = t;
        bs = s;
        bi = i;
      }
    }
    return bs >= 0 ? { t: best, s: bs, i: bi } : null;
  }

  // Ambient drying.
  ambient(dt) {
    this.time += dt;
    for (let s = 0; s < this.S; s++) {
      if (this.wet[s] > 0) this.wet[s] = Math.max(0, this.wet[s] - dt * 0.004);
      // Soap without scrubbing slowly lathers a little on its own when wet.
      if (this.soap[s] > 0 && this.wet[s] > 0.4) {
        const m = Math.min(this.soap[s], dt * 0.02);
        this.soap[s] -= m;
        this.lather[s] = Math.min(1, this.lather[s] + m);
      }
    }
  }

  stats() {
    let dirt = 0, dirt0 = 0, wet = 0, lather = 0, cutErr = 0, cutN = 0, soap = 0, shed = 0;
    for (let s = 0; s < this.S; s++) {
      // Paws and bellies are hard to reach in a tub; they count for less.
      const w = CLEAN_WEIGHT[this.region[s]];
      dirt += (this.dirt[s] + this.loose[s]) * w;
      dirt0 += this.dirt0[s] * w;
      wet += this.wet[s];
      lather += this.lather[s];
      soap += this.soap[s];
      shed += this.shed[s];
      const nat = this.natLen[s], tgt = this.target[s], len = this.len[s];
      if (tgt < nat * 0.95) {
        cutErr += Math.min(1, Math.abs(len - tgt) / Math.max(0.015, nat - tgt));
        cutN++;
      } else if (len < nat * 0.85) {
        cutErr += Math.min(1, (nat - len) / nat) * 1.5;
        cutN++;
      } else cutN += 0.25;
    }
    const S = this.S;
    return {
      clean: 1 - dirt / Math.max(1e-6, dirt0),
      dry: 1 - wet / S,
      lather: lather / S,
      soap: soap / S,
      matsLeft: this.matsLeft,
      matsTotal: this.mats.length,
      cut: cutN > 0 ? 1 - cutErr / cutN : 1,
      wetAvg: wet / S,
      // How much of the shedding undercoat is out (1 when there was none).
      deshed: this.shedTotal > 0 ? 1 - shed / this.shedTotal : 1,
      sheds: this.shedTotal > 0,
    };
  }

  // Colour for one strand given its state.
  strandColor(s, hint, out) {
    const wet = this.wet[s];
    _c.setRGB(this.color[s * 3], this.color[s * 3 + 1], this.color[s * 3 + 2]);
    // Clean fluffy fur gets slightly brighter.
    _c.multiplyScalar((1 - 0.28 * wet) * (1 + 0.06 * this.blown[s] * (1 - wet)));
    // Loose undercoat reads as a dull, pale haze over the top coat.
    if (this.shed[s] > 0) _c.lerp(UNDERCOAT, this.shed[s] * 0.22 * (1 - wet));
    const d = Math.min(1, this.dirt[s] * 0.95 + this.loose[s] * 0.6);
    if (d > 0) _c.lerp(wet > 0.4 ? MUD : MUD_DRY, Math.min(0.95, d * 1.2));
    const m = this.mat[s];
    if (m >= 0 && this.mats[m].health > 0) {
      _c.multiplyScalar(1 - 0.22 * this.mats[m].health);
      if (hint === 'brush') _c.lerp(MAT_HINT, 0.35 + 0.2 * Math.sin(this.time * 6));
    }
    // With the brush out, coat that still holds loose undercoat glows a soft lilac.
    if (hint === 'brush' && this.shed[s] > 0.2 && m < 0) _c.lerp(SHED_HINT, Math.min(0.4, this.shed[s] * 0.45) * (0.75 + 0.25 * Math.sin(this.time * 4)));
    const l = this.lather[s] + Math.min(0.3, this.soap[s] * 0.2);
    if (l > 0) _c.lerp(LATHER, Math.min(0.92, l * 0.9));
    if (hint === 'clip') {
      const over = this.len[s] - this.target[s];
      if (over > 0.01) _c.lerp(HINT, Math.min(0.55, 0.25 + over * 4));
    }
    out[0] = _c.r;
    out[1] = _c.g;
    out[2] = _c.b;
    return out;
  }

  // Sheen strength for silky coats: clean, dry and well brushed hair shines.
  glossOf(s) {
    if (this.glossBase <= 0) return 0;
    const dirt = Math.min(1, this.dirt[s] * 1.4 + this.loose[s]);
    return this.glossBase * (1 - this.wet[s] * 0.5) * (0.35 + 0.65 * this.brushed[s]) * (1 - dirt) * (1 - Math.min(1, this.lather[s] * 2));
  }

  // The undercoat colour for clumps that come out.
  undercoatColor(s, out) {
    _c.setRGB(this.color[s * 3], this.color[s * 3 + 1], this.color[s * 3 + 2]).lerp(UNDERCOAT, 0.45);
    out[0] = _c.r;
    out[1] = _c.g;
    out[2] = _c.b;
    return out;
  }
}

const _tgt = [0, 0, 0];
// back belly chest rear neck headtop face ears legs paws tail tailtip brows
const CLEAN_WEIGHT = [1, 0.5, 1, 1, 1, 1, 0.8, 0.8, 0.7, 0.4, 0.8, 0.8, 0.8];

// ----------------------------------------------------------------------
// Coats are drawn by HairView (hair.js). This soft, cloud-shaded material is for the loose bits:
// clipped tufts and the undercoat that drifts out of a shedding coat.
export function makeFurMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, color: 0xffffff });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWet;\nattribute vec3 aN;\nvarying float vWet;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWet = aWet;')
      // Lean each puff's normal toward its outward normal so a clump shades like one soft blob.
      .replace('#include <defaultnormal_vertex>', '#include <defaultnormal_vertex>\ntransformedNormal = normalize(mix(transformedNormal, normalMatrix * aN, 0.62));');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWet;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.32, vWet);')
      .replace(
        '#include <opaque_fragment>',
        `{
          float rim = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 2.2);
          outgoingLight += diffuseColor.rgb * (0.10 + rim * 0.38) * (1.0 - vWet * 0.7);
        }
        #include <opaque_fragment>`
      );
  };
  return mat;
}
