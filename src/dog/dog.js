import * as THREE from 'three';
import { RigidBody, orientationError } from '../core/rigid.js';
import { Spring, Pendulum } from '../core/springs.js';
import { clamp, lerp, mulberry32, smoothstep } from '../core/math.js';
import { Fur, FurView, K, REGION } from './fur.js';
import { BREEDS, CUTS } from './breeds.js';
import { QUALITY } from '../core/quality.js';

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _eul = new THREE.Euler();
const _fX = new THREE.Vector3();
const _fZ = new THREE.Vector3();
const _fHZ = new THREE.Vector3();

function ellipsoidInertia(m, a, b, c) {
  return new THREE.Vector3((m * (b * b + c * c)) / 5, (m * (a * a + c * c)) / 5, (m * (a * a + b * b)) / 5);
}

function ellipsoidArea(a, b, c) {
  const p = 1.6075;
  return 4 * Math.PI * Math.pow((Math.pow(a * b, p) + Math.pow(a * c, p) + Math.pow(b * c, p)) / 3, 1 / p);
}

// A chain of verlet particles hanging off a rigid body (tail, ears).
class Chain {
  constructor(n, seg, anchor, dirs, stiff, damping = 0.92, gravity = 1) {
    this.n = n;
    this.seg = seg;
    this.anchor = new THREE.Vector3(...anchor);
    this.dirs = dirs.map((d) => new THREE.Vector3(...d).normalize());
    this.stiff = stiff;
    this.damping = damping;
    this.gravity = gravity;
    this.p = Array.from({ length: n + 1 }, () => new THREE.Vector3());
    this.prev = Array.from({ length: n + 1 }, () => new THREE.Vector3());
    this.wind = Array.from({ length: n + 1 }, () => new THREE.Vector3());
  }

  place(body, extra) {
    body.localToWorld(this.anchor, this.p[0]);
    this.prev[0].copy(this.p[0]);
    _q.copy(body.quat).multiply(extra);
    for (let j = 1; j <= this.n; j++) {
      _a.copy(this.dirs[j - 1]).applyQuaternion(_q).multiplyScalar(this.seg);
      this.p[j].copy(this.p[j - 1]).add(_a);
      this.prev[j].copy(this.p[j]);
    }
  }

  step(h, body, extra, collide) {
    body.localToWorld(this.anchor, this.p[0]);
    _q.copy(body.quat).multiply(extra);
    _b.copy(this.p[0]);
    const g = -9.81 * this.gravity * h * h;
    for (let j = 1; j <= this.n; j++) {
      const p = this.p[j], pv = this.prev[j];
      _a.copy(this.dirs[j - 1]).applyQuaternion(_q).multiplyScalar(this.seg);
      _b.add(_a); // rest target
      const vx = (p.x - pv.x) * this.damping, vy = (p.y - pv.y) * this.damping, vz = (p.z - pv.z) * this.damping;
      pv.copy(p);
      const w = this.wind[j];
      p.x += vx + w.x * h * h;
      p.y += vy + g + w.y * h * h;
      p.z += vz + w.z * h * h;
      const st = this.stiff * (1.15 - (0.3 * j) / this.n);
      p.x += (_b.x - p.x) * st;
      p.y += (_b.y - p.y) * st;
      p.z += (_b.z - p.z) * st;
      _c.subVectors(p, this.p[j - 1]);
      const l = _c.length() || 1e-6;
      p.copy(this.p[j - 1]).addScaledVector(_c, this.seg / l);
      if (collide) collide(p);
    }
  }

  clearWind() {
    for (const w of this.wind) w.set(0, 0, 0);
  }
}

// Collider table shared with the fur solver (16 floats per collider).
class Colliders {
  constructor() {
    this.list = [];
    this.data = new Float32Array(0);
  }
  add(desc) {
    this.list.push(desc);
    this.data = new Float32Array(this.list.length * 16);
    return this.list.length - 1;
  }
  setEllipsoid(i, c, q, r, margin) {
    const d = this.data, o = i * 16;
    d[o] = 0;
    d[o + 1] = c.x; d[o + 2] = c.y; d[o + 3] = c.z;
    _m.makeRotationFromQuaternion(q);
    const e = _m.elements;
    d[o + 4] = e[0]; d[o + 5] = e[1]; d[o + 6] = e[2];
    d[o + 7] = e[4]; d[o + 8] = e[5]; d[o + 9] = e[6];
    d[o + 10] = e[8]; d[o + 11] = e[9]; d[o + 12] = e[10];
    d[o + 13] = r[0] + margin; d[o + 14] = r[1] + margin; d[o + 15] = r[2] + margin;
  }
  setCapsule(i, a, b, r) {
    const d = this.data, o = i * 16;
    d[o] = 1;
    d[o + 1] = a.x; d[o + 2] = a.y; d[o + 3] = a.z;
    d[o + 4] = b.x; d[o + 5] = b.y; d[o + 6] = b.z;
    d[o + 7] = r;
  }
  // Approximate distance from a point to collider i's surface.
  distance(i, x, y, z) {
    const d = this.data, o = i * 16;
    if (d[o] === 0) {
      const ex = x - d[o + 1], ey = y - d[o + 2], ez = z - d[o + 3];
      const lx = (ex * d[o + 4] + ey * d[o + 5] + ez * d[o + 6]) / d[o + 13];
      const ly = (ex * d[o + 7] + ey * d[o + 8] + ez * d[o + 9]) / d[o + 14];
      const lz = (ex * d[o + 10] + ey * d[o + 11] + ez * d[o + 12]) / d[o + 15];
      const k = Math.sqrt(lx * lx + ly * ly + lz * lz);
      return (k - 1) * Math.min(d[o + 13], d[o + 14], d[o + 15]);
    }
    const ax = d[o + 1], ay = d[o + 2], az = d[o + 3];
    const bx = d[o + 4] - ax, by = d[o + 5] - ay, bz = d[o + 6] - az;
    const t = clamp(((x - ax) * bx + (y - ay) * by + (z - az) * bz) / (bx * bx + by * by + bz * bz || 1), 0, 1);
    return Math.hypot(x - ax - bx * t, y - ay - by * t, z - az - bz * t) - d[o + 7];
  }
  // Push a point out of every collider (used by water, tufts, bubbles).
  pushOut(p, margin = 0) {
    let hit = -1;
    const d = this.data;
    for (let i = 0; i < this.list.length; i++) {
      const o = i * 16;
      if (d[o] === 0) {
        const ex = p.x - d[o + 1], ey = p.y - d[o + 2], ez = p.z - d[o + 3];
        const rx = d[o + 13] + margin, ry = d[o + 14] + margin, rz = d[o + 15] + margin;
        let lx = (ex * d[o + 4] + ey * d[o + 5] + ez * d[o + 6]) / rx;
        let ly = (ex * d[o + 7] + ey * d[o + 8] + ez * d[o + 9]) / ry;
        let lz = (ex * d[o + 10] + ey * d[o + 11] + ez * d[o + 12]) / rz;
        const q = lx * lx + ly * ly + lz * lz;
        if (q < 1 && q > 1e-8) {
          const inv = 1 / Math.sqrt(q);
          lx *= inv * rx; ly *= inv * ry; lz *= inv * rz;
          p.set(
            d[o + 1] + d[o + 4] * lx + d[o + 7] * ly + d[o + 10] * lz,
            d[o + 2] + d[o + 5] * lx + d[o + 8] * ly + d[o + 11] * lz,
            d[o + 3] + d[o + 6] * lx + d[o + 9] * ly + d[o + 12] * lz
          );
          hit = i;
        }
      } else {
        const ax = d[o + 1], ay = d[o + 2], az = d[o + 3];
        const bx = d[o + 4] - ax, by = d[o + 5] - ay, bz = d[o + 6] - az;
        const r = d[o + 7] + margin;
        const t = clamp(((p.x - ax) * bx + (p.y - ay) * by + (p.z - az) * bz) / (bx * bx + by * by + bz * bz || 1), 0, 1);
        const qx = p.x - ax - bx * t, qy = p.y - ay - by * t, qz = p.z - az - bz * t;
        const d2 = qx * qx + qy * qy + qz * qz;
        if (d2 < r * r && d2 > 1e-10) {
          const k = r / Math.sqrt(d2);
          p.set(ax + bx * t + qx * k, ay + by * t + qy * k, az + bz * t + qz * k);
          hit = i;
        }
      }
    }
    return hit;
  }
}

