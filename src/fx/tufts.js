import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const _w = new THREE.Vector3();

// Clipped-off fur: light, draggy tufts that flutter down, pile up on the table and the floor,
// and scatter again when the dryer catches them. Shed undercoat is lighter still (`light` 1): it
// drifts on the dryer's wind like dandelion fluff before it settles.
export class Tufts {
  constructor(scene, material, cap = 1400) {
    this.cap = cap;
    this.items = [];
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    const wet = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.mesh.geometry.setAttribute('aWet', wet);
    const n = new Float32Array(cap * 3);
    for (let i = 0; i < cap; i++) n[i * 3 + 1] = 1;
    this.mesh.geometry.setAttribute('aN', new THREE.InstancedBufferAttribute(n, 3));
    this.mesh.geometry.setAttribute('aGloss', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    scene.add(this.mesh);
  }

  spawn(x, y, z, vx, vy, vz, r, color, light = 0) {
    if (this.items.length >= this.cap) this.items.shift();
    this.items.push({
      light,
      p: new THREE.Vector3(x, y, z),
      v: new THREE.Vector3(vx, vy, vz),
      r: Math.max(0.006, r),
      c: color,
      rest: false,
      rot: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
      spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      seed: Math.random() * 100,
      flat: light ? 0.75 + Math.random() * 0.25 : 0.55 + Math.random() * 0.3,
    });
  }

  update(dt, time, world, dog, wind) {
    for (const t of this.items) {
      _w.set(0, 0, 0);
      wind?.(t.p, _w);
      if (t.rest) {
        // Settled tufts only move if the dryer is strong enough to lift them.
        if (_w.lengthSq() > (t.light ? 12 : 30)) {
          t.rest = false;
          t.v.set(_w.x * 0.02, 0.4 + Math.random() * 0.4, _w.z * 0.02);
        } else continue;
      }
      // Fur falls like a feather: heavy drag, a little flutter. Undercoat fluff barely falls at all.
      const L = t.light, catchWind = 0.9 + L * 0.7;
      t.v.y -= 9.81 * (1 - 0.72 * L) * dt;
      t.v.x += (_w.x * catchWind + Math.sin(time * 6 + t.seed) * (1.2 + L)) * dt;
      t.v.y += _w.y * catchWind * dt;
      t.v.z += (_w.z * catchWind + Math.cos(time * 5 + t.seed) * (1.2 + L)) * dt;
      const drag = Math.exp(-(4.2 + L * 2.5) * dt);
      t.v.multiplyScalar(drag);
      t.p.addScaledVector(t.v, dt);
      t.rot.addScaledVector(t.spin, dt);
      if (dog) {
        _p.copy(t.p);
        if (dog.colliders.pushOut(_p, t.r * 0.5) >= 0) {
          t.p.copy(_p);
          t.v.multiplyScalar(0.5);
        }
      }
      const s = world.surface(t.p.x, t.p.y - t.r * 0.4, t.p.z);
      if (s) {
        t.p.y = s.y + t.r * 0.4;
        if (s.kind === 'wall') {
          t.v.multiplyScalar(-0.2);
        } else {
          t.v.set(0, 0, 0);
          t.rest = true;
          t.spin.multiplyScalar(0);
        }
      }
    }
    const M = this.mesh;
    const C = M.instanceColor.array;
    this.items.forEach((t, i) => {
      _e.set(t.rot.x, t.rot.y, t.rot.z);
      _q.setFromEuler(_e);
      _s.set(t.r, t.r * t.flat, t.r * 1.2);
      _m.compose(t.p, _q, _s);
      M.setMatrixAt(i, _m);
      C[i * 3] = t.c[0];
      C[i * 3 + 1] = t.c[1];
      C[i * 3 + 2] = t.c[2];
    });
    M.count = this.items.length;
    M.instanceMatrix.needsUpdate = true;
    M.instanceColor.needsUpdate = true;
  }

  // Sweep: everything on the floor drifts toward the drain corner and vanishes.
  clear() {
    this.items.length = 0;
    this.mesh.count = 0;
  }
}
