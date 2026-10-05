// Uniform grid over particle positions, rebuilt each frame with a counting sort.
// Lets thousands of water droplets find the fur they hit without an O(n*m) loop.
export class SpatialHash {
  constructor(cellSize = 0.06, tableSize = 16384, capacity = 16384) {
    this.cell = cellSize;
    this.inv = 1 / cellSize;
    this.size = tableSize;
    this.cellStart = new Int32Array(tableSize + 1);
    this.entries = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.count = 0;
  }

  _hash(ix, iy, iz) {
    const h = (Math.imul(ix, 92837111) ^ Math.imul(iy, 689287499) ^ Math.imul(iz, 283923481)) >>> 0;
    return h % this.size;
  }

  build(positions, n) {
    if (n > this.entries.length) {
      this.entries = new Int32Array(n * 2);
      this.cellOf = new Int32Array(n * 2);
    }
    this.count = n;
    const cs = this.cellStart;
    cs.fill(0);
    const inv = this.inv;
    for (let i = 0; i < n; i++) {
      const h = this._hash(
        Math.floor(positions[i * 3] * inv),
        Math.floor(positions[i * 3 + 1] * inv),
        Math.floor(positions[i * 3 + 2] * inv)
      );
      this.cellOf[i] = h;
      cs[h]++;
    }
    let start = 0;
    for (let i = 0; i < this.size; i++) {
      start += cs[i];
      cs[i] = start;
    }
    cs[this.size] = start;
    for (let i = 0; i < n; i++) {
      const h = this.cellOf[i];
      cs[h]--;
      this.entries[cs[h]] = i;
    }
  }

  // Calls fn(index) for every particle in cells overlapping the sphere (x,y,z,r).
  query(x, y, z, r, fn) {
    const inv = this.inv;
    const x0 = Math.floor((x - r) * inv), x1 = Math.floor((x + r) * inv);
    const y0 = Math.floor((y - r) * inv), y1 = Math.floor((y + r) * inv);
    const z0 = Math.floor((z - r) * inv), z1 = Math.floor((z + r) * inv);
    for (let ix = x0; ix <= x1; ix++)
      for (let iy = y0; iy <= y1; iy++)
        for (let iz = z0; iz <= z1; iz++) {
          const h = this._hash(ix, iy, iz);
          const s = this.cellStart[h], e = this.cellStart[h + 1];
          for (let k = s; k < e; k++) fn(this.entries[k]);
        }
  }
}