const skinGeo = new THREE.SphereGeometry(1, 20, 14);

export class Dog {
  constructor({ breedKey, seed = 1, cutKey, name = 'Dog', colorway }) {
    const B = (this.B = BREEDS[breedKey]);
    this.breedKey = breedKey;
    this.name = name;
    this.seed = seed;
    this.rng = mulberry32(seed);
    this.cutKey = cutKey;
    this.colorway = colorway ?? (B.colorways ? B.colorways[Math.floor(this.rng() * B.colorways.length)] : null);
    this.group = new THREE.Group();
    this.time = Math.random() * 10;

    // ---------- Rigid bodies ----------
    const [rx, ry, rz] = B.torso;
    this.torso = new RigidBody(B.mass, ellipsoidInertia(B.mass, rx, ry, rz));
    this.torso.linDamping = 1.2;
    this.torso.angDamping = 2.5;
    const hm = B.mass * 0.12;
    const [hx, hy, hz] = B.head.r;
    this.head = new RigidBody(hm, ellipsoidInertia(hm, hx, hy, hz));
    this.head.linDamping = 1.5;
    this.head.angDamping = 3;
    this.headAttach = new THREE.Vector3(0, -0.4 * hy, -0.55 * hz); // on head
    this.torsoJoint = new THREE.Vector3(...B.head.at).add(this.headAttach); // on torso
    this.neckBase = new THREE.Vector3(...B.neck);

    // ---------- Legs ----------
    const legs = [];
    const hipH = B.stand + B.hipF[1];
    const total = hipH * 1.06;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const side = i % 2 === 0 ? 1 : -1;
      const h = front ? B.hipF : B.hipB;
      const L1 = total * (front ? 0.48 : 0.5), L2 = total - L1;
      legs.push({
        name: (front ? 'legF' : 'legB') + (side > 0 ? 'L' : 'R'),
        front, side,
        hip: new THREE.Vector3(h[0] * side, h[1], h[2]),
        L1, L2,
        knee: new THREE.Vector3(), kneePrev: new THREE.Vector3(),
        paw: new THREE.Vector3(), pawPrev: new THREE.Vector3(),
        plant: new THREE.Vector3(),
        stepping: false, stepT: 0, stepDur: 0.15, stepFrom: new THREE.Vector3(),
        group: i === 0 || i === 3 ? 0 : 1,
        hipW: new THREE.Vector3(),
      });
    }
    this.legs = legs;
    this.legLen = total;

    // ---------- Chains ----------
    const T = B.tail;
    this.tail = new Chain(T.segs, T.seg, T.at, T.dirs, T.stiff, 0.9, 0.6);
    const E = B.ears;
    const earDirs = (side) =>
      E.kind === 'floppy'
        ? [[0.5 * side, -0.6, 0.15], [0.15 * side, -1, 0.05]]
        : [[0.35 * side, 1, -0.1], [0.2 * side, 1, -0.15]];
    const earStiff = E.kind === 'floppy' ? 0.06 : 0.45;
    this.earL = new Chain(2, E.seg, [E.at[0], E.at[1], E.at[2]], earDirs(1), earStiff, 0.88, 1);
    this.earR = new Chain(2, E.seg, [-E.at[0], E.at[1], E.at[2]], earDirs(-1), earStiff, 0.88, 1);

    // ---------- Control state ----------
    this.groundY = 0;
    this.targetPos = new THREE.Vector3();
    this.heading = 0;
    this.headingVel = 0;
    this.airborne = false;
    this.air = null;
    this.actions = [];
    this.wag = 0;
    this.wagPhase = 0;
    this.wagAmp = new Spring(0.3, 30, 8);
    this.tailLift = new Spring(0, 40, 9);
    this.happiness = 0.45;
    this.stress = 0;
    this.lookYaw = new Spring(0, 60, 11);
    this.lookPitch = new Spring(0, 60, 11);
    this.lookRoll = new Spring(0, 40, 7);
    this.lookTarget = null;
    this.lookTimer = 0;
    this.lookIdle = new THREE.Vector3();
    this.blink = new Spring(1, 400, 26);
    this.blinkTimer = 2;
    this.squint = 0;
    this.tongue = new Spring(0, 60, 9);
    this.tonguePend = new Pendulum(0.04, 3);
    this.shakeT = -1;
    this.shakeAmp = 0;
    this.extraTail = new THREE.Quaternion();
    this.extraNone = new THREE.Quaternion();
    this.bodyBreath = 0;
    this.onEvent = null; // (type, data) callback for sounds and effects
    this.bow = null;
    this.wagHip = 0;
    this.crouch = 0;
    this.excited = 0;

