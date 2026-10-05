import * as THREE from 'three';

// A PBD cloth grid pinned along its top edge: the peach towel on the rail.
export class Cloth {
  constructor(width, height, nx, ny, material) {
    this.nx = nx;
    this.ny = ny;
    this.w = width;
    this.h = height;
    this.geo = new THREE.PlaneGeometry(width, height, nx - 1, ny - 1);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    const n = nx * ny;
    this.p = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.pinned = new Uint8Array(n);
    this.pins = new Float32Array(n * 3);
    this.cons = [];
    const idx = (x, y) => y * nx + x;
    const dx = width / (nx - 1), dy = height / (ny - 1);
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (x < nx - 1) this.cons.push([idx(x, y), idx(x + 1, y), dx]);
        if (y < ny - 1) this.cons.push([idx(x, y), idx(x, y + 1), dy]);
        if (x < nx - 2) this.cons.push([idx(x, y), idx(x + 2, y), dx * 2]);
        if (y < ny - 2) this.cons.push([idx(x, y), idx(x, y + 2), dy * 2]);
      }
  }

  // Hang the cloth so its top edge runs from a to b (world space), falling along -Y with a fold.
  hang(a, b) {
    const { nx, ny } = this;
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const i = y * nx + x;
        const t = x / (nx - 1);
        const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
        const py = a.y - (y / (ny - 1)) * this.h;
        this.p[i * 3] = this.prev[i * 3] = px + (y > 0 ? 0.02 * Math.sin(x) : 0);
        this.p[i * 3 + 1] = this.prev[i * 3 + 1] = py;
        this.p[i * 3 + 2] = this.prev[i * 3 + 2] = pz + y * 0.002;
        if (y === 0) {
          this.pinned[i] = 1;
          this.pins[i * 3] = px;
          this.pins[i * 3 + 1] = py;
          this.pins[i * 3 + 2] = pz;
        }
      }
  }

  update(dt, wind, collideY = -Infinity) {
    const steps = 2;
    const h = dt / steps;
    const n = this.nx * this.ny;
    const _w = new THREE.Vector3();
    const _q = new THREE.Vector3();
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        if (this.pinned[i]) {
          this.p[i3] = this.pins[i3];
          this.p[i3 + 1] = this.pins[i3 + 1];
          this.p[i3 + 2] = this.pins[i3 + 2];
          continue;
        }
        _w.set(0, 0, 0);
        _q.set(this.p[i3], this.p[i3 + 1], this.p[i3 + 2]);
        wind?.(_q, _w);
        const vx = (this.p[i3] - this.prev[i3]) * 0.985;
        const vy = (this.p[i3 + 1] - this.prev[i3 + 1]) * 0.985;
        const vz = (this.p[i3 + 2] - this.prev[i3 + 2]) * 0.985;
        this.prev[i3] = this.p[i3];
        this.prev[i3 + 1] = this.p[i3 + 1];
        this.prev[i3 + 2] = this.p[i3 + 2];
        this.p[i3] += vx + _w.x * 0.25 * h * h;
        this.p[i3 + 1] += vy + (-9.81 + _w.y * 0.25) * h * h;
        this.p[i3 + 2] += vz + _w.z * 0.25 * h * h;
      }
      for (let it = 0; it < 3; it++) {
        for (const [a, b, rest] of this.cons) {
          const a3 = a * 3, b3 = b * 3;
          const dx = this.p[b3] - this.p[a3], dy = this.p[b3 + 1] - this.p[a3 + 1], dz = this.p[b3 + 2] - this.p[a3 + 2];
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
          const diff = (d - rest) / d;
          const wa = this.pinned[a] ? 0 : 1, wb = this.pinned[b] ? 0 : 1;
          const ws = wa + wb;
          if (!ws) continue;
          const ka = (wa / ws) * diff, kb = (wb / ws) * diff;
          this.p[a3] += dx * ka; this.p[a3 + 1] += dy * ka; this.p[a3 + 2] += dz * ka;
          this.p[b3] -= dx * kb; this.p[b3 + 1] -= dy * kb; this.p[b3 + 2] -= dz * kb;
        }
      }
      // Keep the towel in front of the wall behind it.
      for (let i = 0; i < n; i++) if (this.p[i * 3 + 2] < collideY) this.p[i * 3 + 2] = collideY;
    }
    const pos = this.geo.attributes.position;
    pos.array.set(this.p);
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}
