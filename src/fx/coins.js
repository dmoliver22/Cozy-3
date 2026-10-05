import * as THREE from 'three';

const _e = new THREE.Euler();

// Coins tossed into the tip jar: ballistic arcs, spin, and clinking bounces off the glass.
export class Coins {
  constructor(scene, jar, audio) {
    this.jar = jar;
    this.audio = audio;
    this.items = [];
    this.geo = new THREE.CylinderGeometry(0.018, 0.018, 0.004, 18);
    this.mat = new THREE.MeshStandardMaterial({ color: '#f2c55c', metalness: 0.9, roughness: 0.25, emissive: '#5a3a00', emissiveIntensity: 0.15 });
    this.scene = scene;
    this.resting = 0;
  }

  // Toss n coins from `from` into the jar, staggered.
  toss(from, n) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const m = new THREE.Mesh(this.geo, this.mat);
        m.castShadow = true;
        this.scene.add(m);
        const p = from.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.1, 0, (Math.random() - 0.5) * 0.1));
        const tgt = new THREE.Vector3(this.jar.x + (Math.random() - 0.5) * 0.03, this.jar.y + 0.25, this.jar.z + (Math.random() - 0.5) * 0.03);
        const T = 0.7;
        const v = new THREE.Vector3((tgt.x - p.x) / T, (tgt.y - p.y + 0.5 * 9.81 * T * T) / T, (tgt.z - p.z) / T);
        this.items.push({ m, p, v, rot: new THREE.Vector3(), spin: new THREE.Vector3(Math.random() * 20, Math.random() * 20, 0), rest: false, bounces: 0 });
      }, i * 90);
    }
  }

  update(dt) {
    const J = this.jar;
    for (const c of this.items) {
      if (c.rest) continue;
      c.v.y -= 9.81 * dt;
      c.p.addScaledVector(c.v, dt);
      c.rot.addScaledVector(c.spin, dt);
      const dx = c.p.x - J.x, dz = c.p.z - J.z;
      const r = Math.hypot(dx, dz);
      // Inside the jar: bounce off the glass wall.
      if (c.p.y < J.y + J.h && r > J.r - 0.018 && r < J.r + 0.03 && c.p.y > J.y) {
        const nx = dx / r, nz = dz / r;
        const vn = c.v.x * nx + c.v.z * nz;
        if (vn > 0) {
          c.v.x -= 1.6 * vn * nx;
          c.v.z -= 1.6 * vn * nz;
          this.audio.clink(0.6);
        }
        c.p.x = J.x + nx * (J.r - 0.018);
        c.p.z = J.z + nz * (J.r - 0.018);
      }
      // Pile height grows as coins collect.
      const floor = J.y + 0.004 + Math.min(0.12, this.resting * 0.0035);
      if (c.p.y < floor && r < J.r) {
        c.p.y = floor;
        if (Math.abs(c.v.y) > 0.4 && c.bounces < 3) {
          c.v.y *= -0.35;
          c.v.x *= 0.5;
          c.v.z *= 0.5;
          c.bounces++;
          this.audio.coin(0);
        } else {
          c.rest = true;
          this.resting++;
          c.rot.set(Math.PI / 2 + (Math.random() - 0.5) * 0.4, c.rot.y, (Math.random() - 0.5) * 0.4);
        }
      }
      if (c.p.y < -1) c.rest = true;
    }
    for (const c of this.items) {
      c.m.position.copy(c.p);
      _e.set(c.rot.x, c.rot.y, c.rot.z);
      c.m.rotation.copy(_e);
    }
    // Keep the jar from overflowing with meshes.
    while (this.items.length > 60) {
      const old = this.items.shift();
      old.m.removeFromParent();
      this.resting = Math.max(0, this.resting - 1);
    }
  }
}