    this.neckA = new THREE.Vector3();
    this.neckB = new THREE.Vector3();
    this._buildBones();
    this._buildColliders();
    this._buildVisuals();
  }

  // ------------------------------------------------------------------
  _buildBones() {
    // 0 torso, 1 head, 2 neck, 3..10 legs, then tail segs, then ear segs.
    this.boneList = [];
    const add = (b) => (this.boneList.push(b), this.boneList.length - 1);
    this.boneTorso = add({ kind: 'rigid', body: 'torso' });
    this.boneHead = add({ kind: 'rigid', body: 'head' });
    this.boneNeck = add({ kind: 'seg', ref: 'torsoX' });
    this.boneLegs = this.legs.map(() => [add({ kind: 'seg', ref: 'torsoZ' }), add({ kind: 'seg', ref: 'torsoZ' })]);
    this.boneTail = [];
    for (let j = 0; j < this.tail.n; j++) this.boneTail.push(add({ kind: 'seg', ref: 'torsoX' }));
    this.boneEarL = [add({ kind: 'seg', ref: 'headZ' }), add({ kind: 'seg', ref: 'headZ' })];
    this.boneEarR = [add({ kind: 'seg', ref: 'headZ' }), add({ kind: 'seg', ref: 'headZ' })];
    this.frames = new Float32Array(this.boneList.length * 13);
  }

  _buildColliders() {
    const C = (this.colliders = new Colliders());
    this.cTorso = C.add({ name: 'torso' });
    this.cHead = C.add({ name: 'head' });
    this.cSnout = C.add({ name: 'snout' });
    this.cNeck = C.add({ name: 'neck' });
    this.cLegs = this.legs.map(() => [C.add({ name: 'legU' }), C.add({ name: 'legL' })]);
    this.cTail = [];
    for (let j = 0; j < this.tail.n; j++) this.cTail.push(C.add({ name: 'tail' }));
  }

  // Place the dog standing at (x, groundY, z) facing yaw.
  place(x, groundY, z, yaw = 0) {
    const B = this.B;
    this.groundY = groundY;
    this.heading = yaw;
    this.targetPos.set(x, groundY + B.stand, z);
    this.torso.pos.copy(this.targetPos);
    this.torso.quat.setFromAxisAngle(UP, yaw);
    this.torso.vel.set(0, 0, 0);
    this.torso.angVel.set(0, 0, 0);
    this.torso.localToWorld(new THREE.Vector3(...B.head.at), this.head.pos);
    this.head.quat.copy(this.torso.quat);
    this.head.vel.set(0, 0, 0);
    this.head.angVel.set(0, 0, 0);
    for (const L of this.legs) {
      this.torso.localToWorld(L.hip, L.hipW);
      L.plant.set(L.hipW.x, groundY, L.hipW.z);
      L.paw.copy(L.plant);
      L.pawPrev.copy(L.paw);
      this._solveKnee(L, 1);
      L.kneePrev.copy(L.knee);
      L.stepping = false;
    }
    this.airborne = false;
    this.tail.place(this.torso, this.extraNone);
    this.earL.place(this.head, this.extraNone);
    this.earR.place(this.head, this.extraNone);
    this._updateFrames();
    this._updateColliders();
    if (this.fur) this.fur.place(this.frames);
  }

  // Grow the coat. Needs a valid pose, so call after place().
  growFur(furMaterial) {
    const B = this.B;
    const parts = this._furParts();
    const cut = CUTS[this.cutKey] ?? CUTS.tidy;
    this.fur = new Fur({ parts, dog: this, breed: B, seed: this.seed, cut });
    this.fur.init(this.frames, this.colliders);
    this.furView = new FurView(this.fur, furMaterial);
    this.group.add(this.furView.mesh);
    this.furView.update();
  }

  _furParts() {
    const B = this.B;
    const rng = this.rng;
    const parts = [];
    const coat = (part) => (P, region, N, t, r) => B.coat(part, P, region, r ?? rng, this.colorway);
    const [rx, ry, rz] = B.torso;
    const [hx, hy, hz] = B.head.r;
    const sn = B.snout;
    const eyeL = new THREE.Vector3(...B.eyes.at), eyeR = new THREE.Vector3(-B.eyes.at[0], B.eyes.at[1], B.eyes.at[2]);
    const snoutC = new THREE.Vector3(...sn.at);
    const fringe = !!B.fur.fringe;

    const areas = [];
    const torsoA = ellipsoidArea(rx, ry, rz);
    const headA = ellipsoidArea(hx, hy, hz) * 1.1;
    const snoutA = ellipsoidArea(...sn.r) * 0.6;
    const neckL = new THREE.Vector3(...B.head.at).add(this.headAttach).sub(this.neckBase).length();
    const neckA = 2 * Math.PI * B.neckR * neckL;
    const legA = this.legs.map((L) => [2 * Math.PI * B.legR * L.L1, 2 * Math.PI * B.legR * 0.9 * L.L2]);
    const tailA = 2 * Math.PI * B.tail.r * B.tail.seg;
    const earA = 2 * Math.PI * B.ears.w * 0.5 * B.ears.seg * 0.8;
    let total = torsoA + headA + snoutA + neckA + tailA * B.tail.segs + earA * 4;
    for (const [a, b] of legA) total += a + b;
    const N = Math.round(B.fur.count * QUALITY.fur);
    const cnt = (a) => Math.max(6, Math.round((N * a) / total));

    parts.push({
      name: 'torso', bone: this.boneTorso, kind: 'ellipsoid', center: [0, 0, 0], radii: [rx, ry, rz], pole: 'z',
      count: cnt(torsoA),
      region: (P) => {
        const z = P[2] / rz, y = P[1] / ry;
        if (z > 0.55 && y > -0.35) return REGION.chest;
        if (z < -0.6) return REGION.rear;
        if (y < -0.45) return REGION.belly;
        return REGION.back;
      },
      groom: (P, Nn) => [Nn[0] * 0.3, Nn[1] * 0.2 - 0.8, Nn[2] * 0.2 - 0.5],
      color: coat('torso'),
    });
    parts.push({
      name: 'head', bone: this.boneHead, kind: 'ellipsoid', center: [0, 0, 0], radii: [hx, hy, hz],
      count: cnt(headA),
      exclude: (P) => {
        const p = new THREE.Vector3(...P);
        const er = B.eyes.r * 2.3;
        if (p.distanceTo(eyeL) < er || p.distanceTo(eyeR) < er) return true;
        // Inside the snout.
        const d = p.clone().sub(snoutC);
        return (d.x / sn.r[0]) ** 2 + (d.y / sn.r[1]) ** 2 + (d.z / sn.r[2]) ** 2 < 0.8;
      },
      region: (P) => (P[2] > 0.3 * hz && P[1] < 0.3 * hy ? REGION.face : REGION.headtop),
      groom: (P, Nn) => {
        if (fringe && P[2] > -0.25 * hz && P[1] > -0.2 * hy) return [Nn[0] * 0.2, -0.75, 0.65];
        if (P[2] > 0.3 * hz) return [Nn[0] * 0.3, -0.5, 0.6];
        return [Nn[0] * 0.3, Nn[1] * 0.3 - 0.3, -0.9];
      },
      lenScale: (P) => (fringe && P[2] > 0 && P[1] > 0 ? 1.15 : 1),
      color: coat('head'),
    });
    parts.push({
      name: 'snout', bone: this.boneHead, kind: 'ellipsoid', center: sn.at, radii: sn.r,
      count: cnt(snoutA),
      exclude: (P) => {
        const z = (P[2] - sn.at[2]) / sn.r[2];
        const y = (P[1] - sn.at[1]) / sn.r[1];
        if (z > 0.55) return true; // nose & lips
        if (y < -0.5 && z > 0) return true; // mouth
        // inside head
        return (P[0] / hx) ** 2 + (P[1] / hy) ** 2 + (P[2] / hz) ** 2 < 0.85;
      },
      region: () => REGION.face,
      groom: (P, Nn) => [Nn[0] * 0.4, Nn[1] * 0.3 - 0.4, 0.8],
      color: coat('head'),
    });
    parts.push({
      name: 'neck', bone: this.boneNeck, kind: 'seg', radius: () => B.neckR,
      count: cnt(neckA),
      region: () => REGION.neck,
      groom: (P, Nn) => [Nn[0] * 0.3, Nn[1] * 0.3, -1],
      color: coat('neck'),
    });
    this.legs.forEach((L, i) => {
      parts.push({
        name: L.name + '_u', bone: this.boneLegs[i][0], kind: 'seg', radius: () => B.legR,
        count: cnt(legA[i][0]),
        region: () => REGION.legs,
        groom: (P, Nn) => [Nn[0] * 0.3, Nn[1] * 0.3, 1],
        color: coat(L.name),
      });
      parts.push({
        name: L.name + '_l', bone: this.boneLegs[i][1], kind: 'seg', radius: (t) => B.legR * (0.95 - t * 0.1),
        count: cnt(legA[i][1]),
        exclude: (P, Nn, t) => t > 0.93,
        region: () => REGION.paws,
        groom: (P, Nn) => [Nn[0] * 0.3, Nn[1] * 0.3, 1],
        color: coat(L.name),
      });
    });
    this.boneTail.forEach((b, j) => {
      parts.push({
        name: 'tail', bone: b, kind: 'seg', radius: () => B.tail.r,
        count: cnt(tailA),
        region: () => (j === this.boneTail.length - 1 ? REGION.tailtip : REGION.tail),
        groom: (P, Nn) => [Nn[0] * 0.45, Nn[1] * 0.45, 1],
        color: coat('tail'),
      });
    });
    for (const bones of [this.boneEarL, this.boneEarR]) {
      bones.forEach((b) => {
        parts.push({
          name: 'ear', bone: b, kind: 'seg', radius: () => B.ears.w * 0.45,
          count: cnt(earA),
          region: () => REGION.ears,
          groom: (P, Nn) => [Nn[0] * 0.2, Nn[1] * 0.2, 1],
          color: coat('ear'),
        });
      });
    }
    return parts;
  }

  _buildVisuals() {
    const B = this.B;
    const skinCol = new THREE.Color(this.colorway ? new THREE.Color(this.colorway).multiplyScalar(0.85) : B.skin);
    this.skinBase = skinCol.clone();
    this.skinMat = new THREE.MeshStandardMaterial({ color: skinCol, roughness: 0.85 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d1a1a, roughness: 0.18, metalness: 0.0 });
    const shine = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const pink = new THREE.MeshStandardMaterial({ color: 0xef7f8f, roughness: 0.45 });
    const mk = (mat = this.skinMat) => {
      const m = new THREE.Mesh(skinGeo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    this.vTorso = mk();
    this.vHead = new THREE.Group();
    this.group.add(this.vHead);
    const headMesh = new THREE.Mesh(skinGeo, this.skinMat);
    headMesh.scale.set(...B.head.r);
    headMesh.castShadow = true;
    this.vHead.add(headMesh);
    const snout = new THREE.Mesh(skinGeo, this.skinMat);
    snout.scale.set(...B.snout.r);
    snout.position.set(...B.snout.at);
    snout.castShadow = true;
    this.vHead.add(snout);
    const nose = new THREE.Mesh(skinGeo, dark);
    const nr = B.snout.r[0] * 0.42;
    nose.scale.set(nr * 1.15, nr * 0.85, nr);
    nose.position.set(0, B.snout.at[1] + B.snout.r[1] * 0.45, B.snout.at[2] + B.snout.r[2] * 0.92);
    this.vHead.add(nose);
    this.eyes = [];
    for (const side of [1, -1]) {
      const eg = new THREE.Group();
      eg.position.set(B.eyes.at[0] * side, B.eyes.at[1], B.eyes.at[2]);
      const e = new THREE.Mesh(skinGeo, dark);
      e.scale.setScalar(B.eyes.r);
      eg.add(e);
      const s = new THREE.Mesh(skinGeo, shine);
      s.scale.setScalar(B.eyes.r * 0.32);
      s.position.set(B.eyes.r * 0.25 * side, B.eyes.r * 0.35, B.eyes.r * 0.75);
      eg.add(s);
      this.vHead.add(eg);
      this.eyes.push(eg);
    }
    this.vTongue = new THREE.Mesh(skinGeo, pink);
    this.tongueBase = new THREE.Vector3(0, B.snout.at[1] - B.snout.r[1] * 0.7, B.snout.at[2] + B.snout.r[2] * 0.35);
    this.vHead.add(this.vTongue);

    this.vNeck = mk();
    this.vLegs = this.legs.map(() => [mk(), mk(), mk()]);
    this.vTail = Array.from({ length: this.tail.n }, () => mk());
    this.vEars = [Array.from({ length: 2 }, () => mk()), Array.from({ length: 2 }, () => mk())];
  }

  // ------------------------------------------------------------------
  // Frames for the fur roots.
  _setFrameRigid(b, body) {
    const F = this.frames, o = b * 13;
    _m.makeRotationFromQuaternion(body.quat);
    const e = _m.elements;
    F[o] = body.pos.x; F[o + 1] = body.pos.y; F[o + 2] = body.pos.z;
    F[o + 3] = e[0]; F[o + 4] = e[1]; F[o + 5] = e[2];
    F[o + 6] = e[4]; F[o + 7] = e[5]; F[o + 8] = e[6];
    F[o + 9] = e[8]; F[o + 10] = e[9]; F[o + 11] = e[10];
    F[o + 12] = 1;
  }

  _setFrameSeg(b, A, Bp, ref) {
    const F = this.frames, o = b * 13;
    _a.subVectors(Bp, A);
    const len = _a.length() || 1e-5;
    _a.multiplyScalar(1 / len); // Z
    _b.crossVectors(ref, _a);
    if (_b.lengthSq() < 1e-6) _b.set(1, 0, 0);
    _b.normalize(); // X
    _c.crossVectors(_a, _b); // Y
    F[o] = A.x; F[o + 1] = A.y; F[o + 2] = A.z;
    F[o + 3] = _b.x; F[o + 4] = _b.y; F[o + 5] = _b.z;
    F[o + 6] = _c.x; F[o + 7] = _c.y; F[o + 8] = _c.z;
    F[o + 9] = _a.x; F[o + 10] = _a.y; F[o + 11] = _a.z;
    F[o + 12] = len;
  }

  _updateFrames() {
    const T = this.torso, H = this.head;
    this._setFrameRigid(this.boneTorso, T);
    this._setFrameRigid(this.boneHead, H);
    const tX = T.dirToWorld(_d.set(1, 0, 0), _fX);
    const tZ = T.dirToWorld(_d.set(0, 0, 1), _fZ);
    const hZ = H.dirToWorld(_d.set(0, 0, 1), _fHZ);
    const nb = T.localToWorld(this.neckBase, this.neckA);
    const hj = H.localToWorld(this.headAttach, this.neckB);
    this._setFrameSeg(this.boneNeck, nb, hj, tX);
    this.legs.forEach((L, i) => {
      this._setFrameSeg(this.boneLegs[i][0], L.hipW, L.knee, tZ);
      this._setFrameSeg(this.boneLegs[i][1], L.knee, L.paw, tZ);
    });
    for (let j = 0; j < this.tail.n; j++) this._setFrameSeg(this.boneTail[j], this.tail.p[j], this.tail.p[j + 1], tX);
    for (let j = 0; j < 2; j++) {
      this._setFrameSeg(this.boneEarL[j], this.earL.p[j], this.earL.p[j + 1], hZ);
      this._setFrameSeg(this.boneEarR[j], this.earR.p[j], this.earR.p[j + 1], hZ);
    }
  }

  _updateColliders() {
    const B = this.B, C = this.colliders;
    C.setEllipsoid(this.cTorso, this.torso.pos, this.torso.quat, B.torso, 0.008);
    C.setEllipsoid(this.cHead, this.head.pos, this.head.quat, B.head.r, 0.006);
    this.head.localToWorld(_e.set(...B.snout.at), _a);
    C.setEllipsoid(this.cSnout, _a, this.head.quat, B.snout.r, 0.004);
    C.setCapsule(this.cNeck, this.neckA, this.neckB, B.neckR);
    this.legs.forEach((L, i) => {
      C.setCapsule(this.cLegs[i][0], L.hipW, L.knee, B.legR);
      C.setCapsule(this.cLegs[i][1], L.knee, L.paw, B.legR * 0.9);
    });
    for (let j = 0; j < this.tail.n; j++) C.setCapsule(this.cTail[j], this.tail.p[j], this.tail.p[j + 1], B.tail.r);
  }

  // ------------------------------------------------------------------
  // Legs: knees are verlet particles pulled toward an IK solution; paws plant and step.
  _solveKnee(L, w) {
    _a.subVectors(L.paw, L.hipW);
    const dist = Math.min(_a.length(), L.L1 + L.L2 - 1e-4) || 1e-4;
    _a.normalize();
    const x = (L.L1 * L.L1 - L.L2 * L.L2 + dist * dist) / (2 * dist);
    const hgt = Math.sqrt(Math.max(0, L.L1 * L.L1 - x * x));
    // Front elbows bend back, hind knees bend forward.
    this.torso.dirToWorld(_b.set(0, 0, L.front ? -1 : 1), _b);
    _b.addScaledVector(_a, -_b.dot(_a)).normalize();
    _c.copy(L.hipW).addScaledVector(_a, x).addScaledVector(_b, hgt);
    L.knee.lerp(_c, w);
  }

  _stepLegs(h) {
    const T = this.torso;
    const speed = Math.hypot(T.vel.x, T.vel.z);
    const legScale = this.legLen;
    const threshold = 0.18 * legScale + 0.02;
    let groupStepping = [false, false];
    for (const L of this.legs) if (L.stepping) groupStepping[L.group] = true;
    for (const L of this.legs) {
      T.localToWorld(L.hip, L.hipW);
      if (this.airborne) {
        // Tuck the paws under the body while flying.
        T.dirToWorld(_a.set(0, -1, L.front ? 0.25 : -0.25), _a).normalize();
        _b.copy(L.hipW).addScaledVector(_a, (L.L1 + L.L2) * 0.72);
        const v = _c.subVectors(L.paw, L.pawPrev).multiplyScalar(0.9);
        L.pawPrev.copy(L.paw);
        L.paw.add(v);
        L.paw.lerp(_b, 0.25);
      } else {
        // Where the paw would like to be: under the hip, leading in the direction of travel.
        _a.set(L.hipW.x + T.vel.x * 0.16, this.groundY, L.hipW.z + T.vel.z * 0.16);
        if (L.stepping) {
          L.stepT += h;
          const s = Math.min(1, L.stepT / L.stepDur);
          const e = s * s * (3 - 2 * s);
          L.paw.lerpVectors(L.stepFrom, _a, e);
          L.paw.y = this.groundY + Math.sin(Math.PI * s) * legScale * 0.22;
          if (s >= 1) {
            L.stepping = false;
            L.plant.copy(_a);
            L.paw.copy(_a);
            // A little push-off bounce through the body.
            T.vel.y += 0.06 + speed * 0.12;
            this.onEvent?.('pawstep', L);
          }
        } else {
          L.paw.copy(L.plant);
          const dx = L.plant.x - _a.x, dz = L.plant.z - _a.z;
          const far = Math.hypot(dx, dz);
          const stretched = L.hipW.distanceTo(L.plant) > (L.L1 + L.L2) * 1.02;
          if ((far > threshold || stretched) && !groupStepping[1 - L.group]) {
            L.stepping = true;
            L.stepT = 0;
            L.stepDur = 0.11 + legScale * 0.25;
            L.stepFrom.copy(L.plant);
            groupStepping[L.group] = true;
          }
        }
        L.pawPrev.copy(L.paw);
      }
      // Knee: verlet + IK pull + lengths.
      const kv = _c.subVectors(L.knee, L.kneePrev).multiplyScalar(0.8);
      L.kneePrev.copy(L.knee);
      L.knee.add(kv);
      this._solveKnee(L, 0.55);
      for (let it = 0; it < 2; it++) {
        _a.subVectors(L.knee, L.hipW);
        L.knee.copy(L.hipW).addScaledVector(_a, L.L1 / (_a.length() || 1));
        _a.subVectors(L.knee, L.paw);
        L.knee.copy(L.paw).addScaledVector(_a, L.L2 / (_a.length() || 1));
      }
    }
  }

  // ------------------------------------------------------------------
  // Muscles: PD controllers that hold the torso up and steer the head.
  _stepBody(h) {
    const B = this.B, T = this.torso, H = this.head;
    // Torso position.
    if (!this.airborne) {
      const breathe = Math.sin(this.time * (this.tongue.value > 0.3 ? 9 : 2.2)) * 0.003;
      _a.copy(this.targetPos);
      _a.y = this.groundY + B.stand + breathe + this.crouch;
      const kp = 160, kd = 15, kpy = 220, kdy = 13;
      T.vel.x += (kp * (_a.x - T.pos.x) - kd * T.vel.x) * h;
      T.vel.z += (kp * (_a.z - T.pos.z) - kd * T.vel.z) * h;
      T.vel.y += (kpy * (_a.y - T.pos.y) - kdy * T.vel.y) * h;
    } else {
      T.vel.y -= 9.81 * h;
    }
    // Torso orientation: heading, plus pitch while flying, plus hip wiggle from the wag.
    const pitch = this.airborne ? clamp(-T.vel.y * 0.18, -0.5, 0.5) : 0;
    _eul.set(pitch, this.heading + this.wagHip, 0, 'YXZ');
    _q.setFromEuler(_eul);
    orientationError(T.quat, _q, _a);
    const kpa = 180, kda = 18;
    T.angVel.x += (kpa * _a.x - kda * T.angVel.x) * h;
    T.angVel.y += (kpa * _a.y - kda * T.angVel.y) * h;
    T.angVel.z += (kpa * _a.z - kda * T.angVel.z) * h;

    // The shake: a travelling wave of roll around the spine, head first.
    if (this.shakeT >= 0) {
      const t = this.shakeT;
      const env = smoothstep(0, 0.15, t) * (1 - smoothstep(0.9, 1.35, t)) * this.shakeAmp;
      const w = 36;
      T.dirToWorld(_b.set(0, 0, 1), _b);
      const acc = Math.sin(t * w) * 900 * env;
      T.angVel.addScaledVector(_b, acc * h);
      H.dirToWorld(_c.set(0, 0, 1), _c);
      H.angVel.addScaledVector(_c, Math.sin(t * w + 1.2) * 1400 * env * h);
    }

    // Neck joint: spring the head's attach point onto the torso's.
    T.localToWorld(this.torsoJoint, _a);
    H.localToWorld(this.headAttach, _b);
    T.velocityAt(_a, _c);
    H.velocityAt(_b, _d);
    const kj = 900, kdj = 40;
    _e.subVectors(_a, _b).multiplyScalar(kj).addScaledVector(_c.sub(_d), kdj);
    if (this.airborne) H.vel.y -= 9.81 * h;
    H.vel.addScaledVector(_e, h);
    // Reaction on the torso (scaled by the mass ratio) gives the body a nod when the head moves.
    _e.multiplyScalar(-H.mass * h);
    T.impulse(_e, _a);

    // Head orientation: look target relative to the torso.
    _eul.set(-this.lookPitch.value, this.lookYaw.value, this.lookRoll.value, 'YXZ');
    _q2.setFromEuler(_eul);
    _q.copy(T.quat).multiply(_q2);
    orientationError(H.quat, _q, _a);
    const kph = 240, kdh = 22;
    H.angVel.x += (kph * _a.x - kdh * H.angVel.x) * h;
    H.angVel.y += (kph * _a.y - kdh * H.angVel.y) * h;
    H.angVel.z += (kph * _a.z - kdh * H.angVel.z) * h;

    T.integrate(h);
    H.integrate(h);

    // Never sink through the surface.
    const minY = this.groundY + B.torso[1] * 0.7;
    if (T.pos.y < minY) {
      T.pos.y = minY;
      if (T.vel.y < 0) T.vel.y *= -0.2;
    }
  }

  // ------------------------------------------------------------------
  // Behaviour queue: walk, jump, shake, wait, turn.
  do(action) {
    return new Promise((resolve) => this.actions.push({ ...action, resolve, t: 0, started: false }));
  }

  clearActions() {
    for (const a of this.actions) a.resolve?.();
    this.actions.length = 0;
  }

  get busy() {
    return this.actions.length > 0 || this.airborne;
  }

  _runActions(dt) {
    const a = this.actions[0];
    if (!a) return;
    a.t += dt;
    let done = false;
    const T = this.torso;
    switch (a.type) {
      case 'wait':
        done = a.t >= a.time;
        break;
      case 'walk': {
        const speed = a.speed ?? 0.55 + this.legLen * 0.6;
        const dx = a.to.x - this.targetPos.x, dz = a.to.z - this.targetPos.z;
        const dist = Math.hypot(dx, dz);
        const want = Math.atan2(dx, dz);
        const err = Math.atan2(Math.sin(want - this.heading), Math.cos(want - this.heading));
        if (dist > 0.02) {
          this.heading += clamp(err, -3.5 * dt, 3.5 * dt);
          if (Math.abs(err) < 1.1) {
            const step = Math.min(dist, speed * dt * (1 - Math.abs(err) / 1.4));
            this.targetPos.x += (dx / dist) * step;
            this.targetPos.z += (dz / dist) * step;
          }
        }
        done = dist <= 0.02 && T.pos.distanceTo(_a.set(this.targetPos.x, T.pos.y, this.targetPos.z)) < 0.05;
        if (a.t > 15) done = true;
        break;
      }
      case 'turn': {
        const err = Math.atan2(Math.sin(a.yaw - this.heading), Math.cos(a.yaw - this.heading));
        this.heading += clamp(err, -3 * dt, 3 * dt);
        done = Math.abs(err) < 0.03;
        break;
      }
      case 'jump': {
        if (!a.started) {
          a.started = true;
          a.phase = 'crouch';
          const want = Math.atan2(a.to.x - T.pos.x, a.to.z - T.pos.z);
          if (Math.hypot(a.to.x - T.pos.x, a.to.z - T.pos.z) > 0.15) a.yaw = want;
        }
        if (a.phase === 'crouch') {
          if (a.yaw != null) {
            const err = Math.atan2(Math.sin(a.yaw - this.heading), Math.cos(a.yaw - this.heading));
            this.heading += clamp(err, -4 * dt, 4 * dt);
          }
          this.crouch = -0.25 * this.B.stand * smoothstep(0, 0.25, a.t);
          if (a.t > 0.3) {
            // Launch on a ballistic arc to the landing spot.
            const tgt = new THREE.Vector3(a.to.x, a.groundY + this.B.stand, a.to.z);
            const d = tgt.clone().sub(T.pos);
            const horiz = Math.hypot(d.x, d.z);
            const Tf = 0.42 + horiz * 0.18 + Math.max(0, d.y) * 0.35;
            const v = new THREE.Vector3(d.x / Tf, (d.y + 0.5 * 9.81 * Tf * Tf) / Tf, d.z / Tf);
            T.vel.copy(v);
            this.head.vel.copy(v);
            this.crouch = 0;
            this.airborne = true;
            this.air = { t: 0, Tf, tgt, groundY: a.groundY };
            a.phase = 'fly';
            this.onEvent?.('jump', this);
          }
        } else if (a.phase === 'fly') {
          if (!this.airborne) {
            a.phase = 'land';
            a.t = 0;
          }
        } else if (a.phase === 'land') {
          done = a.t > 0.35;
        }
        break;
      }
      case 'shake': {
        if (!a.started) {
          a.started = true;
          this.shakeT = 0;
          this.shakeAmp = a.amp ?? 1;
          this.onEvent?.('shake', this);
        }
        done = this.shakeT < 0;
        break;
      }
    }
    if (done) {
      this.actions.shift();
      a.resolve();
    }
  }

  _updateAir(dt) {
    if (!this.airborne) return;
    const air = this.air;
    air.t += dt;
    const T = this.torso;
    // Steer gently toward the landing spot (dogs adjust mid-air).
    T.vel.x += (air.tgt.x - T.pos.x) * dt * 2;
    T.vel.z += (air.tgt.z - T.pos.z) * dt * 2;
    if ((air.t > air.Tf * 0.5 && T.pos.y <= air.tgt.y && T.vel.y < 0) || air.t > air.Tf * 2.5) {
      this.airborne = false;
      this.groundY = air.groundY;
      this.targetPos.set(air.tgt.x, air.tgt.y, air.tgt.z);
      for (const L of this.legs) {
        T.localToWorld(L.hip, L.hipW);
        L.plant.set(L.hipW.x, this.groundY, L.hipW.z);
        L.stepping = false;
      }
      // Landing squash: the vertical speed goes into the leg springs.
      T.vel.x *= 0.3;
      T.vel.z *= 0.3;
      this.onEvent?.('land', this);
    }
  }

  // ------------------------------------------------------------------
  // Mood, eyes, tail, idle looking.
  please(amount) {
    this.happiness = clamp(this.happiness + amount, 0, 1);
  }

  upset(amount) {
    this.happiness = clamp(this.happiness - amount, 0, 1);
    this.stress = Math.min(1, this.stress + amount * 3);
  }

  lookAt(point, hold = 1.5) {
    this.lookTarget = point.clone();
    this.lookTimer = hold;
  }

  _behaviour(dt, ctx) {
    const T = this.torso, H = this.head;
    this.stress = Math.max(0, this.stress - dt * 0.4);
    // Wag: happier dogs wag wider and faster; the hips wiggle along.
    const happy = this.happiness;
    this.wagAmp.target = (0.15 + happy * 0.85) * (1 - this.stress * 0.8) + (this.excited > 0 ? 0.4 : 0);
    this.excited = Math.max(0, (this.excited || 0) - dt);
    this.wagAmp.update(dt);
    this.wagPhase += dt * (6 + happy * 12 + (this.excited > 0 ? 6 : 0));
    this.wag = Math.sin(this.wagPhase) * this.wagAmp.value;
    this.wagHip = -this.wag * 0.08;
    this.tailLift.target = (happy - 0.45) * 0.8 - this.stress * 0.6;
    this.tailLift.update(dt);
    _eul.set(this.tailLift.value, this.wag, 0, 'YXZ');
    this.extraTail.setFromEuler(_eul);

    // Tongue out when content.
    this.tongue.target = happy > 0.7 && this.stress < 0.2 ? 1 : 0;
    this.tongue.update(dt);

    // Blink every few seconds, squint under water or wind.
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blink.value = 0.05;
      this.blinkTimer = 1.5 + Math.random() * 3.5;
    }
    this.blink.target = 1 - Math.min(0.85, this.squint);
    this.blink.update(dt);
    this.squint = Math.max(0, this.squint - dt * 2);

    // Where to look.
    this.lookTimer -= dt;
    let target = null;
    if (this.lookTarget && this.lookTimer > 0) target = this.lookTarget;
    else if (ctx.camera) {
      this.idleTimer = (this.idleTimer ?? 0) - dt;
      if (this.idleTimer <= 0) {
        this.idleTimer = 1.5 + Math.random() * 3;
        if (Math.random() < 0.6) this.lookIdle.copy(ctx.camera.position);
        else
          this.lookIdle
            .set(Math.random() - 0.5, Math.random() * 0.4 - 0.1, 1)
            .applyQuaternion(T.quat)
            .multiplyScalar(2)
            .add(T.pos);
        this.idleTilt = Math.random() < 0.3 ? (Math.random() < 0.5 ? -0.35 : 0.35) : 0;
      }
      target = this.lookIdle;
    }
    if (target) {
      _a.subVectors(target, H.pos);
      _q.copy(T.quat).invert();
      _a.applyQuaternion(_q);
      const yaw = Math.atan2(_a.x, _a.z);
      const pitch = Math.atan2(_a.y, Math.hypot(_a.x, _a.z));
      this.lookYaw.target = clamp(yaw, -1.1, 1.1);
      this.lookPitch.target = clamp(pitch, -0.7, 0.6) + 0.05;
    }
    this.lookRoll.target = (this.idleTilt ?? 0) * (1 - this.stress);
    if (this.flinchYaw) {
      this.lookYaw.target += this.flinchYaw;
      this.flinchYaw *= Math.exp(-dt * 3);
    }
    this.lookYaw.update(dt);
    this.lookPitch.update(dt);
    this.lookRoll.update(dt);
  }

  // ------------------------------------------------------------------
  update(dt, ctx = {}) {
    this.time += dt;
    this.crouch = this.crouch ?? 0;
    if (!this.actions.length || this.actions[0].type !== 'jump') this.crouch *= Math.exp(-dt * 8);
    this._runActions(dt);
    this._behaviour(dt, ctx);
    if (this.shakeT >= 0) {
      this.shakeT += dt;
      if (this.shakeT > 1.4) this.shakeT = -1;
    }
    this._updateAir(dt);

    const fur = this.fur;
    if (fur) {
      fur.ambient(dt);
      fur.computeLocalTargets(dt);
    }
    const sub = 4;
    const h = dt / sub;
    const collideTail = (p) => this.colliders.pushOut(p, 0.01);
    for (let i = 0; i < sub; i++) {
      this._stepBody(h);
      this._stepLegs(h);
      this.tail.step(h, this.torso, this.extraTail, null);
      this.earL.step(h, this.head, this.extraNone, null);
      this.earR.step(h, this.head, this.extraNone, null);
      this._collideChains();
      this._updateFrames();
      this._updateColliders();
      if (fur && i % 2 === 1) fur.step(h * 2, this.frames, this.colliders, this.groundY);
    }
    this.tail.clearWind();
    this.earL.clearWind();
    this.earR.clearWind();
    if (fur) {
      fur.endFrame();
      fur.buildHash();
    }
    this._syncVisuals(dt, ctx);
  }

  _collideChains() {
    // Ears stay outside the head, tail outside the body.
    const C = this.colliders;
    for (const ch of [this.earL, this.earR]) {
      for (let j = 1; j <= ch.n; j++) {
        _a.copy(ch.p[j]);
        const d = C.data, o = this.cHead * 16;
        const ex = _a.x - d[o + 1], ey = _a.y - d[o + 2], ez = _a.z - d[o + 3];
        const lx = (ex * d[o + 4] + ey * d[o + 5] + ez * d[o + 6]) / (d[o + 13] + 0.01);
        const ly = (ex * d[o + 7] + ey * d[o + 8] + ez * d[o + 9]) / (d[o + 14] + 0.01);
        const lz = (ex * d[o + 10] + ey * d[o + 11] + ez * d[o + 12]) / (d[o + 15] + 0.01);
        const q = lx * lx + ly * ly + lz * lz;
        if (q < 1 && q > 1e-6) {
          const k = 1 / Math.sqrt(q) - 1;
          ch.p[j].x += ex * k;
          ch.p[j].y += ey * k;
          ch.p[j].z += ez * k;
        }
      }
    }
    for (let j = 1; j <= this.tail.n; j++) {
      const p = this.tail.p[j];
      const d = C.data, o = this.cTorso * 16;
      const ex = p.x - d[o + 1], ey = p.y - d[o + 2], ez = p.z - d[o + 3];
      const lx = (ex * d[o + 4] + ey * d[o + 5] + ez * d[o + 6]) / (d[o + 13] + 0.02);
      const ly = (ex * d[o + 7] + ey * d[o + 8] + ez * d[o + 9]) / (d[o + 14] + 0.02);
      const lz = (ex * d[o + 10] + ey * d[o + 11] + ez * d[o + 12]) / (d[o + 15] + 0.02);
      const q = lx * lx + ly * ly + lz * lz;
      if (q < 1 && q > 1e-6) {
        const k = 1 / Math.sqrt(q) - 1;
        p.x += ex * k;
        p.y += ey * k;
        p.z += ez * k;
      }
      if (p.y < this.groundY + 0.01) p.y = this.groundY + 0.01;
    }
  }

  _stretch(mesh, a, b, r, rz = r) {
    _a.subVectors(b, a);
    const len = _a.length() || 1e-5;
    mesh.position.addVectors(a, b).multiplyScalar(0.5);
    _q.setFromUnitVectors(UP, _a.multiplyScalar(1 / len));
    mesh.quaternion.copy(_q);
    mesh.scale.set(r, len * 0.5 + r * 0.6, rz);
  }

  _syncVisuals(dt, ctx) {
    const B = this.B;
    this.vTorso.position.copy(this.torso.pos);
    this.vTorso.quaternion.copy(this.torso.quat);
    this.vTorso.scale.set(...B.torso);
    this.vHead.position.copy(this.head.pos);
    this.vHead.quaternion.copy(this.head.quat);
    this._stretch(this.vNeck, this.neckA, this.neckB, B.neckR);
    this.legs.forEach((L, i) => {
      const [u, l, p] = this.vLegs[i];
      this._stretch(u, L.hipW, L.knee, B.legR);
      this._stretch(l, L.knee, L.paw, B.legR * 0.88);
      p.position.copy(L.paw);
      p.position.y += B.legR * 0.35;
      p.quaternion.copy(this.torso.quat);
      p.scale.set(B.legR * 1.15, B.legR * 0.7, B.legR * 1.5);
    });
    for (let j = 0; j < this.tail.n; j++) this._stretch(this.vTail[j], this.tail.p[j], this.tail.p[j + 1], B.tail.r * (1 - j * 0.15));
    [this.earL, this.earR].forEach((ch, s) => {
      for (let j = 0; j < 2; j++) {
        const m = this.vEars[s][j];
        this._stretch(m, ch.p[j], ch.p[j + 1], B.ears.w * 0.5 * (1 - j * 0.2), B.ears.w * 0.18);
        // Orient the flat side of the ear along the head.
        _a.subVectors(ch.p[j + 1], ch.p[j]).normalize();
        this.head.dirToWorld(_b.set(1, 0, 0), _b);
        _c.crossVectors(_b, _a).normalize();
        _b.crossVectors(_a, _c).normalize();
        _m.makeBasis(_b, _a, _c);
        m.quaternion.setFromRotationMatrix(_m);
      }
    });
    // Eyes and tongue.
    const open = this.blink.value;
    for (const e of this.eyes) e.scale.set(1, Math.max(0.08, open), 1);
    const tv = Math.max(0, this.tongue.value);
    this.tonguePend.update(dt, this.head.vel.x * 0, 0);
    this.vTongue.visible = tv > 0.05;
    this.vTongue.position.copy(this.tongueBase).add(_a.set(0, -tv * 0.02, tv * 0.006));
    this.vTongue.rotation.set(0.9 + this.tonguePend.ax * 0.5 + Math.sin(this.time * 9) * 0.1, 0, this.tonguePend.az * 0.5);
    const tr = B.snout.r[0] * 0.5;
    this.vTongue.scale.set(tr * tv, tr * 1.6 * tv, tr * 0.3 * tv);

    // Skin darkens with mud and water.
    if (this.fur) {
      const st = this._statsCache;
      const dirt = st ? 1 - st.clean : 0;
      const wet = st ? st.wetAvg : 0;
      this.skinMat.color.copy(this.skinBase).multiplyScalar(1 - wet * 0.2).lerp(_mud, Math.min(0.8, dirt * 0.7));
      this.furView.update(ctx.hint);
    }
    this.bow?.update(dt, this);
  }

  refreshStats() {
    this._statsCache = this.fur.stats();
    return this._statsCache;
  }

  // Aim test against fur, then bare skin (for short-clipped dogs).
  raycast(origin, dir, maxT = 3) {
    const f = this.fur.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxT);
    let best = f ? f.t : maxT;
    let hit = f ? { t: f.t, s: f.s, region: this.fur.region[f.s] } : null;
    // Skin ellipsoids: torso, head.
    const tryEll = (body, center, r, region) => {
      _a.copy(origin).sub(center);
      _q.copy(body.quat).invert();
      _a.applyQuaternion(_q);
      _b.copy(dir).applyQuaternion(_q);
      _a.set(_a.x / r[0], _a.y / r[1], _a.z / r[2]);
      _b.set(_b.x / r[0], _b.y / r[1], _b.z / r[2]);
      const A = _b.dot(_b), Bq = 2 * _a.dot(_b), Cq = _a.dot(_a) - 1;
      const disc = Bq * Bq - 4 * A * Cq;
      if (disc < 0) return;
      const t = (-Bq - Math.sqrt(disc)) / (2 * A);
      if (t > 0 && t < best) {
        best = t;
        hit = { t, s: -1, region };
      }
    };
    tryEll(this.torso, this.torso.pos, this.B.torso, REGION.back);
    tryEll(this.head, this.head.pos, this.B.head.r, REGION.headtop);
    if (!hit) return null;
    hit.point = origin.clone().addScaledVector(dir, hit.t);
    return hit;
  }

  // Wind on ears, tail and the body itself (the dog leans into a strong dryer).
  blowChains(o, d, power, range) {
    for (const ch of [this.tail, this.earL, this.earR]) {
      for (let j = 1; j <= ch.n; j++) {
        _a.subVectors(ch.p[j], o);
        const dist = _a.length();
        if (dist > range) continue;
        const cos = _a.dot(d) / dist;
        if (cos < 0.85) continue;
        const f = power * (1 - dist / range) * smoothstep(0.85, 0.98, cos);
        ch.wind[j].addScaledVector(d, 120 * f).add(_b.set(Math.sin(this.time * 40 + j), Math.cos(this.time * 33), 0).multiplyScalar(30 * f));
      }
    }
  }

  dispose() {
    this.furView?.dispose();
    this.skinMat.dispose();
    this.group.removeFromParent();
  }
}

const _mud = new THREE.Color('#7A5A3C');
export { K };
