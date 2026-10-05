import * as THREE from 'three';

// A verlet hose: plumbed into the wall at one end, the other end plugs into the bottom of whatever
// tool is in your hand. Both ends leave their fittings straight (the second particle at each end is
// pinned along the fitting's direction), then the hose sags, drapes over the tub and rests on floors.
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
    this.startDir = new THREE.Vector3(0, -1, 0);
    this.end = new THREE.Vector3();
    this.endDir = null; // unit vector pointing out of the tool's fitting, or null for a free end
    this.attached = true;
    this._tmp = new THREE.Vector3();
  }

  reset(a, b) {
    this.start.copy(a);
    this.end.copy(b);
    for (let i = 0; i < this.n; i++) {
      const t = i / (this.n - 1);
      this.p[i].lerpVectors(a, b, t);
      this.p[i].y -= Math.sin(t * Math.PI) * 0.08;
      this.prev[i].copy(this.p[i]);
    }
  }

  // `collide(p, r)` pushes a point out of the room's solids (tub, table, floor); `across(a, b, r,
  // aPinned, bPinned)` fixes segments that would cut through a thin wall.
  update(dt, collide, wind, across = null) {
    const h = dt;
    const g = -9.81 * h * h;
    const n = this.n, r = this.radius;
    const pinEnd = this.attached;
    for (let i = 1; i < n - (pinEnd ? 1 : 0); i++) {
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
    const seg = this.seg;
    const pin = () => {
      this.p[0].copy(this.start);
      this.p[1].copy(this.start).addScaledVector(this.startDir, seg);
      if (pinEnd) {
        this.p[n - 1].copy(this.end);
        if (this.endDir) this.p[n - 2].copy(this.end).addScaledVector(this.endDir, seg);
      }
    };
    const fixed = (i) => i <= 1 || (pinEnd && (i === n - 1 || (this.endDir && i === n - 2)));
    pin();
    for (let it = 0; it < 8; it++) {
      for (let i = 0; i < n - 1; i++) {
        const a = this.p[i], b = this.p[i + 1];
        this._tmp.subVectors(b, a);
        const d = this._tmp.length() || 1e-6;
        // Hoses only resist stretching; slack is allowed so it drapes.
        if (d <= seg) continue;
        const diff = (d - seg) / d;
        const wa = fixed(i) ? 0 : 1;
        const wb = fixed(i + 1) ? 0 : 1;
        const ws = wa + wb;
        if (!ws) continue;
        a.addScaledVector(this._tmp, (wa / ws) * diff);
        b.addScaledVector(this._tmp, -(wb / ws) * diff);
      }
      for (let i = 2; i < n - (pinEnd ? 2 : 0); i++) {
        const p = this.p[i];
        if (collide(p, r)) {
          // Rubber on tile: lose most of the sliding speed.
          const pv = this.prev[i];
          pv.x = p.x - (p.x - pv.x) * 0.4;
          pv.z = p.z - (p.z - pv.z) * 0.4;
        }
      }
      if (across) for (let i = 0; i < n - 1; i++) across(this.p[i], this.p[i + 1], r, fixed(i), fixed(i + 1));
    }
    pin();
    const old = this.mesh.geometry;
    this.mesh.geometry = new THREE.TubeGeometry(this.curve, n * 2, r, 7, false);
    old.dispose();
  }
}
