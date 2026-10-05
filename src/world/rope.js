import * as THREE from 'three';

// A verlet hose: fixed at the wall, the far end follows whatever tool is in your hand.
export class Rope {
  constructor(n, length, radius, material) {
    this.n = n;
    this.seg = length / (n - 1);
    this.radius = radius;
    this.p = Array.from({ length: n }, () => new THREE.Vector3());
    this.prev = Array.from({ length: n }, () => new THREE.Vector3());
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.curve = new THREE.CatmullRomCurve3(this.p);
    this.start = new THREE.Vector3();
    this.end = new THREE.Vector3();
    this.attached = true;
    this._tmp = new THREE.Vector3();
  }

  reset(a, b) {
    this.start.copy(a);
    this.end.copy(b);
    for (let i = 0; i < this.n; i++) {
      const t = i / (this.n - 1);
      this.p[i].lerpVectors(a, b, t);
      this.p[i].y -= Math.sin(t * Math.PI) * 0.3;
      this.prev[i].copy(this.p[i]);
    }
  }

  update(dt, floorY = 0.01, wind) {
    const h = dt;
    const g = -9.81 * h * h;
    const n = this.n;
    for (let i = 1; i < n - (this.attached ? 1 : 0); i++) {
      const p = this.p[i], pv = this.prev[i];
      const vx = (p.x - pv.x) * 0.97, vy = (p.y - pv.y) * 0.97, vz = (p.z - pv.z) * 0.97;
      pv.copy(p);
      p.x += vx;
      p.y += vy + g;
      p.z += vz;
      if (wind) {
        this._tmp.set(0, 0, 0);
        wind(p, this._tmp);
        p.addScaledVector(this._tmp, h * h * 0.1);
      }
    }
    this.p[0].copy(this.start);
    if (this.attached) this.p[n - 1].copy(this.end);
    for (let it = 0; it < 6; it++) {
      for (let i = 0; i < n - 1; i++) {
        const a = this.p[i], b = this.p[i + 1];
        this._tmp.subVectors(b, a);
        const d = this._tmp.length() || 1e-6;
        // Hoses only resist stretching; slack is allowed so it drapes.
        if (d <= this.seg) continue;
        const diff = (d - this.seg) / d;
        const wa = i === 0 ? 0 : 1;
        const wb = i + 1 === n - 1 && this.attached ? 0 : 1;
        const ws = wa + wb;
        if (!ws) continue;
        a.addScaledVector(this._tmp, (wa / ws) * diff);
        b.addScaledVector(this._tmp, -(wb / ws) * diff);
      }
      for (let i = 1; i < n - 1; i++) if (this.p[i].y < floorY + this.radius) this.p[i].y = floorY + this.radius;
    }
    const old = this.mesh.geometry;
    this.mesh.geometry = new THREE.TubeGeometry(this.curve, n * 2, this.radius, 6, false);
    old.dispose();
  }
}
