import * as THREE from 'three';

const FRAMES = { heart: 0, star: 1, mist: 2, note: 3 };

function atlas() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d');
  // Heart
  g.save();
  g.translate(32, 34);
  g.fillStyle = '#fff';
  g.beginPath();
  g.moveTo(0, 18);
  g.bezierCurveTo(-26, 2, -22, -22, 0, -10);
  g.bezierCurveTo(22, -22, 26, 2, 0, 18);
  g.fill();
  g.restore();
  // Four-point sparkle
  g.save();
  g.translate(96, 32);
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = i % 2 ? 6 : 28;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.fill();
  g.restore();
  // Soft mist puff
  const grd = g.createRadialGradient(160, 32, 2, 160, 32, 30);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(128, 0, 64, 64);
  // Music note
  g.save();
  g.translate(224, 32);
  g.fillStyle = '#fff';
  g.beginPath();
  g.ellipse(-6, 14, 9, 7, -0.4, 0, Math.PI * 2);
  g.fill();
  g.fillRect(1, -22, 5, 36);
  g.beginPath();
  g.moveTo(6, -22);
  g.quadraticCurveTo(20, -14, 16, 0);
  g.quadraticCurveTo(14, -10, 6, -12);
  g.fill();
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const vert = /* glsl */ `
  attribute float aFrame;
  attribute float aAlpha;
  attribute float aRot;
  attribute vec3 aTint;
  varying vec2 vUv;
  varying float vA;
  varying vec3 vC;
  void main() {
    vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float s = length(instanceMatrix[0].xyz);
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    float c = cos(aRot), sn = sin(aRot);
    vec2 p = vec2(position.x * c - position.y * sn, position.x * sn + position.y * c);
    vec3 wp = center + (right * p.x + up * p.y) * s;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    vUv = vec2((uv.x + aFrame) / 4.0, uv.y);
    vA = aAlpha;
    vC = aTint;
  }
`;
const frag = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying float vA;
  varying vec3 vC;
  void main() {
    vec4 t = texture2D(map, vUv);
    gl_FragColor = vec4(vC * t.rgb, t.a * vA);
    if (gl_FragColor.a < 0.01) discard;
  }
`;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

// Hearts, sparkles, mist and notes: camera-facing sprites with simple physics.
export class Sparkles {
  constructor(scene, cap = 400) {
    this.cap = cap;
    this.items = [];
    const geo = new THREE.PlaneGeometry(1, 1);
    this.aFrame = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.aAlpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.aRot = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    geo.setAttribute('aFrame', this.aFrame);
    geo.setAttribute('aAlpha', this.aAlpha);
    geo.setAttribute('aRot', this.aRot);
    geo.setAttribute('aTint', this.aTint);
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { map: { value: atlas() } },
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 10;
    scene.add(this.mesh);
  }

  emit(kind, p, opts = {}) {
    if (this.items.length >= this.cap) this.items.shift();
    const v = opts.v ? opts.v.clone() : new THREE.Vector3();
    const c = new THREE.Color(opts.color ?? (kind === 'heart' ? '#f47c9a' : '#ffffff'));
    this.items.push({
      kind, frame: FRAMES[kind], p: p.clone(), v,
      size: opts.size ?? (kind === 'mist' ? 0.05 : 0.04),
      life: opts.life ?? (kind === 'mist' ? 0.7 : 1.4), age: 0,
      rot: opts.rot ?? (kind === 'heart' || kind === 'note' ? (Math.random() - 0.5) * 0.4 : Math.random() * 6),
      spin: kind === 'star' ? (Math.random() - 0.5) * 6 : 0,
      seed: Math.random() * 10,
      c,
    });
  }

  burst(kind, p, n, speed = 0.8, opts = {}) {
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.5 + Math.random()));
      this.emit(kind, p, { ...opts, v });
    }
  }

  update(dt, time) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const s = this.items[i];
      s.age += dt;
      if (s.age >= s.life) {
        this.items.splice(i, 1);
        continue;
      }
      if (s.kind === 'heart' || s.kind === 'note') {
        // Float up like a little balloon, swaying.
        s.v.y += 0.6 * dt;
        s.v.x += Math.sin(time * 3 + s.seed) * 0.3 * dt;
        s.v.multiplyScalar(Math.exp(-1.5 * dt));
      } else if (s.kind === 'star') {
        s.v.y -= 0.8 * dt;
        s.v.multiplyScalar(Math.exp(-3 * dt));
      } else {
        s.v.y += 0.2 * dt;
        s.v.multiplyScalar(Math.exp(-4 * dt));
      }
      s.p.addScaledVector(s.v, dt);
      s.rot += s.spin * dt;
    }
    const M = this.mesh;
    this.items.forEach((s, i) => {
      const k = s.age / s.life;
      // Pop in with an overshoot, fade out at the end.
      const pop = 1 + Math.sin(Math.min(1, s.age * 5) * Math.PI) * 0.35;
      let size = s.size * Math.min(1, s.age * 8) * pop;
      if (s.kind === 'mist') size = s.size * (1 + k * 2);
      if (s.kind === 'star') size *= 0.7 + Math.sin(time * 20 + s.seed) * 0.3;
      _s.setScalar(size);
      _m.compose(s.p, _q, _s);
      M.setMatrixAt(i, _m);
      this.aFrame.array[i] = s.frame;
      this.aAlpha.array[i] = (1 - k * k) * (s.kind === 'mist' ? 0.55 : 1);
      this.aRot.array[i] = s.rot;
      this.aTint.array[i * 3] = s.c.r;
      this.aTint.array[i * 3 + 1] = s.c.g;
      this.aTint.array[i * 3 + 2] = s.c.b;
    });
    M.count = this.items.length;
    M.instanceMatrix.needsUpdate = true;
    this.aFrame.needsUpdate = this.aAlpha.needsUpdate = this.aRot.needsUpdate = this.aTint.needsUpdate = true;
  }
}
