import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler();
const _w = new THREE.Vector3();

// A loose bundle of hairs, about one unit long along Y: `crimp` 0 makes a snipped-off lock of
// nearly parallel hairs, 1 a crimped ball of undercoat fluff with hairs in every direction.
function bundleGeometry(fibers, crimp, seed) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) - 1) / 2147483646;
  const SEG = 4;
  const pos = [], nrm = [], idx = [];
  const d = new THREE.Vector3(), side = new THREE.Vector3(), bend = new THREE.Vector3(), p = new THREE.Vector3(), b = new THREE.Vector3();
  for (let f = 0; f < fibers; f++) {
    // Direction: within a narrow cone for a cut lock, anywhere for fluff.
    if (crimp > 0.5) d.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    else d.set((rnd() - 0.5) * 0.45, 1, (rnd() - 0.5) * 0.45).normalize();
    side.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(d).normalize();
    bend.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.5);
    const len = crimp > 0.5 ? 0.35 + rnd() * 0.25 : 0.75 + rnd() * 0.35;
    b.set((rnd() - 0.5) * 0.18, 0, (rnd() - 0.5) * 0.18);
    if (crimp <= 0.5) b.addScaledVector(d, -len * 0.5);
    const ph = rnd() * 6.28;
    const v0 = pos.length / 3;
    for (let k = 0; k <= SEG; k++) {
      const t = k / SEG;
      p.copy(b).addScaledVector(d, t * len).addScaledVector(bend, t * t * len);
      if (crimp > 0) p.addScaledVector(side, Math.sin(t * 14 + ph) * 0.05 * crimp);
      const w = 0.03 * (1 - 0.7 * t);
      pos.push(p.x - side.x * w, p.y - side.y * w, p.z - side.z * w, p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
      const n = new THREE.Vector3().crossVectors(side, d).normalize();
      nrm.push(n.x, n.y, n.z, n.x, n.y, n.z);
      if (k < SEG) {
        const a = v0 + k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

function bundleMesh(geo, material, cap, scene) {
  const mesh = new THREE.InstancedMesh(geo, material, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  mesh.geometry.setAttribute('aWet', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
  const n = new Float32Array(cap * 3);
  for (let i = 0; i < cap; i++) n[i * 3 + 1] = 1;
  mesh.geometry.setAttribute('aN', new THREE.InstancedBufferAttribute(n, 3));
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.count = 0;
  scene.add(mesh);
  return mesh;
}

// Clipped-off hair: light, draggy locks that flutter down, pile up on the table and the floor,
// and scatter again when the dryer catches them. Shed undercoat (`light` 1) is crimped fluff that
// drifts on the dryer's wind like dandelion seed before it settles.
export class Tufts {
  constructor(scene, material, cap = 1400) {
    this.cap = cap;
    this.items = [];
    material.side = THREE.DoubleSide;
    this.locks = bundleMesh(bundleGeometry(14, 0.15, 7), material, cap, scene);
    this.fluff = bundleMesh(bundleGeometry(22, 1, 11), material, cap, scene);
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
      const lift = t.r * (t.light ? 0.5 : 0.12);
      const s = world.surface(t.p.x, t.p.y - lift, t.p.z);
      if (s) {
        t.p.y = s.y + lift;
        if (s.kind === 'wall') {
          t.v.multiplyScalar(-0.2);
        } else {
          t.v.set(0, 0, 0);
          t.rest = true;
          t.spin.multiplyScalar(0);
          // A snipped lock settles flat.
          if (!t.light) {
            t.rot.x = Math.PI / 2;
            t.rot.z = 0;
          }
        }
      }
    }
    let nl = 0, nf = 0;
    for (const t of this.items) {
      const M = t.light ? this.fluff : this.locks;
      const i = t.light ? nf++ : nl++;
      _e.set(t.rot.x, t.rot.y, t.rot.z);
      _q.setFromEuler(_e);
      // A snipped lock lies down once it lands; fluff stays a round puff.
      _s.setScalar(t.r * (t.light ? 2.2 : 2.4));
      _m.compose(t.p, _q, _s);
      M.setMatrixAt(i, _m);
      const C = M.instanceColor.array;
      C[i * 3] = t.c[0];
      C[i * 3 + 1] = t.c[1];
      C[i * 3 + 2] = t.c[2];
    }
    for (const [M, n] of [[this.locks, nl], [this.fluff, nf]]) {
      M.count = n;
      M.instanceMatrix.needsUpdate = true;
      M.instanceColor.needsUpdate = true;
    }
  }

  // Sweep up between dogs.
  clear() {
    this.items.length = 0;
    this.locks.count = this.fluff.count = 0;
  }
}
