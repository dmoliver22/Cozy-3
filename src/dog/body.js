import * as THREE from 'three';
import { addShells, shellUniforms } from './shells.js';
import { hairDensity } from './hair.js';

// The dog's skin: one smooth body instead of a pile of separate shapes. The torso, deep chest,
// rump, shoulders and thighs, neck, tapering legs, paws and tail are signed-distance shapes blended
// into each other, meshed once when the dog is made (surface nets) and skinned to the physics
// skeleton's bones, so the whole body bends with the simulation. The head is modelled the same
// way at a finer grain (skull, brow, cheeks, a tapering muzzle with a stop, jaw and eye sockets)
// and carries the face: recessed glossy eyes with dark rims, a proper dog nose with nostrils, and
// a lip line. Ears are thin leaf-shaped flaps skinned to their own chain bones.
//
// The coat's guide strands are moved onto this skin (relocate) and the skin takes the coat's
// colours (colorize), so gaps between hairs look like dense underfur.

const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const smax = (a, b, k) => -smin(-a, -b, k);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function sdEllipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}

// Round cone between points a and b with radii r1 and r2 (Inigo Quilez).
function roundCone(a, b, r1, r2) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const l2 = bax * bax + bay * bay + baz * baz;
  const rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  return (x, y, z) => {
    const pax = x - a.x, pay = y - a.y, paz = z - a.z;
    const yy = pax * bax + pay * bay + paz * baz;
    const zz = yy - l2;
    const qx = pax * l2 - bax * yy, qy = pay * l2 - bay * yy, qz = paz * l2 - baz * yy;
    const x2 = qx * qx + qy * qy + qz * qz;
    const y2 = yy * yy * l2, z2 = zz * zz * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(zz) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(yy) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
  };
}

// World → local for a frame given by an origin and a rotation.
function localizer(origin, quat) {
  const e = new THREE.Matrix4().makeRotationFromQuaternion(quat).elements;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  return (x, y, z, out) => {
    const dx = x - ox, dy = y - oy, dz = z - oz;
    out[0] = e[0] * dx + e[1] * dy + e[2] * dz;
    out[1] = e[4] * dx + e[5] * dy + e[6] * dz;
    out[2] = e[8] * dx + e[9] * dy + e[10] * dz;
    return out;
  };
}

// Smooth union of shapes, each blending into what came before with its own radius k. Each shape
// carries a bounding sphere (cx, cy, cz, R): shapes too far away to change the result are skipped.
function unionOf(prims) {
  return (x, y, z) => {
    let d = 1e9;
    for (const p of prims) {
      const dx = x - p.cx, dy = y - p.cy, dz = z - p.cz;
      if (Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R > d + p.k) continue;
      d = smin(d, p.d(x, y, z), p.k);
    }
    return d;
  };
}
const bound = (c, R) => ({ cx: c.x, cy: c.y, cz: c.z, R });

function gradient(f, x, y, z, out, e = 0.0008) {
  out[0] = f(x + e, y, z) - f(x - e, y, z);
  out[1] = f(x, y + e, z) - f(x, y - e, z);
  out[2] = f(x, y, z + e) - f(x, y, z - e);
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l;
  out[1] /= l;
  out[2] /= l;
  return out;
}

// Pull a point onto the zero surface of f along its gradient.
function project(f, p, n) {
  for (let i = 0; i < 4; i++) {
    const d = f(p[0], p[1], p[2]);
    gradient(f, p[0], p[1], p[2], n);
    p[0] -= n[0] * d;
    p[1] -= n[1] * d;
    p[2] -= n[2] * d;
    if (Math.abs(d) < 2e-4) break;
  }
  gradient(f, p[0], p[1], p[2], n);
  return p;
}

