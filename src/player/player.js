import * as THREE from 'three';
import { Spring } from '../core/springs.js';
import { clamp } from '../core/math.js';
import { ROOM } from '../world/salon.js';

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');

export class Player {
  constructor(camera, salon) {
    this.camera = camera;
    this.salon = salon;
    this.pos = new THREE.Vector3(0.1, 0, -0.35);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.32;
    this.eye = new Spring(1.62, 90, 16);
    this.bob = new Spring(0, 160, 14);
    this.roll = new Spring(0, 70, 12);
    this.stepPhase = 0;
    this.radius = 0.28;
    this.sens = 0.0022;
    this.lookVel = [0, 0];
    this.onStep = null;
  }

  update(dt, input, frozen = false) {
    const [dx, dy] = input.consumeLook();
    this.lookVel = [dx / Math.max(dt, 1e-3), dy / Math.max(dt, 1e-3)];
    if (!frozen) {
      this.yaw -= dx * this.sens;
      this.pitch = clamp(this.pitch - dy * this.sens, -1.4, 1.35);
      // Arrow keys also look (handy on trackpads).
      if (input.down('ArrowLeft')) this.yaw += dt * 1.8;
      if (input.down('ArrowRight')) this.yaw -= dt * 1.8;
      if (input.down('ArrowUp')) this.pitch = clamp(this.pitch + dt * 1.4, -1.4, 1.35);
      if (input.down('ArrowDown')) this.pitch = clamp(this.pitch - dt * 1.4, -1.4, 1.35);
    }

    // Movement with a little inertia.
    let mx = 0, mz = 0;
    if (!frozen) {
      if (input.down('KeyW')) mz += 1;
      if (input.down('KeyS')) mz -= 1;
      if (input.down('KeyA')) mx -= 1;
      if (input.down('KeyD')) mx += 1;
      mx += input.move.x;
      mz -= input.move.y;
    }
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }
    _f.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _r.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const crouch = !frozen && (input.down('KeyC') || input.down('ControlLeft'));
    const speed = crouch ? 1.2 : 2.1;
    const wx = (_f.x * mz + _r.x * mx) * speed, wz = (_f.z * mz + _r.z * mx) * speed;
    const k = 1 - Math.exp(-dt * 10);
    this.vel.x += (wx - this.vel.x) * k;
    this.vel.z += (wz - this.vel.z) * k;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this._collide();

    // Head bob from footsteps, sway when strafing, crouch on a spring.
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp > 0.2) {
      const before = Math.sin(this.stepPhase);
      this.stepPhase += dt * sp * 4.2;
      const after = Math.sin(this.stepPhase);
      if (before > 0 !== after > 0) {
        this.bob.velocity -= 0.25 * sp;
        this.onStep?.(sp);
      }
    }
    this.bob.update(dt);
    this.eye.target = crouch ? 1.12 : 1.62;
    this.eye.update(dt);
    const side = this.vel.x * _r.x + this.vel.z * _r.z;
    this.roll.target = -side * 0.012 - clamp(this.lookVel[0] * 0.000015, -0.03, 0.03);
    this.roll.update(dt);

    this.camera.position.set(this.pos.x, this.eye.value + this.bob.value * 0.04, this.pos.z);
    _e.set(this.pitch, this.yaw, this.roll.value);
    this.camera.quaternion.setFromEuler(_e);
  }

  _collide() {
    const r = this.radius;
    const p = this.pos;
    p.x = clamp(p.x, ROOM.x0 + r, ROOM.x1 - r);
    p.z = clamp(p.z, ROOM.z0 + r, ROOM.z1 - r - 0.05);
    for (const b of this.salon.colliders) {
      // Circle vs AABB push-out.
      const cx = clamp(p.x, b.x0, b.x1), cz = clamp(p.z, b.z0, b.z1);
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          p.x = cx + (dx / d) * r;
          p.z = cz + (dz / d) * r;
        } else {
          // Inside: push out along the shallowest axis.
          const opts = [[b.x0 - r - p.x, 0], [b.x1 + r - p.x, 0], [0, b.z0 - r - p.z], [0, b.z1 + r - p.z]];
          opts.sort((a, c) => Math.abs(a[0] + a[1]) - Math.abs(c[0] + c[1]));
          p.x += opts[0][0];
          p.z += opts[0][1];
        }
      }
    }
  }

  // Aim ray: screen centre when locked, the cursor otherwise.
  aim(input, origin, dir) {
    this.camera.getWorldPosition(origin);
    if (input.freeAim) {
      const ndc = new THREE.Vector3(input.cursorX * 2 - 1, -(input.cursorY * 2 - 1), 0.5);
      ndc.unproject(this.camera);
      dir.copy(ndc).sub(origin).normalize();
    } else {
      this.camera.getWorldDirection(dir);
    }
  }

  // Snap to look at a point (used when stations change).
  face(point, pitchBias = 0) {
    const dx = point.x - this.pos.x, dz = point.z - this.pos.z;
    this.yaw = Math.atan2(-dx, -dz);
    const dy = point.y - this.eye.value;
    this.pitch = Math.atan2(dy, Math.hypot(dx, dz)) + pitchBias;
  }
}
