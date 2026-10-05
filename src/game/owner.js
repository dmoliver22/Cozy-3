import * as THREE from 'three';
import { Spring, Spring3 } from '../core/springs.js';

const _a = new THREE.Vector3();

// Owners are round, bouncy bean people. Position follows a path on a spring, the body leans
// into acceleration and the head bobbles on its own spring.
export class Owner {
  constructor(spec) {
    this.spec = spec;
    this.group = new THREE.Group();
    const coat = new THREE.MeshStandardMaterial({ color: spec.coat, roughness: 0.75 });
    const skin = new THREE.MeshStandardMaterial({ color: spec.skin, roughness: 0.7 });
    const hatM = new THREE.MeshStandardMaterial({ color: spec.hat, roughness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.3 });
    const cheekM = new THREE.MeshStandardMaterial({ color: '#f29a9a', roughness: 0.8 });

    this.bodyPivot = new THREE.Group();
    this.group.add(this.bodyPivot);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.62, 6, 16), coat);
    body.position.y = 0.55;
    body.castShadow = true;
    this.bodyPivot.add(body);
    // Raincoat buttons.
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), hatM);
      b.position.set(0, 0.45 + i * 0.13, 0.235);
      this.bodyPivot.add(b);
    }
    this.headPivot = new THREE.Group();
    this.headPivot.position.y = 1.18;
    this.bodyPivot.add(this.headPivot);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 20, 14), skin);
    head.position.y = 0.16;
    head.castShadow = true;
    this.headPivot.add(head);
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), hatM);
    hat.position.y = 0.22;
    hat.scale.set(1.02, 0.85, 1.02);
    this.headPivot.add(hat);
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), hatM);
    pom.position.y = 0.4;
    this.headPivot.add(pom);
    this.pom = pom;
    this.eyes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), dark);
      e.position.set(s * 0.07, 0.17, 0.17);
      e.scale.set(1, 1.3, 0.6);
      this.headPivot.add(e);
      this.eyes.push(e);
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), cheekM);
      c.position.set(s * 0.11, 0.1, 0.15);
      c.scale.set(1, 0.6, 0.4);
      this.headPivot.add(c);
    }
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 12, Math.PI), dark);
    mouth.position.set(0, 0.1, 0.18);
    mouth.rotation.z = Math.PI;
    this.headPivot.add(mouth);
    this.mouth = mouth;
    // Arms swing as pendulums.
    this.arms = [];
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(s * 0.25, 0.85, 0);
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.32, 4, 8), coat);
      arm.position.y = -0.2;
      arm.castShadow = true;
      pivot.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), skin);
      hand.position.y = -0.4;
      pivot.add(hand);
      this.bodyPivot.add(pivot);
      this.arms.push({ pivot, a: 0, v: 0, side: s });
    }
    // A dripping folded umbrella.
    const umb = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.6, 10), new THREE.MeshStandardMaterial({ color: spec.hat, roughness: 0.5 }));
    umb.position.set(0, -0.62, 0.02);
    umb.rotation.x = Math.PI;
    this.arms[0].pivot.add(umb);

    this.pos = new Spring3(30, 9);
    this.yaw = new Spring(0, 40, 10);
    this.lean = new Spring3(80, 9);
    this.head = new Spring3(140, 7);
    this.hopY = new Spring(0, 160, 9);
    this.target = new THREE.Vector3();
    this.path = [];
    this.resolveWalk = null;
    this.time = Math.random() * 10;
    this.blink = 0;
    this.happy = 0;
    this.prevVel = new THREE.Vector3();
  }

  place(p, yaw = 0) {
    this.pos.snap(p);
    this.target.copy(p);
    this.yaw.snap(yaw);
    this.group.position.copy(p);
  }

  walk(points) {
    this.path = points.map((p) => p.clone());
    return new Promise((r) => (this.resolveWalk = r));
  }

  hop(n = 1) {
    for (let i = 0; i < n; i++) setTimeout(() => (this.hopY.velocity += 2.6), i * 260);
  }

  update(dt, lookAt) {
    this.time += dt;
    // Advance along the path at walking pace.
    if (this.path.length) {
      const next = this.path[0];
      _a.subVectors(next, this.target);
      _a.y = 0;
      const d = _a.length();
      const step = 1.0 * dt;
      if (d <= step) {
        this.target.copy(next);
        this.path.shift();
        if (!this.path.length) {
          this.resolveWalk?.();
          this.resolveWalk = null;
        }
      } else {
        this.target.addScaledVector(_a, step / d);
        this.yaw.target = Math.atan2(_a.x, _a.z);
      }
    } else if (lookAt) {
      _a.subVectors(lookAt, this.group.position);
      this.yaw.target = Math.atan2(_a.x, _a.z);
    }
    // Unwrap yaw so it turns the short way.
    while (this.yaw.target - this.yaw.value > Math.PI) this.yaw.target -= Math.PI * 2;
    while (this.yaw.target - this.yaw.value < -Math.PI) this.yaw.target += Math.PI * 2;

    this.pos.target.copy(this.target);
    this.pos.update(dt);
    this.yaw.update(dt);
    this.hopY.update(dt);
    // Lean into acceleration.
    const acc = _a.subVectors(this.pos.velocity, this.prevVel).multiplyScalar(1 / Math.max(dt, 1e-3));
    this.prevVel.copy(this.pos.velocity);
    // Into the owner's local frame.
    const cy = Math.cos(this.yaw.value), sy = Math.sin(this.yaw.value);
    const alx = acc.x * cy - acc.z * sy, alz = acc.x * sy + acc.z * cy;
    const v = this.pos.velocity;
    const vlx = v.x * cy - v.z * sy, vlz = v.x * sy + v.z * cy;
    this.lean.target.set(alz * 0.012 + vlz * 0.05, 0, -alx * 0.012 - vlx * 0.05);
    this.lean.update(dt);
    // Head bobble driven by the body's motion.
    this.head.velocity.x -= acc.z * dt * 0.08;
    this.head.velocity.z += acc.x * dt * 0.08;
    const speed = Math.hypot(this.pos.velocity.x, this.pos.velocity.z);
    const walkBob = speed > 0.1 ? Math.abs(Math.sin(this.time * 9)) * 0.04 : 0;
    this.head.target.set(0, 0, 0);
    this.head.update(dt);

    this.group.position.set(this.pos.value.x, walkBob + Math.max(0, this.hopY.value), this.pos.value.z);
    this.group.rotation.y = this.yaw.value;
    this.bodyPivot.rotation.set(this.lean.value.x, 0, this.lean.value.z);
    this.headPivot.rotation.set(this.head.value.x + Math.sin(this.time * 1.3) * 0.03, 0, this.head.value.z + Math.sin(this.time * 0.9) * 0.04);
    this.pom.position.x = -this.head.value.z * 0.2;
    for (const arm of this.arms) {
      const swing = speed > 0.1 ? Math.sin(this.time * 9 + (arm.side > 0 ? Math.PI : 0)) * 0.5 : 0;
      const wave = this.happy > 0 && arm.side > 0 ? -2.4 + Math.sin(this.time * 14) * 0.4 : 0;
      arm.v += (60 * (swing + wave - arm.a) - 6 * arm.v) * dt;
      arm.a += arm.v * dt;
      arm.pivot.rotation.x = arm.a;
      arm.pivot.rotation.z = arm.side * (0.1 + (wave ? 0.3 : 0));
    }
    this.happy = Math.max(0, this.happy - dt);
    // Blink.
    this.blink -= dt;
    const closed = this.blink < 0.12 && this.blink > 0;
    if (this.blink < 0) this.blink = 2 + Math.random() * 3;
    for (const e of this.eyes) e.scale.y = closed ? 0.2 : 1.3;
  }

  // World position above the head, for the speech bubble.
  speechAnchor(out) {
    return out.copy(this.group.position).add(_a.set(0, 1.85, 0));
  }

  dispose() {
    this.group.removeFromParent();
  }
}
