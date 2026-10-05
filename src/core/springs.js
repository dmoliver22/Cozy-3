import * as THREE from 'three';

// Damped harmonic oscillators. Every "animation" in the game is one of these:
// a value with velocity pulled toward a target, so things overshoot, settle and wobble.

export class Spring {
  constructor(value = 0, stiffness = 120, damping = 12) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.k = stiffness;
    this.c = damping;
  }
  impulse(v) {
    this.velocity += v;
    return this;
  }
  snap(v) {
    this.value = this.target = v;
    this.velocity = 0;
    return this;
  }
  update(dt) {
    // Sub-step so stiff UI springs stay stable at low frame rates.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = this.k * (this.target - this.value) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

export class Spring3 {
  constructor(stiffness = 120, damping = 12) {
    this.value = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.k = stiffness;
    this.c = damping;
  }
  snap(v) {
    this.value.copy(v);
    this.target.copy(v);
    this.velocity.set(0, 0, 0);
    return this;
  }
  update(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    const v = this.value, t = this.target, vel = this.velocity, k = this.k, c = this.c;
    for (let i = 0; i < steps; i++) {
      vel.x += (k * (t.x - v.x) - c * vel.x) * h;
      vel.y += (k * (t.y - v.y) - c * vel.y) * h;
      vel.z += (k * (t.z - v.z) - c * vel.z) * h;
      v.x += vel.x * h;
      v.y += vel.y * h;
      v.z += vel.z * h;
    }
    return v;
  }
}

// A pendulum hanging from a pivot: used for lamps, the door bell, polaroids and tags.
export class Pendulum {
  constructor(length = 0.3, damping = 0.6) {
    this.len = length;
    this.damping = damping;
    this.ax = 0; // swing around x
    this.az = 0; // swing around z
    this.vx = 0;
    this.vz = 0;
    this.k = 9.81 / length;
  }
  push(fx, fz) {
    this.vx += fx;
    this.vz += fz;
  }
  update(dt, pivotAccelX = 0, pivotAccelZ = 0) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.vx += (-this.k * Math.sin(this.ax) - this.damping * this.vx + pivotAccelZ / this.len) * h;
      this.vz += (-this.k * Math.sin(this.az) - this.damping * this.vz - pivotAccelX / this.len) * h;
      this.ax += this.vx * h;
      this.az += this.vz * h;
    }
  }
}