// Naive surface nets: one vertex per grid cell the surface passes through, one quad per crossed
// grid edge. Returns positions and triangle indices.
function surfaceNets(f, min, max, h) {
  const nx = Math.ceil((max[0] - min[0]) / h) + 1, ny = Math.ceil((max[1] - min[1]) / h) + 1, nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const field = new Float32Array(nx * ny * nz);
  const at = (i, j, k) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) field[at(i, j, k)] = f(min[0] + i * h, min[1] + j * h, min[2] + k * h);
  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cell = new Int32Array(cx * cy * cz).fill(-1);
  const cat = (i, j, k) => i + cx * (j + cy * k);
  const pos = [];
  const v = new Float32Array(8);
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = field[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          if (v[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let c = 0; c < 8; c++)
          for (const b of [1, 2, 4]) {
            if (c & b) continue;
            const c2 = c | b;
            if (v[c] < 0 === v[c2] < 0) continue;
            const t = v[c] / (v[c] - v[c2]);
            sx += (c & 1) + (((c2 & 1) - (c & 1)) * t);
            sy += ((c >> 1) & 1) + ((((c2 >> 1) & 1) - ((c >> 1) & 1)) * t);
            sz += ((c >> 2) & 1) + ((((c2 >> 2) & 1) - ((c >> 2) & 1)) * t);
            n++;
          }
        cell[cat(i, j, k)] = pos.length / 3;
        pos.push(min[0] + (i + sx / n) * h, min[1] + (j + sy / n) * h, min[2] + (k + sz / n) * h);
      }
  const idx = [];
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const inside = field[at(i, j, k)] < 0;
        if (i < cx && j > 0 && k > 0 && j < cy && k < cz && inside !== field[at(i + 1, j, k)] < 0)
          quad(cell[cat(i, j - 1, k - 1)], cell[cat(i, j, k - 1)], cell[cat(i, j, k)], cell[cat(i, j - 1, k)], !inside);
        if (j < cy && i > 0 && k > 0 && i < cx && k < cz && inside !== field[at(i, j + 1, k)] < 0)
          quad(cell[cat(i - 1, j, k - 1)], cell[cat(i - 1, j, k)], cell[cat(i, j, k)], cell[cat(i, j, k - 1)], !inside);
        if (k < cz && i > 0 && j > 0 && i < cx && j < cy && inside !== field[at(i, j, k + 1)] < 0)
          quad(cell[cat(i - 1, j - 1, k)], cell[cat(i, j - 1, k)], cell[cat(i, j, k)], cell[cat(i - 1, j, k)], !inside);
      }
  return { pos: new Float32Array(pos), idx };
}

// Bone matrix from the skeleton's frame table: X, Y, Z·length, origin.
function frameMatrix(F, b, out) {
  const o = b * 13, l = F[o + 12];
  return out.set(F[o + 3], F[o + 6], F[o + 9] * l, F[o], F[o + 4], F[o + 7], F[o + 10] * l, F[o + 1], F[o + 5], F[o + 8], F[o + 11] * l, F[o + 2], 0, 0, 0, 1);
}

function noseGeometry() {
  const g = new THREE.SphereGeometry(1, 32, 22);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // A rounded wedge: broad flat top, narrower bottom, front face flattened.
    let { x, y, z } = v;
    x *= 1 - 0.18 * clamp(-y, 0, 1);
    if (y > 0.15) y = 0.15 + (y - 0.15) * 0.6;
    if (z > 0.55) z = 0.55 + (z - 0.55) * 0.6;
    // Nostrils: two comma-shaped dents low on the front.
    for (const s of [1, -1]) {
      const dx = x - s * 0.42, dy = y + 0.12, dz = z - 0.62;
      const dent = 0.3 * Math.exp(-(dx * dx * 6 + dy * dy * 10 + dz * dz * 5) * 3.2);
      x *= 1 - dent;
      y *= 1 - dent * 0.5;
      z *= 1 - dent;
    }
    // The groove down the middle to the lip.
    const groove = 0.1 * Math.exp(-x * x * 90) * clamp(-y * 1.6, 0, 1) * clamp(z * 1.4, 0, 1);
    z -= groove;
    p.setXYZ(i, x, y * 0.78, z * 0.82);
  }
  g.computeVertexNormals();
  return g;
}

