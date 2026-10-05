import * as THREE from 'three';

const _t = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

// A minimal rigid body: semi-implicit Euler, diagonal inertia, world-space angular velocity.
// Dogs are a torso and a head built from these, held up by PD "muscles".
export class RigidBody {
  constructor(mass = 1, inertia = new THREE.Vector3(0.05, 0.05, 0.05)) {
    this.mass = mass;
    this.invMass = 1 / mass;
    this.invInertia = new THREE.Vector3(1 / inertia.x, 1 / inertia.y, 1 / inertia.z);
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();
    this.force = new THREE.Vector3();
    this.torque = new THREE.Vector3();
    this.linDamping = 0.6;
    this.angDamping = 1.5;
    this.matrix = new THREE.Matrix4();
  }

  // Apply I^-1 (world) to a vector in place.
  applyInvInertia(v) {
    _qa.copy(this.quat).invert();
    v.applyQuaternion(_qa);
    v.x *= this.invInertia.x;
    v.y *= this.invInertia.y;
    v.z *= this.invInertia.z;
    v.applyQuaternion(this.quat);
    return v;
  }

  addForce(f, point) {
    this.force.add(f);
    if (point) {
      _t.subVectors(point, this.pos).cross(f);
      this.torque.add(_t);
    }
  }

  addTorque(t) {
    this.torque.add(t);
  }

  impulse(j, point) {
    this.vel.addScaledVector(j, this.invMass);
    if (point) {
      _t.subVectors(point, this.pos).cross(j);
      this.applyInvInertia(_t);
      this.angVel.add(_t);
    }
  }

  // Linear acceleration (mass independent) – used by the PD controllers.
  accelerate(a, dt) {
    this.vel.addScaledVector(a, dt);
  }

  angularAccelerate(a, dt) {
    this.angVel.addScaledVector(a, dt);
  }

  velocityAt(point, out) {
    _t.subVectors(point, this.pos);
    return out.crossVectors(this.angVel, _t).add(this.vel);
  }

  integrate(dt) {
    this.vel.addScaledVector(this.force, this.invMass * dt);
    _t2.copy(this.torque);
    this.applyInvInertia(_t2);
    this.angVel.addScaledVector(_t2, dt);

    this.vel.multiplyScalar(Math.exp(-this.linDamping * dt));
    this.angVel.multiplyScalar(Math.exp(-this.angDamping * dt));

    this.pos.addScaledVector(this.vel, dt);

    const w = this.angVel;
    _qb.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(this.quat);
    this.quat.x += _qb.x;
    this.quat.y += _qb.y;
    this.quat.z += _qb.z;
    this.quat.w += _qb.w;
    this.quat.normalize();

    this.force.set(0, 0, 0);
    this.torque.set(0, 0, 0);
  }

  updateMatrix() {
    this.matrix.compose(this.pos, this.quat, ONE);
    return this.matrix;
  }

  localToWorld(local, out) {
    return out.copy(local).applyQuaternion(this.quat).add(this.pos);
  }

  dirToWorld(local, out) {
    return out.copy(local).applyQuaternion(this.quat);
  }
}

const ONE = new THREE.Vector3(1, 1, 1);

// Angular PD toward a target orientation. Returns desired angular acceleration in `out`.
const _qe = new THREE.Quaternion();
export function orientationError(current, target, out) {
  _qe.copy(target).multiply(_qa.copy(current).invert());
  if (_qe.w < 0) {
    _qe.x = -_qe.x;
    _qe.y = -_qe.y;
    _qe.z = -_qe.z;
    _qe.w = -_qe.w;
  }
  const s = Math.sqrt(1 - Math.min(1, _qe.w * _qe.w));
  if (s < 1e-5) return out.set(0, 0, 0);
  const angle = 2 * Math.acos(Math.min(1, _qe.w));
  return out.set(_qe.x / s, _qe.y / s, _qe.z / s).multiplyScalar(angle);
}
