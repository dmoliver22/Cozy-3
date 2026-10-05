import * as THREE from 'three';

const CLEAR = new THREE.Color('#b8e6f2');
const MUDDY = new THREE.Color('#7A5A3C');
const _c = new THREE.Color();
const _p = new THREE.Vector3();

// Ballistic droplets. They soak and rinse fur where they land, pick up mud,
// then drip off the dog into the tub where they tint the runoff.
export class Water {
  constructor(scene, cap = 1800) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.dirt = new Float32Array(cap);
    this.state = new Uint8Array(cap); // 0 flying, 1 trickling over the dog, 2 leaving the dog
    this.size = new Float32Array(cap);
    const geo = new THREE.SphereGeometry(1, 8, 6);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.8, envMapIntensity: 1.8, emissive: '#8fd0e6', emissiveIntensity: 0.25,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.events = { tub: 0, tubDirt: 0, floor: [] };
    this.amount = 1;
    this.dogHits = 0;
    this.spawned = 0;
  }

  spawn(x, y, z, vx, vy, vz, dirt = 0, size = 0.006, state = 0) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.spawned++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = 3;
    this.dirt[i] = dirt;
    this.state[i] = state;
    this.size[i] = size;
  }

  _kill(i) {
    const j = --this.n;
    if (i === j) return;
    this.pos.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.vel.copyWithin(i * 3, j * 3, j * 3 + 3);
    this.life[i] = this.life[j];
    this.dirt[i] = this.dirt[j];
    this.state[i] = this.state[j];
    this.size[i] = this.size[j];
  }

  update(dt, world, dog, hooks) {
    const ev = this.events;
    ev.tub = 0;
    ev.tubDirt = 0;
    ev.floor.length = 0;
    const dogNear = dog && dog.fur;
    const dc = dogNear ? dog.torso.pos : null;
    this.frame = (this.frame || 0) + 1;
    for (let i = this.n - 1; i >= 0; i--) {
      const i3 = i * 3;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this._kill(i);
        continue;
      }
      let x = this.pos[i3], y = this.pos[i3 + 1], z = this.pos[i3 + 2];
      // Near the dog, sub-step so fast drops cannot tunnel through the coat.
      let sub = 1;
      if (dogNear && this.state[i] !== 2) {
        const dx = x - dc.x, dy = y - dc.y, dz = z - dc.z;
        if (dx * dx + dy * dy + dz * dz < 1.2 * 1.2) {
          const sp = Math.hypot(this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]);
          sub = Math.min(10, Math.max(1, Math.ceil((sp * dt) / 0.022)));
        }
      }
      const h = dt / sub;
      let dead = false;
      for (let k = 0; k < sub && !dead; k++) {
        this.vel[i3 + 1] -= 9.81 * h;
        x += this.vel[i3] * h;
        y += this.vel[i3 + 1] * h;
        z += this.vel[i3 + 2] * h;
        // State 2 drops (drips, dryer spray, shake spray) are leaving the dog: no re-wetting.
        if (dogNear && this.state[i] !== 2) {
          const dx = x - dc.x, dy = y - dc.y, dz = z - dc.z;
          if (dx * dx + dy * dy + dz * dz < 0.9 * 0.9) {
            if (this.state[i] === 0) {
              const carried = dog.fur.water(x, y, z, this.amount, this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]);
              let hit = carried >= 0;
              _p.set(x, y, z);
              if (dog.colliders.pushOut(_p, 0.004) >= 0) {
                hit = true;
                x = _p.x; y = _p.y; z = _p.z;
              }
              if (hit) {
                this.dogHits++;
                this.state[i] = 1;
                this.dirt[i] = Math.max(this.dirt[i], carried);
                hooks?.onDogHit?.(x, y, z, this.vel[i3], this.vel[i3 + 1], this.vel[i3 + 2]);
                // The coat soaks up most of the energy; the rest trickles down.
                this.vel[i3] *= 0.12;
                this.vel[i3 + 2] *= 0.12;
                this.vel[i3 + 1] = Math.min(this.vel[i3 + 1] * 0.1, -0.2);
                this.life[i] = Math.min(this.life[i], 1.6);
              }
            } else {
              // Trickling down the coat rinses what it passes (a little).
              if ((i + this.frame) % 3 === 0 && k === 0) {
                const c = dog.fur.water(x, y, z, 0.25 * this.amount, 0, -0.5, 0);
                if (c > this.dirt[i]) this.dirt[i] = c;
              }
              _p.set(x, y, z);
              if (dog.colliders.pushOut(_p, 0.004) >= 0) {
                x = _p.x; y = _p.y; z = _p.z;
                this.vel[i3] *= 0.8;
                this.vel[i3 + 2] *= 0.8;
              }
            }
          }
        }
        const hit = world.surface(x, y, z);
        if (hit) {
          if (hit.kind === 'tub' || hit.kind === 'tubwall') {
            ev.tub++;
            ev.tubDirt += this.dirt[i];
            hooks?.onSplash?.(x, hit.y, z, this.dirt[i], 'tub');
          } else if (hit.kind === 'floor' || hit.kind === 'table') {
            ev.floor.push(x, hit.y, z);
            hooks?.onSplash?.(x, hit.y, z, this.dirt[i], hit.kind);
          }
          dead = true;
        }
      }
      if (dead) {
        this._kill(i);
        continue;
      }
      this.pos[i3] = x;
      this.pos[i3 + 1] = y;
      this.pos[i3 + 2] = z;
    }
    this._render();
  }

  _render() {
    const M = this.mesh.instanceMatrix.array;
    const C = this.mesh.instanceColor.array;
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      const vx = this.vel[i3], vy = this.vel[i3 + 1], vz = this.vel[i3 + 2];
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1e-5;
      const r = this.size[i];
      const stretch = Math.min(5, 1 + sp * 0.35);
      // Align Y with the velocity so streaks follow their path.
      const yx = vx / sp, yy = vy / sp, yz = vz / sp;
      let xx, xy, xz;
      if (Math.abs(yy) < 0.9) { xx = yz; xy = 0; xz = -yx; } else { xx = 0; xy = -yz; xz = yy; }
      const xl = Math.hypot(xx, xy, xz) || 1;
      xx /= xl; xy /= xl; xz /= xl;
      const zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx;
      const o = i * 16;
      M[o] = xx * r; M[o + 1] = xy * r; M[o + 2] = xz * r; M[o + 3] = 0;
      M[o + 4] = yx * r * stretch; M[o + 5] = yy * r * stretch; M[o + 6] = yz * r * stretch; M[o + 7] = 0;
      M[o + 8] = zx * r; M[o + 9] = zy * r; M[o + 10] = zz * r; M[o + 11] = 0;
      M[o + 12] = this.pos[i3]; M[o + 13] = this.pos[i3 + 1]; M[o + 14] = this.pos[i3 + 2]; M[o + 15] = 1;
      _c.copy(CLEAR).lerp(MUDDY, Math.min(1, this.dirt[i] * 1.1));
      C[i3] = _c.r; C[i3 + 1] = _c.g; C[i3 + 2] = _c.b;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    this.n = 0;
    this.mesh.count = 0;
  }
}