export class DogBody {
  constructor(dog) {
    this.dog = dog;
    const B = dog.B;
    this.F = dog.frames;
    this._bodyShapes();
    this._headShapes();
    this._earShapes();

    this.bones = dog.boneList.map(() => {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      b.matrixWorldAutoUpdate = false;
      return b;
    });
    const inverses = this.bones.map((_, i) => frameMatrix(this.F, i, new THREE.Matrix4()).invert());
    this.skeleton = new THREE.Skeleton(this.bones, inverses);

    this.skinMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 });
    this.earMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.DoubleSide });
    this.mesh = this._meshBody();
    this.earMesh = this._meshEars();
    this.headMesh = this._meshHead();
    this.face = this._buildFace(B);
    this.update();
  }

  // ---------------------------------------------------------------- shapes
  _bodyShapes() {
    const d = this.dog, B = d.B, T = d.torso;
    const [rx, ry, rz] = B.torso;
    const legR = B.legR;
    const P = [];
    const tl = (x, y, z) => T.localToWorld(new THREE.Vector3(x, y, z), new THREE.Vector3());
    const ell = (bone, c, radii, k, quat = T.quat) => {
      const L = localizer(c, quat), o = [0, 0, 0];
      P.push({ bone, k, ...bound(c, Math.max(...radii)), d: (x, y, z) => (L(x, y, z, o), sdEllipsoid(o[0], o[1], o[2], radii[0], radii[1], radii[2])) });
    };
    const cone = (bone, a, b, r1, r2, k) =>
      P.push({ bone, k, ...bound(a.clone().add(b).multiplyScalar(0.5), a.distanceTo(b) / 2 + Math.max(r1, r2)), d: roundCone(a, b, r1, r2) });
    const bt = d.boneTorso;
    // Barrel, a deep chest dropping to the elbows, and a rounded rump.
    ell(bt, T.pos.clone(), [rx, ry, rz], 0.001);
    ell(bt, tl(0, -0.12 * ry, 0.42 * rz), [0.94 * rx, 0.98 * ry, 0.56 * rz], 0.5 * ry);
    ell(bt, tl(0, 0.04 * ry, -0.6 * rz), [0.98 * rx, 0.9 * ry, 0.45 * rz], 0.4 * ry);
    // Neck, thick where it meets the shoulders.
    cone(d.boneNeck, d.neckA, d.neckB, B.neckR * 1.3, B.neckR * 1.02, 0.5 * B.neckR);
    const up = T.dirToWorld(new THREE.Vector3(0, 1, 0), new THREE.Vector3());
    const fwd = T.dirToWorld(new THREE.Vector3(0, 0, 1), new THREE.Vector3());
    const side = T.dirToWorld(new THREE.Vector3(1, 0, 0), new THREE.Vector3());
    d.legs.forEach((L, i) => {
      const [bu, bl] = d.boneLegs[i];
      // Shoulder or thigh muscle swelling out of the body and down the upper leg.
      const m = L.hipW.clone().lerp(L.knee, L.front ? 0.22 : 0.28).addScaledVector(side, L.side * legR * 0.35).addScaledVector(fwd, L.front ? legR * 0.15 : -legR * 0.2);
      ell(bu, m, L.front ? [legR * 1.05, L.L1 * 0.42, legR * 1.4] : [legR * 1.25, L.L1 * 0.48, legR * 1.85], legR * 0.9);
      cone(bu, L.hipW, L.knee, legR * (L.front ? 1.25 : 1.4), legR * 0.72, legR * 0.6);
      // Slim lower leg into a compact paw.
      const pawTop = L.paw.clone().addScaledVector(up, legR * 0.6);
      cone(bl, L.knee, pawTop, legR * 0.7, legR * 0.5, legR * 0.35);
      ell(bl, L.paw.clone().addScaledVector(up, legR * 0.42).addScaledVector(fwd, legR * 0.3), [legR * 0.8, legR * 0.46, legR * 1.05], legR * 0.35);
    });
    const tr = B.tail.r, n = d.tail.n;
    for (let j = 0; j < n; j++) cone(d.boneTail[j], d.tail.p[j], d.tail.p[j + 1], tr * (1 - (0.5 * j) / n), tr * (1 - (0.5 * (j + 1)) / n), j === 0 ? tr : tr * 0.3);
    this.bodyPrims = P;
    this.bodySdf = unionOf(P);
  }

  // Head-local shapes: skull, brow, cheeks, a muzzle tapering to the nose, jaw; then eye sockets.
  _headShapes() {
    const B = this.dog.B;
    const [hx, hy, hz] = B.head.r;
    const [sx, sy, sz] = B.snout.r;
    const [cx, cy, cz] = B.snout.at;
    const P = [];
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    P.push({ k: 0.001, ...bound(V(0, 0, 0), Math.max(hx, hy, hz)), d: (x, y, z) => sdEllipsoid(x, y, z, hx, hy, hz) });
    P.push({ k: 0.4 * hy, ...bound(V(0, 0.2 * hy, 0.36 * hz), 0.8 * Math.max(hx, hy, hz)), d: (x, y, z) => sdEllipsoid(x, y - 0.2 * hy, z - 0.36 * hz, 0.8 * hx, 0.62 * hy, 0.62 * hz) });
    for (const s of [1, -1]) P.push({ k: 0.35 * hx, ...bound(V(s * 0.5 * hx, -0.3 * hy, 0.3 * hz), 0.52 * Math.max(hx, hy, hz)), d: (x, y, z) => sdEllipsoid(x - s * 0.5 * hx, y + 0.3 * hy, z - 0.3 * hz, 0.5 * hx, 0.48 * hy, 0.52 * hz) });
    // Muzzle: a rounded box, narrowing and lowering a little toward the nose.
    const bx = sx * 0.92, by = sy * 0.86, bz = sz * 1.02, rr = 0.62 * Math.min(sx, sy);
    P.push({
      k: 0.6 * Math.min(sx, sy),
      ...bound(V(cx, cy, cz), Math.hypot(bx, by, bz) * 1.05),
      d: (x, y, z) => {
        const lx = x - cx, ly = y - cy - 0.06 * sy, lz = z - cz;
        const t = clamp(lz / bz, -1, 1) * 0.5 + 0.5;
        const qx = Math.abs(lx) - bx * (1 - 0.2 * t) + rr, qy = Math.abs(ly + 0.08 * sy * t) - by * (1 - 0.12 * t) + rr, qz = Math.abs(lz) - bz + rr;
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - rr;
      },
    });
    P.push({ k: 0.3 * sy, ...bound(V(cx, cy, cz), Math.max(sx, sy, sz)), d: (x, y, z) => sdEllipsoid(x - cx, y - cy, z - cz, sx, sy, sz) });
    P.push({ k: 0.45 * sy, ...bound(V(0, cy - 0.55 * sy, cz - 0.18 * sz), 0.88 * Math.max(sx, sy, sz)), d: (x, y, z) => sdEllipsoid(x, y - (cy - 0.55 * sy), z - (cz - 0.18 * sz), 0.8 * sx, 0.5 * sy, 0.88 * sz) });
    const base = unionOf(P);

    // Eyes sit in sockets: find each eye's spot on the face, then sink the eyeball half in.
    const E = B.eyes;
    const re = E.r * 0.82;
    this.eyeSpots = [1, -1].map((s) => {
      const p = project(base, [E.at[0] * s, E.at[1], E.at[2]], [0, 0, 0]);
      const n = gradient(base, p[0], p[1], p[2], [0, 0, 0]);
      const dir = new THREE.Vector3(n[0] * 0.45 + s * 0.08, n[1] * 0.45 + 0.04, n[2] * 0.45 + 0.55).normalize();
      const c = new THREE.Vector3(p[0], p[1], p[2]).addScaledVector(dir, -re * 0.22);
      return { c, dir, re, side: s };
    });
    this.headSdf = (x, y, z) => {
      let d = base(x, y, z);
      for (const e of this.eyeSpots) d = smax(d, re * 1.03 - Math.hypot(x - e.c.x, y - e.c.y, z - e.c.z), re * 0.3);
      return d;
    };
    this.headBase = base;
  }

  // Ears: thin leaf-shaped flaps (floppy) or pointed triangles (upright) along their chains.
  _earShapes() {
    const d = this.dog, E = d.B.ears;
    const floppy = E.kind === 'floppy';
    const hX = d.head.dirToWorld(new THREE.Vector3(1, 0, 0), new THREE.Vector3());
    const hZ = d.head.dirToWorld(new THREE.Vector3(0, 0, 1), new THREE.Vector3());
    this.ears = [d.earL, d.earR].map((ch, e) => {
      const side = e === 0 ? 1 : -1;
      const bones = e === 0 ? d.boneEarL : d.boneEarR;
      const p0 = ch.p[0].clone(), p1 = ch.p[1].clone(), p2 = ch.p[2].clone();
      const dir = p2.clone().sub(p0).normalize();
      // Floppy ears hang flat against the side of the head; upright ones face forward.
      const n = floppy ? hX.clone().multiplyScalar(side) : hZ.clone().addScaledVector(hX, side * 0.35);
      n.addScaledVector(dir, -n.dot(dir)).normalize();
      const across = new THREE.Vector3().crossVectors(n, dir).normalize();
      const half = E.w * (floppy ? 0.62 : 0.58);
      const len1 = p0.distanceTo(p1), len2 = p1.distanceTo(p2);
      const width = (u) => (floppy ? half * 1.15 * Math.sqrt(Math.max(0, 1 - ((u - 0.45) / 0.62) ** 2)) : half * 1.2 * Math.pow(1 - u, 0.85) + 0.002);
      const point = (u, out) => {
        const s = u * (len1 + len2) * 1.08;
        return s < len1 ? out.lerpVectors(p0, p1, s / len1) : out.copy(p1).addScaledVector(p2.clone().sub(p1).normalize(), s - len1);
      };
      // An SDF for moving ear hair roots onto the flap: two flattened ellipsoids.
      const segs = [[p0, p1, len1], [p1, p2, len2]].map(([a, b, l]) => {
        const c = a.clone().add(b).multiplyScalar(0.5);
        const z = b.clone().sub(a).normalize();
        const ny = n.clone().addScaledVector(z, -n.dot(z)).normalize();
        const m = new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(ny, z), ny, z);
        const L = localizer(c, new THREE.Quaternion().setFromRotationMatrix(m)), o = [0, 0, 0];
        return (x, y, zz) => (L(x, y, zz, o), sdEllipsoid(o[0], o[1], o[2], half * 1.05, 0.006, l * 0.62));
      });
      return { side, bones, n, across, width, point, cup: floppy ? 0.25 : 0.4, sdf: (x, y, z) => Math.min(segs[0](x, y, z), segs[1](x, y, z)) };
    });
  }

  // ---------------------------------------------------------------- meshes
  _meshBody() {
    const B = this.dog.B;
    const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
    // Bounds from a coarse sweep around the skeleton.
    const grow = (p, r) => {
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], p[a] - r);
        max[a] = Math.max(max[a], p[a] + r);
      }
    };
    const d = this.dog, T = d.torso;
    const R = Math.max(...B.torso) * 1.25;
    grow(T.pos.toArray(), R);
    for (const L of d.legs) grow(L.paw.toArray(), B.legR * 2);
    for (const p of d.tail.p) grow(p.toArray(), B.tail.r * 1.5);
    grow(d.neckB.toArray(), B.neckR * 1.6);
    const h = Math.max(B.stand / 40, Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 72);
    const { pos, idx } = surfaceNets(this.bodySdf, min, max, h);
    return this._skinned(pos, idx, this.bodySdf, this.bodyPrims, this.skinMat);
  }

  _skinned(pos, idx, sdf, prims, material) {
    const V = pos.length / 3;
    const si = new Uint16Array(V * 4), sw = new Float32Array(V * 4);
    const sigma = this.dog.B.stand * 0.045;
    const bw = new Float32Array(this.bones.length);
    const used = [];
    for (let v = 0; v < V; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      // Each bone pulls on the skin by how close its shapes are.
      used.length = 0;
      for (const p of prims) {
        const dx = x - p.cx, dy = y - p.cy, dz = z - p.cz;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) - p.R > sigma * 6) continue;
        const w = Math.exp(-Math.max(0, p.d(x, y, z)) / sigma);
        if (bw[p.bone] === 0) used.push(p.bone);
        if (w > bw[p.bone]) bw[p.bone] = w;
      }
      used.sort((a, b) => bw[b] - bw[a]);
      let sum = 0;
      for (let k = 0; k < Math.min(4, used.length); k++) sum += bw[used[k]];
      for (let k = 0; k < Math.min(4, used.length); k++) {
        si[v * 4 + k] = used[k];
        sw[v * 4 + k] = bw[used[k]] / (sum || 1);
      }
      if (!used.length) sw[v * 4] = 1;
      for (const b of used) bw[b] = 0;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(V * 3).fill(0.6), 3));
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.SkinnedMesh(geo, material);
    mesh.bind(this.skeleton, new THREE.Matrix4());
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  _meshHead() {
    const B = this.dog.B;
    const [hx, hy, hz] = B.head.r;
    const [sx, sy, sz] = B.snout.r;
    const [, cy, cz] = B.snout.at;
    const m = 0.02;
    const min = [-hx - m, Math.min(-hy, cy - sy * 1.3) - m, -hz - m];
    const max = [hx + m, Math.max(hy, cy + sy) + m, Math.max(hz, cz + sz) + m];
    const h = Math.min(hx, hy, sx * 2) / 14;
    const { pos, idx } = surfaceNets(this.headSdf, min, max, h);
    const V = pos.length / 3;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(V * 3).fill(0.6), 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.headMat = this.skinMat.clone();
    const mesh = new THREE.Mesh(geo, this.headMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  _meshEars() {
    const U = 14, Vn = 8;
    const pos = [], nrm = [], si = [], sw = [], idx = [];
    const p = new THREE.Vector3();
    for (const ear of this.ears) {
      const v0 = pos.length / 3;
      for (let i = 0; i <= U; i++) {
        const u = i / U;
        ear.point(u, p);
        const w = ear.width(u);
        for (let j = 0; j <= Vn; j++) {
          const v = (j / Vn) * 2 - 1;
          // Cupped a little, like a real ear flap.
          const q = p.clone().addScaledVector(ear.across, v * w).addScaledVector(ear.n, -ear.cup * w * (1 - v * v) * 0.35);
          pos.push(q.x, q.y, q.z);
          nrm.push(ear.n.x, ear.n.y, ear.n.z);
          const t = clamp((u - 0.3) / 0.4, 0, 1);
          const t2 = t * t * (3 - 2 * t);
          si.push(ear.bones[0], ear.bones[1], 0, 0);
          sw.push(1 - t2, t2, 0, 0);
        }
      }
      for (let i = 0; i < U; i++)
        for (let j = 0; j < Vn; j++) {
          const a = v0 + i * (Vn + 1) + j, b = a + 1, c = a + Vn + 1, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.length).fill(0.6), 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.SkinnedMesh(geo, this.earMat);
    mesh.bind(this.skeleton, new THREE.Matrix4());
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  // ---------------------------------------------------------------- face
  _buildFace(B) {
    const group = new THREE.Group();
    group.add(this.headMesh);
    // Eyes: a glossy brown (or blue) eyeball with a pupil and a catchlight, sunk in a socket and
    // ringed by a dark almond-shaped rim.
    const irisCol = new THREE.Color(B.eyes.color ?? '#4a2b17');
    const eyeMat = new THREE.MeshPhysicalMaterial({ color: irisCol, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.03 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x151110, roughness: 0.55 });
    const pupilMat = new THREE.MeshPhysicalMaterial({ color: 0x050404, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02 });
    const glint = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.eyes = this.eyeSpots.map((e) => {
      const g = new THREE.Group();
      g.position.copy(e.c);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), e.dir);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(e.re, 24, 18), eyeMat);
      g.add(ball);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(e.re * 0.5, 16, 12), pupilMat);
      pupil.scale.set(1, 1, 0.35);
      pupil.position.z = e.re * 0.84;
      g.add(pupil);
      const spark = new THREE.Mesh(new THREE.SphereGeometry(e.re * 0.12, 10, 8), glint);
      spark.position.set(e.re * 0.28 * e.side, e.re * 0.3, e.re * 0.93);
      g.add(spark);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(e.re * 0.98, e.re * 0.1, 10, 32), dark);
      rim.scale.set(1.08, 0.88, 1);
      rim.position.z = e.re * 0.24;
      g.add(rim);
      group.add(g);
      return g;
    });

    // Nose: find the front of the muzzle and set a proper dog nose into it.
    const [sx, sy, sz] = B.snout.r;
    const [, cy, cz] = B.snout.at;
    const f = this.headBase;
    const p = [0, cy + sy * 0.32, cz + sz * 3];
    const dirZ = -1;
    for (let i = 0; i < 80; i++) {
      const d = f(p[0], p[1], p[2]);
      if (d < 3e-4) break;
      p[2] += dirZ * d;
    }
    const n = gradient(f, p[0], p[1], p[2], [0, 0, 0]);
    const rn = sx * 0.58;
    const nose = new THREE.Mesh(noseGeometry(), new THREE.MeshPhysicalMaterial({ color: 0x1b1716, roughness: 0.42, clearcoat: 0.7, clearcoatRoughness: 0.25 }));
    nose.scale.setScalar(rn);
    const nf = new THREE.Vector3(n[0] * 0.5, n[1] * 0.5 - 0.08, n[2] * 0.5 + 0.5).normalize();
    nose.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nf);
    nose.position.set(p[0], p[1], p[2]).addScaledVector(nf, -rn * 0.35);
    group.add(nose);
    this.nosePos = nose.position.clone();

    // Lips: a dark line from under the nose back to the corners of the mouth.
    const lipMat = new THREE.MeshStandardMaterial({ color: 0x2a1e1c, roughness: 0.6 });
    for (const s of [1, -1]) {
      const pts = [
        [0, cy - sy * 0.66, cz + sz * 0.92],
        [s * sx * 0.55, cy - sy * 0.6, cz + sz * 0.62],
        [s * sx * 0.88, cy - sy * 0.47, cz + sz * 0.05],
        [s * sx * 0.86, cy - sy * 0.3, cz - sz * 0.5],
        [s * sx * 0.8, cy - sy * 0.14, cz - sz * 0.74],
      ].map((q) => {
        const g = [0, 0, 0];
        project(f, q, g);
        return new THREE.Vector3(q[0] + g[0] * 0.0008, q[1] + g[1] * 0.0008, q[2] + g[2] * 0.0008);
      });
      const lip = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, sy * 0.035, 6, false), lipMat);
      group.add(lip);
    }
    return group;
  }

  // ---------------------------------------------------------------- coat hooks
  // Move a guide strand's root (bone-local P, N) onto the skin.
  relocate(bone, P, N) {
    const d = this.dog, F = this.F, o = bone * 13;
    if (bone === d.boneHead) {
      const p = project(this.headSdf, [P[0], P[1], P[2]], [0, 0, 0]);
      const g = gradient(this.headSdf, p[0], p[1], p[2], [0, 0, 0]);
      return [p, g];
    }
    const ear = this.ears.find((e) => e.bones.includes(bone));
    const f = ear ? ear.sdf : this.bodySdf;
    const len = F[o + 12];
    const lz = P[2] * len;
    const w = [0, 1, 2].map((a) => F[o + a] + F[o + 3 + a] * P[0] + F[o + 6 + a] * P[1] + F[o + 9 + a] * lz);
    const g = [0, 0, 0];
    project(f, w, g);
    const rel = [w[0] - F[o], w[1] - F[o + 1], w[2] - F[o + 2]];
    const dot = (k, v) => F[o + k] * v[0] + F[o + k + 1] * v[1] + F[o + k + 2] * v[2];
    return [
      [dot(3, rel), dot(6, rel), dot(9, rel) / len],
      [dot(3, g), dot(6, g), dot(9, g)],
    ];
  }

  // The skin takes a deeper shade of the coat growing on it: deep coats are dark down at the
  // skin, short coats show nearly their own colour.
  colorize(fur) {
    const S = fur.S, cs = 0.03;
    const grid = new Map();
    const key = (ix, iy, iz) => (ix + 512) * 1048576 + (iy + 512) * 1024 + (iz + 512);
    for (let s = 0; s < S; s++) {
      const k = key(Math.floor(fur.rootPos[s * 3] / cs), Math.floor(fur.rootPos[s * 3 + 1] / cs), Math.floor(fur.rootPos[s * 3 + 2] / cs));
      (grid.get(k) ?? grid.set(k, []).get(k)).push(s);
    }
    const nearest = (x, y, z) => {
      const ix = Math.floor(x / cs), iy = Math.floor(y / cs), iz = Math.floor(z / cs);
      for (let r = 1; r < 6; r++) {
        let best = -1, bd = Infinity;
        for (let a = -r; a <= r; a++)
          for (let b = -r; b <= r; b++)
            for (let c = -r; c <= r; c++) {
              const list = grid.get(key(ix + a, iy + b, iz + c));
              if (!list) continue;
              for (const s of list) {
                const dx = fur.rootPos[s * 3] - x, dy = fur.rootPos[s * 3 + 1] - y, dz = fur.rootPos[s * 3 + 2] - z;
                const dd = dx * dx + dy * dy + dz * dz;
                if (dd < bd) {
                  bd = dd;
                  best = s;
                }
              }
            }
        if (best >= 0) return best;
      }
      return 0;
    };
    // The way each strand lies, in world space at rest.
    const F = this.F;
    const comb = new Float32Array(S * 3);
    for (let s = 0; s < S; s++) {
      const o = fur.bone[s] * 13, gx = fur.groom[s * 3], gy = fur.groom[s * 3 + 1], gz = fur.groom[s * 3 + 2];
      for (let a = 0; a < 3; a++) comb[s * 3 + a] = F[o + 3 + a] * gx + F[o + 6 + a] * gy + F[o + 9 + a] * gz;
    }
    const combK = { silky: 1, fluffy: 0.55, curly: 0.15, wiry: 0.6, double: 0.35 }[fur.type] ?? 0.5;
    const paint = (geo, toWorld) => {
      const p = geo.attributes.position, c = geo.attributes.color, nrm = geo.attributes.normal;
      const len = new Float32Array(p.count), cmb = new Float32Array(p.count * 3);
      const v = new THREE.Vector3(), n = new THREE.Vector3(), g = new THREE.Vector3();
      const back = toWorld ? new THREE.Matrix4().copy(toWorld).invert() : null;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        if (toWorld) v.applyMatrix4(toWorld);
        const s = nearest(v.x, v.y, v.z);
        const depth = Math.min(1, fur.natLen[s] / 0.08);
        const k = 0.88 - 0.4 * depth;
        c.setXYZ(i, fur.color[s * 3] * k, fur.color[s * 3 + 1] * k, fur.color[s * 3 + 2] * k);
        // Short fur on the skin: a third of the coat's length, from a velvet muzzle to a dense undercoat.
        len[i] = Math.min(0.012, Math.max(0.0025, fur.natLen[s] * 0.32));
        g.set(comb[s * 3], comb[s * 3 + 1], comb[s * 3 + 2]);
        if (back) g.transformDirection(back);
        n.fromBufferAttribute(nrm, i);
        g.addScaledVector(n, -g.dot(n)).normalize().multiplyScalar(combK);
        cmb.set([g.x, g.y, g.z], i * 3);
      }
      c.needsUpdate = true;
      geo.setAttribute('aFurLen', new THREE.BufferAttribute(len, 1));
      geo.setAttribute('aComb', new THREE.BufferAttribute(cmb, 3));
    };
    paint(this.mesh.geometry);
    paint(this.earMesh.geometry);
    const H = this.dog.head;
    paint(this.headMesh.geometry, new THREE.Matrix4().compose(H.pos, H.quat, new THREE.Vector3(1, 1, 1)));

    // Shell layers of short fur over all of it.
    const B = this.dog.B;
    this.shellU = shellUniforms(0.0022 * clamp(B.stand / 0.4, 0.75, 1.2));
    const body = [...addShells(this.mesh, this.shellU), ...addShells(this.earMesh, this.shellU)];
    const head = addShells(this.headMesh, this.shellU);
    this.dog.group.add(...body);
    this.face.add(...head);
    this.shells = [...body, ...head];
  }

  // ---------------------------------------------------------------- per frame
  update() {
    for (let i = 0; i < this.bones.length; i++) frameMatrix(this.F, i, this.bones[i].matrixWorld);
    // When the game is thinning hair to keep up, every other short-fur layer goes too.
    const thin = hairDensity() < 0.6;
    if (this.shells && thin !== this._thin) {
      this._thin = thin;
      for (const l of this.shells) l.visible = !thin || l.userData.layer % 2 === 0;
    }
  }

  // Wet skin darkens, muddy skin goes brown.
  setTint(wet, dirt, mud) {
    for (const m of [this.skinMat, this.earMat, this.headMat]) m.color.setScalar(1 - wet * 0.25).lerp(mud, Math.min(0.8, dirt * 0.7));
    if (!this.shells) return;
    for (const l of this.shells) l.material.color.copy(this.skinMat.color);
    // A soaked coat lies flat.
    this.shellU.uFlat.value = wet;
  }

  dispose() {
    for (const m of [this.mesh, this.earMesh, this.headMesh]) m.geometry.dispose();
    for (const m of [this.skinMat, this.earMat, this.headMat]) m.dispose();
    for (const l of this.shells ?? []) {
      l.material.dispose();
      l.removeFromParent();
    }
    this.face.traverse((o) => {
      if (o.isMesh && o !== this.headMesh && !this.shells?.includes(o)) {
        o.geometry.dispose();
        o.material.dispose?.();
      }
    });
    this.skeleton.dispose();
  }
}
