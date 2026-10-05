import * as THREE from 'three';

const RADIAL = 7;
const RING = Array.from({ length: RADIAL + 1 }, (_, j) => {
  const v = (j / RADIAL) * Math.PI * 2;
  return [-Math.cos(v), Math.sin(v)];
});

// Topology of an open tube (same layout as THREE.TubeGeometry): rings of RADIAL + 1 vertices along
// the hose. Only positions and normals change afterwards, so the buffers are made once.
function tubeGeometry(segs) {
  const verts = (segs + 1) * (RADIAL + 1);
  const geo = new THREE.BufferGeometry();
  const uv = new Float32Array(verts * 2);
  const index = [];
  for (let i = 0; i <= segs; i++)
    for (let j = 0; j <= RADIAL; j++) {
      const k = i * (RADIAL + 1) + j;
      uv[k * 2] = i / segs;
      uv[k * 2 + 1] = j / RADIAL;
      if (i && j) {
        const a = k - RADIAL - 2, b = k - 1, c = k, d = k - RADIAL - 1;
        index.push(a, b, d, b, c, d);
      }
    }
  geo.setIndex(index);
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

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
    this.segs = n * 2;
    this.mesh = new THREE.Mesh(tubeGeometry(this.segs), material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.curve = new THREE.CatmullRomCurve3(this.p);
    this.start = new THREE.Vector3();
    this.startDir = new THREE.Vector3(0, -1, 0);
    this.end = new THREE.Vector3();
    this.endDir = null; // unit vector pointing out of the tool's fitting, or null for a free end
    this.attached = true;
    this._tmp = new THREE.Vector3();
    this._c = Array.from({ length: this.segs + 1 }, () => new THREE.Vector3());
    this._t = new THREE.Vector3();
    this._nrm = new THREE.Vector3();
    this._bin = new THREE.Vector3();
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
    this._shape();
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
    this._shape();
  }

  // Wrap the tube around the curve through the particles, in place. Each ring's frame is carried
  // along from the previous one (parallel transport), so the surface doesn't twist as it bends.
  _shape() {
    const segs = this.segs, r = this.radius, c = this._c;
    for (let i = 0; i <= segs; i++) this.curve.getPoint(i / segs, c[i]);
    const geo = this.mesh.geometry;
    const P = geo.attributes.position.array, Nn = geo.attributes.normal.array;
    const T = this._t, N = this._nrm, B = this._bin;
    for (let i = 0; i <= segs; i++) {
      const t = this._tmp.subVectors(c[Math.min(i + 1, segs)], c[Math.max(i - 1, 0)]);
      if (t.lengthSq() > 1e-14) T.copy(t).normalize();
      else if (!i) T.set(0, -1, 0);
      if (!i || N.addScaledVector(T, -N.dot(T)).lengthSq() < 1e-6) {
        // Start (or restart, after a sharp kink) from any direction across the hose.
        N.set(Math.abs(T.x) < 0.6 ? 1 : 0, Math.abs(T.x) < 0.6 ? 0 : 1, 0);
        N.addScaledVector(T, -N.dot(T));
      }
      N.normalize();
      B.crossVectors(T, N);
      const o = c[i];
      for (let j = 0; j <= RADIAL; j++) {
        const [co, si] = RING[j];
        const nx = co * N.x + si * B.x, ny = co * N.y + si * B.y, nz = co * N.z + si * B.z;
        const k = (i * (RADIAL + 1) + j) * 3;
        Nn[k] = nx;
        Nn[k + 1] = ny;
        Nn[k + 2] = nz;
        P[k] = o.x + r * nx;
        P[k + 1] = o.y + r * ny;
        P[k + 2] = o.z + r * nz;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
  }
}