// Shampoo gel: chunky pastel blobs lobbed from the bottle.
export class Gel {
  constructor(scene, cap = 80) {
    this.cap = cap;
    this.items = [];
    const geo = new THREE.SphereGeometry(1, 12, 8);
    const mat = new THREE.MeshStandardMaterial({ color: '#f6a8c8', roughness: 0.15, transparent: true, opacity: 0.85, emissive: '#f6a8c8', emissiveIntensity: 0.15 });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
  }

  spawn(p, v, r = 0.012) {
    if (this.items.length >= this.cap) return;
    this.items.push({ p: p.clone(), v: v.clone(), r, t: 0, wob: Math.random() * 6 });
  }

  update(dt, world, dog, onHit) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const g = this.items[i];
      g.t += dt;
      const sub = Math.max(1, Math.min(8, Math.ceil((g.v.length() * dt) / 0.025)));
      let hit = false;
      for (let k = 0; k < sub && !hit; k++) {
      g.v.y -= (9.81 * dt) / sub;
      g.p.addScaledVector(g.v, dt / sub);
      if (dog?.fur) {
        _p.copy(g.p);
        const near = dog.torso.pos.distanceTo(g.p) < 0.8;
        if (near) {
          // Touching fur?
          let touching = false;
          dog.fur.hash.query(g.p.x, g.p.y, g.p.z, 0.04, (j) => {
            if (touching) return;
            const j3 = j * 3;
            const dx = dog.fur.pos[j3] - g.p.x, dy = dog.fur.pos[j3 + 1] - g.p.y, dz = dog.fur.pos[j3 + 2] - g.p.z;
            if (dx * dx + dy * dy + dz * dz < 0.035 * 0.035) touching = true;
          });
          if (touching || dog.colliders.pushOut(_p, 0.005) >= 0) {
            onHit?.(g.p, 'dog');
            hit = true;
          }
        }
      }
      if (!hit) {
        const s = world.surface(g.p.x, g.p.y, g.p.z);
        if (s) {
          onHit?.(g.p, s.kind);
          hit = true;
        }
      }
      }
      if (hit || g.t > 4) this.items.splice(i, 1);
    }
    const M = this.mesh;
    this.items.forEach((g, i) => {
      const sq = 1 + Math.sin(g.t * 30 + g.wob) * 0.15;
      this._s.set(g.r * sq, g.r / sq, g.r * sq);
      this._m.compose(g.p, this._q, this._s);
      M.setMatrixAt(i, this._m);
    });
    M.count = this.items.length;
    M.instanceMatrix.needsUpdate = true;
  }
}
