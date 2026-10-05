import * as THREE from 'three';
import { Spring3 } from '../core/springs.js';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();

// A satin bow clipped to the head. The loops wobble on a spring; the tails are verlet ribbons.
export class Bow {
  constructor(color, local, size = 1) {
    this.color = color;
    this.local = local.clone();
    this.group = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.05, side: THREE.DoubleSide });
    this.mat = m;
    const loopGeo = new THREE.TorusGeometry(0.026 * size, 0.011 * size, 8, 16);
    for (const s of [-1, 1]) {
      const loop = new THREE.Mesh(loopGeo, m);
      loop.position.x = s * 0.026 * size;
      loop.scale.set(1, 0.7, 0.55);
      loop.rotation.y = s * 0.3;
      loop.castShadow = true;
      this.group.add(loop);
    }
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.012 * size, 12, 8), m);
    knot.scale.set(1, 1.1, 0.8);
    this.group.add(knot);
    this.tails = [];
    this.tailMeshes = [];
    for (const s of [-1, 1]) {
      const pts = Array.from({ length: 4 }, () => new THREE.Vector3());
      const prev = pts.map((p) => p.clone());
      this.tails.push({ s, pts, prev, seg: 0.016 * size });
      const segs = [];
      for (let i = 0; i < 3; i++) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(0.012 * size, 1, 0.003), m);
        r.castShadow = true;
        segs.push(r);
      }
      this.tailMeshes.push(segs);
    }
    this.wobble = new Spring3(260, 9);
    this.placed = false;
    this.lastHeadVel = new THREE.Vector3();
  }

  attach(scene) {
    scene.add(this.group);
    for (const segs of this.tailMeshes) for (const s of segs) scene.add(s);
  }

  detach() {
    this.group.removeFromParent();
    for (const segs of this.tailMeshes) for (const s of segs) s.removeFromParent();
  }

  update(dt, dog) {
    const H = dog.head;
    H.localToWorld(this.local, _a);
    // The bow lags behind head acceleration (it is pinned with a springy clip).
    _b.subVectors(H.vel, this.lastHeadVel).multiplyScalar(-0.012 / Math.max(dt, 1e-3));
    this.lastHeadVel.copy(H.vel);
    this.wobble.velocity.add(_b.clampLength(0, 1.5));
    this.wobble.update(dt);
    this.group.position.copy(_a);
    _q.setFromEuler(new THREE.Euler(this.wobble.value.z * 3, 0, this.wobble.value.x * 3));
    this.group.quaternion.copy(H.quat).multiply(_q);

    // Ribbon tails hang from the knot.
    for (const t of this.tails) {
      H.localToWorld(_b.set(this.local.x + t.s * 0.008, this.local.y - 0.008, this.local.z), t.pts[0]);
      if (!this.placed) {
        for (let i = 1; i < 4; i++) {
          t.pts[i].copy(t.pts[0]).add(_a.set(t.s * 0.01 * i, -t.seg * i, 0));
          t.prev[i].copy(t.pts[i]);
        }
      }
      for (let i = 1; i < 4; i++) {
        const p = t.pts[i], pv = t.prev[i];
        const vx = (p.x - pv.x) * 0.94, vy = (p.y - pv.y) * 0.94, vz = (p.z - pv.z) * 0.94;
        pv.copy(p);
        p.x += vx;
        p.y += vy - 9.81 * dt * dt;
        p.z += vz;
        if (dog.windAt) {
          dog.windAt(p, _a.set(0, 0, 0));
          p.addScaledVector(_a, dt * dt * 0.3);
        }
      }
      for (let it = 0; it < 3; it++)
        for (let i = 1; i < 4; i++) {
          _a.subVectors(t.pts[i], t.pts[i - 1]);
          const l = _a.length() || 1e-6;
          t.pts[i].copy(t.pts[i - 1]).addScaledVector(_a, t.seg / l);
        }
    }
    this.placed = true;
    this.tailMeshes.forEach((segs, k) => {
      const t = this.tails[k];
      segs.forEach((m, i) => {
        const a = t.pts[i], b = t.pts[i + 1];
        _a.subVectors(b, a);
        const l = _a.length() || 1e-5;
        m.position.addVectors(a, b).multiplyScalar(0.5);
        _q.setFromUnitVectors(UP, _a.multiplyScalar(1 / l));
        m.quaternion.copy(_q);
        m.scale.set(1, l, 1);
      });
    });
  }

  setColor(c) {
    this.color = c;
    this.mat.color.set(c);
  }

  dispose() {
    this.detach();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
