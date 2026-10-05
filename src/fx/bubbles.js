import * as THREE from 'three';

const vert = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying float vSeed;
  void main() {
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec4 mv = viewMatrix * wp;
    vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
    vV = normalize(-mv.xyz);
    vSeed = instanceMatrix[3].x * 13.0 + instanceMatrix[3].z * 7.0;
    gl_Position = projectionMatrix * mv;
  }
`;
const frag = /* glsl */ `
  uniform float uTime;
  varying vec3 vN;
  varying vec3 vV;
  varying float vSeed;
  vec3 hue(float h) {
    return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  }
  void main() {
    vec3 n = normalize(vN);
    float f = 1.0 - abs(dot(n, normalize(vV)));
    vec3 film = mix(vec3(1.0), hue(f * 1.6 + uTime * 0.15 + vSeed), 0.45);
    vec3 L = normalize(vec3(-0.4, 0.8, 0.5));
    float spec = pow(max(dot(reflect(-L, n), normalize(vV)), 0.0), 40.0);
    float a = 0.06 + pow(f, 2.2) * 0.75 + spec * 0.9;
    gl_FragColor = vec4(film * (0.9 + spec), clamp(a, 0.0, 0.95));
  }
`;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

// Soap bubbles: some cling to lathered fur, others float free on buoyancy and dryer wind, then pop.
export class Bubbles {
  constructor(scene, cap = 600) {
    this.cap = cap;
    this.items = [];
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), this.material, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.pops = 0;
  }

  // A bubble stuck to a fur particle.
  stick(particle, fur, r = 0.006 + Math.random() * 0.016) {
    if (this.items.length >= this.cap) return;
    const p3 = particle * 3;
    this.items.push({
      stuck: particle, fur,
      off: new THREE.Vector3((Math.random() - 0.5) * 0.03, Math.random() * 0.02, (Math.random() - 0.5) * 0.03),
      p: new THREE.Vector3(fur.pos[p3], fur.pos[p3 + 1], fur.pos[p3 + 2]),
      v: new THREE.Vector3(),
      r, life: 6 + Math.random() * 10, grow: 0, wob: Math.random() * 10,
    });
  }

  free(p, v, r = 0.008 + Math.random() * 0.02, life = 2 + Math.random() * 4) {
    if (this.items.length >= this.cap) this.items.shift();
    this.items.push({ stuck: -1, p: p.clone(), v: v.clone(), off: null, r, life, grow: 0, wob: Math.random() * 10 });
  }

  // wind(p, out) adds dryer wind acceleration at p.
  update(dt, time, world, wind, onPop) {
    this.material.uniforms.uTime.value = time;
    this.pops = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const b = this.items[i];
      b.life -= dt;
      b.grow = Math.min(1, b.grow + dt * 6);
      if (b.stuck >= 0) {
        const f = b.fur;
        const s = (b.stuck / f.K) | 0;
        const p3 = b.stuck * 3;
        const tx = f.pos[p3] + b.off.x, ty = f.pos[p3 + 1] + b.off.y, tz = f.pos[p3 + 2] + b.off.z;
        b.v.set((tx - b.p.x) / Math.max(dt, 1e-3), (ty - b.p.y) / Math.max(dt, 1e-3), (tz - b.p.z) / Math.max(dt, 1e-3));
        b.p.set(tx, ty, tz);
        // Rinsed or blown away: let go and float.
        _p.set(0, 0, 0);
        wind?.(b.p, _p);
        if (f.lather[s] < 0.12 || _p.lengthSq() > 40 || b.life < 0) {
          b.stuck = -1;
          b.v.multiplyScalar(0.3).add(_p.multiplyScalar(0.02));
          b.v.y += 0.15;
          b.life = 1.5 + Math.random() * 3;
        }
        continue;
      }
      // Free bubble: buoyancy, drag, wobble, wind.
      _p.set(0, 0, 0);
      wind?.(b.p, _p);
      b.v.x += (_p.x * 0.6 + Math.sin(time * 2 + b.wob) * 0.12) * dt;
      b.v.y += (0.32 + _p.y * 0.6) * dt;
      b.v.z += (_p.z * 0.6 + Math.cos(time * 1.7 + b.wob) * 0.12) * dt;
      const drag = Math.exp(-2.2 * dt);
      b.v.multiplyScalar(drag);
      b.p.addScaledVector(b.v, dt);
      const s = world.surface(b.p.x, b.p.y - b.r, b.p.z);
      const ceiling = b.p.y > world.ceiling - 0.05;
      if (b.life <= 0 || s || ceiling) {
        this.items.splice(i, 1);
        this.pops++;
        onPop?.(b.p, b.r);
      }
    }
    const M = this.mesh;
    let n = 0;
    for (const b of this.items) {
      const wob = 1 + Math.sin(time * 9 + b.wob) * 0.06;
      const r = b.r * b.grow;
      _s.set(r * wob, r / wob, r * wob);
      _m.compose(b.p, _q, _s);
      M.setMatrixAt(n++, _m);
    }
    M.count = n;
    M.instanceMatrix.needsUpdate = true;
  }

  // Pop every free bubble within r of p (poking them with a finger).
  poke(p, r, onPop) {
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const b = this.items[i];
      if (b.p.distanceTo(p) < r + b.r) {
        this.items.splice(i, 1);
        onPop?.(b.p, b.r);
        n++;
      }
    }
    return n;
  }

  // Pop free bubbles that the aim ray passes through (a finger poke).
  pokeRay(o, d, maxT, onPop) {
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const b = this.items[i];
      if (b.stuck >= 0) continue;
      _p.subVectors(b.p, o);
      const t = _p.dot(d);
      if (t < 0 || t > maxT) continue;
      const d2 = _p.lengthSq() - t * t;
      const r = b.r + 0.02;
      if (d2 < r * r) {
        this.items.splice(i, 1);
        onPop?.(b.p, b.r);
        n++;
      }
    }
    return n;
  }

  releaseAll() {
    for (const b of this.items) {
      if (b.stuck >= 0) {
        b.stuck = -1;
        b.v.set((Math.random() - 0.5) * 0.3, 0.3 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3);
        b.life = 1 + Math.random() * 3;
      }
    }
  }

  get count() {
    return this.items.length;
  }
}
