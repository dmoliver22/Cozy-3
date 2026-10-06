import * as THREE from 'three';
import { addShells, shellUniforms } from './shells.js';
import { hairDensity } from './hair.js';

// The dog's skin: one smooth body instead of a pile of separate shapes. The torso, deep chest,
// rump, shoulders and thighs, neck, tapering legs, paws and tail are signed-distance shapes blended
// into each other, meshed once when the dog is made (surface nets) and skinned to the physics
// skeleton's bones, so the whole body bends with the simulation. The head is modelled the same
// way at a finer grain (skull, brow, cheeks, a muzzle running on from the stop with soft upper lips
// over a narrower jaw, shaped per breed, and sockets for the eyes) and carries the face: dark,
// wet eyes set in those sockets with dark rims, a proper dog nose with nostrils, and a lip line.
// Ears are thin leaf-shaped flaps skinned to their own chain bones.
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

// Sum of the skin's two principal curvatures at p (1/m): the Laplacian of the distance field,
// positive where the skin bulges out.
function curvature(f, p, e = 0.002) {
  const [x, y, z] = p;
  const s = f(x + e, y, z) + f(x - e, y, z) + f(x, y + e, z) + f(x, y - e, z) + f(x, y, z + e) + f(x, y, z - e);
  return clamp((s - 6 * f(x, y, z)) / (e * e), -60, 120);
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

// An eyeball whose colours are painted on as rings around its front: a big dark pupil, a
// brown (or blue) iris with fine radial fibres and a dark ring at its edge, then the white, which
// in a dog is barely ever seen and is a dusky brown where it is.
function eyeballGeometry(re, iris) {
  const g = new THREE.SphereGeometry(re, 48, 32);
  g.rotateX(Math.PI / 2); // poles front and back, so the rings are centred on the pupil
  const p = g.attributes.position, col = new Float32Array(p.count * 3);
  const c = new THREE.Color(), dark = new THREE.Color(0x070505), white = new THREE.Color(0x8a786a);
  const irisDeep = iris.clone().multiplyScalar(0.55);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.acos(Math.max(-1, Math.min(1, z / re))); // angle from the front
    const fib = 0.85 + 0.3 * Math.abs(Math.sin(Math.atan2(y, x) * 23)) * Math.abs(Math.sin(Math.atan2(y, x) * 7 + 1));
    if (a < 0.32) c.copy(dark);
    else if (a < 0.86) c.copy(iris).lerp(irisDeep, smooth01((a - 0.45) / 0.41)).multiplyScalar(fib);
    else if (a < 0.96) c.copy(irisDeep).multiplyScalar(0.4);
    else c.copy(white);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const IDENTITY = new THREE.Matrix4();
const v0 = new THREE.Vector3();

// One eyelid in the eye's frame (X across, Y up, Z out of the eye; side flips X for the right
// eye): a thin shell hugging the eyeball from an almond-shaped edge back into the head. Vertex
// colours darken the margin; the material carries the face's colour.
// shape: [half-width, upper lid height, lower lid height] in eyeball radii; tilt raises the
// outer corner.
function lidGeometry(re, upper, side, shape = [0.84, 0.5, 0.4], tilt = 0.09) {
  const U = 22, V = 7, W = shape[0], H = upper > 0 ? shape[1] : shape[2];
  const r = re * 1.045;
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= U; i++) {
    const x = ((i / U) * 2 - 1) * W * 1.3;
    const q = Math.max(0, 1 - (x / W) ** 2);
    // The outer corner sits a little higher than the inner one.
    const edge = upper * H * Math.pow(q, upper > 0 ? 0.6 : 0.9) + tilt * x;
    for (let j = 0; j <= V; j++) {
      const v = j / V;
      let px = x, py = edge + (upper * 1.05 - edge) * v * v;
      const rr = Math.hypot(px, py);
      if (rr > 0.99) {
        px *= 0.99 / rr;
        py *= 0.99 / rr;
      }
      const pz = Math.sqrt(Math.max(0, 1 - px * px - py * py));
      pos.push(px * r * side, py * r, pz * r);
      const m = smooth01(v / 0.35);
      col.push(0.1 + 0.9 * m, 0.09 + 0.91 * m, 0.09 + 0.91 * m);
    }
  }
  for (let i = 0; i < U; i++)
    for (let j = 0; j < V; j++) {
      const a = i * (V + 1) + j, b = a + V + 1;
      if (upper * side > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
      else idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Pebbled leather for the nose: a bump map of small rounded cells.
let noseBump = null;
function noseBumpTexture() {
  if (noseBump) return noseBump;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, c.width, c.height);
  const rnd = (() => {
    let t = 9;
    return () => ((t = (t * 16807) % 2147483647) / 2147483647);
  })();
  for (let i = 0; i < 900; i++) {
    const x = rnd() * c.width, y = rnd() * c.height, r = 2.5 + rnd() * 3;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  noseBump = new THREE.CanvasTexture(c);
  noseBump.wrapS = noseBump.wrapT = THREE.RepeatWrapping;
  noseBump.repeat.set(3, 2);
  return noseBump;
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

// A dog's tongue: long, flat and soft, with a groove down the middle and a rounded tip. The
// rings of vertices along it are placed every frame (see DogBody._shapeTongue).
const TONGUE_N = 18, TONGUE_R = 10;
function tongueGeometry() {
  const g = new THREE.BufferGeometry();
  const col = new Float32Array(TONGUE_N * TONGUE_R * 3);
  const idx = [];
  for (let i = 0; i < TONGUE_N - 1; i++)
    for (let k = 0; k < TONGUE_R; k++) {
      const a = i * TONGUE_R + k, b = i * TONGUE_R + ((k + 1) % TONGUE_R);
      idx.push(a, a + TONGUE_R, b, b, a + TONGUE_R, b + TONGUE_R);
    }
  const top = new THREE.Color(0xc9616d), under = new THREE.Color(0xa64652), groove = new THREE.Color(0x96394a), c = new THREE.Color();
  for (let i = 0; i < TONGUE_N; i++)
    for (let k = 0; k < TONGUE_R; k++) {
      const phi = (k / TONGUE_R) * Math.PI * 2;
      if (Math.sin(phi) > 0) c.copy(top).lerp(groove, Math.pow(1 - Math.abs(Math.cos(phi)), 6));
      else c.copy(under);
      col.set([c.r, c.g, c.b], (i * TONGUE_R + k) * 3);
    }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TONGUE_N * TONGUE_R * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// The deep chest and the rump, on top of the torso's barrel (torso-local centres and radii, and
// how softly each blends in). The coat's colliders use them too, so hair rests on the real body.
export function torsoBulges(B) {
  const [rx, ry, rz] = B.torso;
  return [
    { at: [0, -0.12 * ry, 0.42 * rz], r: [0.94 * rx, 0.98 * ry, 0.56 * rz], k: 0.5 * ry },
    { at: [0, 0.04 * ry, -0.6 * rz], r: [0.98 * rx, 0.9 * ry, 0.45 * rz], k: 0.4 * ry },
  ];
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
    for (const part of torsoBulges(B)) ell(bt, tl(...part.at), part.r, part.k);
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

  // Head-local shapes: skull, brow and cheeks; a muzzle that runs on from the stop and tapers to
  // the nose, soft upper lips hanging over a narrower lower jaw; then sockets for the eyes.
  _headShapes() {
    const B = this.dog.B;
    const [hx, hy, hz] = B.head.r;
    const [sx, sy, sz] = B.snout.r;
    const [cx, cy, cz] = B.snout.at;
    // flews: how loose and deep the upper lips hang (retrievers) or how tight (huskies, spitz);
    // taper: how much the muzzle narrows to the nose (foxy faces a lot, blocky ones hardly).
    const flews = B.face?.flews ?? 0.3, taper = B.face?.taper ?? 0.2;
    const P = [];
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const ell = (c, r, k) => P.push({ k, ...bound(c, Math.max(...r)), d: (x, y, z) => sdEllipsoid(x - c.x, y - c.y, z - c.z, r[0], r[1], r[2]) });
    ell(V(0, 0, 0), [hx, hy, hz], 0.001);
    ell(V(0, 0.2 * hy, 0.36 * hz), [0.8 * hx, 0.62 * hy, 0.62 * hz], 0.4 * hy);
    for (const s of [1, -1]) ell(V(s * 0.5 * hx, -0.3 * hy, 0.3 * hz), [0.5 * hx, 0.48 * hy, 0.52 * hz], 0.35 * hx);
    // Muzzle: a rounded box, flat on top and narrower there than down at the lips, tapering to the
    // nose with its top running straight on from the stop.
    const bx = sx * 0.95, by = sy * 0.88, bz = sz * 1.02, rr = 0.4 * Math.min(sx, sy);
    P.push({
      k: 0.5 * Math.min(sx, sy),
      ...bound(V(cx, cy, cz), Math.hypot(bx, by, bz) * 1.05),
      d: (x, y, z) => {
        const lx = x - cx, ly = y - cy - 0.04 * sy, lz = z - cz;
        const t = clamp(lz / bz, -1, 1) * 0.5 + 0.5;
        const v = clamp((ly + by) / (2 * by), 0, 1);
        const wx = bx * (1 - taper * t) * (1 - 0.18 * v * v);
        const qx = Math.abs(lx) - wx + rr, qy = Math.abs(ly + 0.06 * sy * t) - by * (1 - 0.12 * t) + rr, qz = Math.abs(lz) - bz + rr;
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - rr;
      },
    });
    // Upper lips: soft lobes down the sides of the muzzle, hanging over the lower jaw.
    for (const s of [1, -1]) ell(V(cx + s * 0.6 * sx * (1 - 0.5 * taper), cy - (0.55 + 0.2 * flews) * sy, cz + 0.22 * sz), [0.42 * sx, (0.32 + 0.22 * flews) * sy, 0.78 * sz], 0.3 * sy);
    // Lower jaw: narrower than the muzzle and tucked in behind the lips.
    ell(V(cx, cy - 0.72 * sy, cz - 0.12 * sz), [0.66 * sx * (1 - 0.4 * taper), 0.34 * sy, 0.84 * sz], 0.3 * sy);
    const base = unionOf(P);
    this.lipShape = { flews };

    // Eyes: life-size eyeballs set deep in sockets, so only a shallow cap shows; lids (built in
    // _buildFace) close over its top and bottom into an almond.
    const E = B.eyes;
    const re = E.r * (E.size ?? 0.75);
    this.eyeSpots = [1, -1].map((s) => {
      const p = project(base, [E.at[0] * s, E.at[1], E.at[2]], [0, 0, 0]);
      const n = gradient(base, p[0], p[1], p[2], [0, 0, 0]);
      const dir = new THREE.Vector3(n[0] * 0.45 + s * 0.08, n[1] * 0.45 + 0.04, n[2] * 0.45 + 0.55).normalize();
      const c = new THREE.Vector3(p[0], p[1], p[2]).addScaledVector(dir, -re * 0.7);
      // Lid frame: X across the eye toward its outer corner, Y up the face, Z out of the eye.
      const Y = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y).normalize();
      const X = new THREE.Vector3().crossVectors(Y, dir).multiplyScalar(s).normalize();
      return { c, dir, X, Y, re, side: s };
    });
    // Each eye sits in a socket a little wider than it is tall, with a soft rim, so the face
    // wraps around the eye instead of the eye sitting on the face.
    const sockets = this.eyeSpots.map((e) => {
      const ax = [e.X.x, e.X.y, e.X.z], ay = [e.Y.x, e.Y.y, e.Y.z], az = [e.dir.x, e.dir.y, e.dir.z];
      const { x: ox, y: oy, z: oz } = e.c;
      return (x, y, z) => {
        const dx = x - ox, dy = y - oy, dz = z - oz;
        return sdEllipsoid(dx * ax[0] + dy * ax[1] + dz * ax[2], dx * ay[0] + dy * ay[1] + dz * ay[2], dx * az[0] + dy * az[1] + dz * az[2], re * 1.2, re * 0.98, re * 1.04);
      };
    });
    const k = re * 0.3;
    const full = (this.headSdf = (x, y, z) => {
      let d = base(x, y, z);
      for (const sk of sockets) d = smax(d, -sk(x, y, z), k);
      return d;
    });
    this.headBase = base;

    // The lower jaw: the part of the head below the mouth line, in front of the corners of the
    // mouth and inside the width of the lower jaw (the upper lips hang down outside it). It swings
    // open about a hinge across the head at the corners of the mouth, so the dog can pant.
    const hinge = (this.hinge = new THREE.Vector3(0, cy - 0.62 * sy, cz - 0.55 * sz));
    const slope = (-0.12 * sy) / sz, nl = Math.hypot(1, slope);
    const wJ = 0.66 * sx * (1 - 0.4 * taper) * 1.08;
    const floorY = (z) => hinge.y + slope * (z - hinge.z);
    // Signed distance (roughly) to the mouth opening: below the mouth line and inside the jaw.
    const mouth = (x, y, z) => Math.max((y - floorY(z)) / nl, Math.abs(x) - wJ);
    const region = (x, y, z) => Math.max(mouth(x, y, z), hinge.z - z);
    this.jawRegion = region;
    this.upperSdf = (x, y, z) => Math.max(full(x, y, z), -region(x, y, z));
    this.jawSdf = (x, y, z) => Math.max(full(x, y, z), region(x, y, z));
    // How far a point on the skin is from the edge of the lips (large away from the mouth).
    this.lipDistance = (x, y, z) => (z < hinge.z - 0.1 * sz ? Infinity : Math.abs(mouth(x, y, z)));
    // Front of the lower jaw and of the upper lip along the mouth line.
    const frontOf = (f, dy) => {
      for (let z = cz + 1.6 * sz; z > hinge.z; z -= 0.004 * sz) if (f(0, floorY(z) + dy, z) < 0) return z;
      return cz;
    };
    this.mouthSpec = { floorY, wJ, slope, jawFront: frontOf(this.jawSdf, -0.06 * sy), upperFront: frontOf(this.upperSdf, 0.06 * sy) };
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
      // Pull a point back inside the flap's outline (hair roots must not hang off its edges).
      const L = (len1 + len2) * 1.08, q = new THREE.Vector3(), c = new THREE.Vector3();
      const clampToFlap = (w) => {
        q.set(w[0], w[1], w[2]);
        let best = Infinity, su = 0;
        for (const [a, b, s0, l] of [[p0, p1, 0, len1], [p1, p2, len1, len2]]) {
          const t = clamp(c.subVectors(q, a).dot(b.clone().sub(a)) / (l * l), 0, 1);
          const d = c.copy(a).lerp(b, t).distanceTo(q);
          if (d < best) {
            best = d;
            su = (s0 + t * l) / L;
          }
        }
        const u = clamp(su, 0, 0.98);
        point(u, c);
        const off = q.clone().sub(c);
        const a = clamp(off.dot(across), -width(u) * 0.85, width(u) * 0.85);
        c.addScaledVector(across, a).addScaledVector(n, off.dot(n));
        w[0] = c.x;
        w[1] = c.y;
        w[2] = c.z;
      };
      return { side, bones, n, across, width, point, clampToFlap, cup: floppy ? 0.25 : 0.4, sdf: (x, y, z) => Math.min(segs[0](x, y, z), segs[1](x, y, z)) };
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
    const min = [-hx - m, Math.min(-hy, cy - sy * 1.6) - m, -hz - m];
    const max = [hx + m, Math.max(hy, cy + sy) + m, Math.max(hz, cz + sz) + m];
    const h = (this.headCell = Math.min(hx, hy, sx * 2) / 14);
    this.headMat = this.skinMat.clone();
    const build = (sdf) => {
      const { pos, idx } = surfaceNets(sdf, min, max, h);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.length).fill(0.6), 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, this.headMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    };
    this.jawMesh = build(this.jawSdf);
    return build(this.upperSdf);
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
    // Eyes: a glossy eyeball set deep in the head, with upper and lower lids closing over it into
    // an almond with a dark margin. The upper lid swings down to blink.
    // A wet, dark eye: the cornea mirrors the room only faintly, so the eye stays dark instead of
    // turning into a silvery bead.
    const eyeMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, clearcoat: 0.5, clearcoatRoughness: 0.08, envMapIntensity: 0.25 });
    const glint = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
    this.lidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide });
    const iris = new THREE.Color(B.eyes.color ?? '#3f2512');
    this.eyes = this.eyeSpots.map((e) => {
      const g = new THREE.Group();
      g.position.copy(e.c);
      const Xr = new THREE.Vector3().crossVectors(e.Y, e.dir);
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xr, e.Y, e.dir));
      g.add(new THREE.Mesh(eyeballGeometry(e.re, iris), eyeMat));
      const spark = new THREE.Mesh(new THREE.SphereGeometry(e.re * 0.075, 10, 8), glint);
      // Both catchlights on the same side, as from one window.
      spark.position.set(e.re * 0.22, e.re * 0.22, e.re * 0.97);
      g.add(spark);
      const upper = new THREE.Mesh(lidGeometry(e.re, 1, e.side, B.eyes.lid, B.eyes.tilt), this.lidMat);
      const lower = new THREE.Mesh(lidGeometry(e.re, -1, e.side, B.eyes.lid, B.eyes.tilt), this.lidMat);
      g.add(upper, lower);
      group.add(g);
      return { group: g, upper, lower };
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
    const rn = sx * (B.noseSize ?? 0.44);
    this.noseR = rn;
    const nose = new THREE.Mesh(
      noseGeometry(),
      new THREE.MeshPhysicalMaterial({ color: 0x221a18, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.45, bumpMap: noseBumpTexture(), bumpScale: 0.6 })
    );
    nose.scale.setScalar(rn);
    const nf = new THREE.Vector3(n[0] * 0.5, n[1] * 0.5 - 0.08, n[2] * 0.5 + 0.5).normalize();
    nose.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nf);
    nose.position.set(p[0], p[1], p[2]).addScaledVector(nf, -rn * 0.35);
    group.add(nose);
    this.nosePos = nose.position.clone();

    // The lower jaw hangs from a pivot at the hinge, so it can swing open.
    const H = this.hinge, M = this.mouthSpec;
    this.jawPivot = new THREE.Group();
    this.jawPivot.position.copy(H);
    this.jawContent = new THREE.Group();
    this.jawContent.position.copy(H).negate();
    this.jawPivot.add(this.jawContent);
    this.jawContent.add(this.jawMesh);
    group.add(this.jawPivot);

    // Teeth: a canine on each side of each jaw, just inside the lips.
    const toothMat = new THREE.MeshStandardMaterial({ color: 0xebe2cc, roughness: 0.4 });
    const cone = new THREE.ConeGeometry(1, 1, 7);
    const tooth = (parent, geo, x, z, r, len, up) => {
      const t = new THREE.Mesh(geo, toothMat);
      t.scale.set(r, len, r);
      const y = M.floorY(z);
      t.position.set(x, up ? y + len * 0.35 : y - len * 0.35, z);
      if (!up) t.rotation.x = Math.PI;
      parent.add(t);
    };
    // Only the canines show past the lips; the small front teeth sit behind them.
    const wJ = M.wJ;
    for (const s of [1, -1]) {
      tooth(group, cone, s * 0.74 * wJ, M.upperFront - 0.45 * sz, 0.05 * sy, 0.2 * sy, false);
      tooth(this.jawContent, cone, s * 0.66 * wJ, M.jawFront - 0.3 * sz, 0.045 * sy, 0.15 * sy, true);
    }

    // The tongue lies on the floor of the mouth and slides out over the lower teeth to pant.
    this.tongueGeo = tongueGeometry();
    this.tongueMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.25, side: THREE.DoubleSide });
    this.tongue = new THREE.Mesh(this.tongueGeo, this.tongueMat);
    this.tongue.frustumCulled = false;
    this.tongue.visible = false;
    this.jawContent.add(this.tongue);
    const back = H.z + 0.3 * (M.jawFront - H.z);
    this.tongueSpec = { back, front: M.jawFront, hw: 0.68 * wJ, th: 0.22 * sy, out: 0.62 * sz, rc: 0.3 * sy };
    return group;
  }

  // ---------------------------------------------------------------- coat hooks
  // How far a head-local point is from the nearest eye and from the nose leather (negative when
  // on them), and which ways are away from them: face hair stops at the lids and the nose.
  faceClearance(P) {
    let eye = Infinity, away = [0, 0, 1], eyeR = 0.01;
    for (const e of this.eyeSpots) {
      const dx = P[0] - e.c.x, dy = P[1] - e.c.y, dz = P[2] - e.c.z;
      const d = Math.hypot(dx, dy, dz) || 1e-6;
      if (d - e.re * 1.08 < eye) {
        eye = d - e.re * 1.08;
        away = [dx / d, dy / d, dz / d];
        eyeR = e.re;
      }
    }
    const n = this.nosePos;
    const nd = Math.hypot(P[0] - n.x, P[1] - n.y, P[2] - n.z) || 1e-6;
    const nose = nd - this.noseR * 0.95;
    return { eye, away, eyeR, nose, noseAway: [(P[0] - n.x) / nd, (P[1] - n.y) / nd, (P[2] - n.z) / nd] };
  }

  // Move a guide strand's root (bone-local P, N) onto the skin.
  relocate(bone, P, N) {
    const d = this.dog, F = this.F, o = bone * 13;
    if (bone === d.boneHead) {
      const p = project(this.headSdf, [P[0], P[1], P[2]], [0, 0, 0]);
      const g = gradient(this.headSdf, p[0], p[1], p[2], [0, 0, 0]);
      return [p, g, curvature(this.headSdf, p)];
    }
    const ear = this.ears.find((e) => e.bones.includes(bone));
    const f = ear ? ear.sdf : this.bodySdf;
    const len = F[o + 12];
    const lz = P[2] * len;
    const w = [0, 1, 2].map((a) => F[o + a] + F[o + 3 + a] * P[0] + F[o + 6 + a] * P[1] + F[o + 9 + a] * lz);
    const g = [0, 0, 0];
    project(f, w, g);
    if (ear) {
      ear.clampToFlap(w);
      project(f, w, g);
    }
    const rel = [w[0] - F[o], w[1] - F[o + 1], w[2] - F[o + 2]];
    const dot = (k, v) => F[o + k] * v[0] + F[o + k + 1] * v[1] + F[o + k + 2] * v[2];
    return [
      [dot(3, rel), dot(6, rel), dot(9, rel) / len],
      [dot(3, g), dot(6, g), dot(9, g)],
      curvature(f, w),
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
    // How far the short fur leans over along the coat (1 = lies flat, 0 = stands straight up).
    const combK = { silky: 1, fluffy: 0.7, curly: 0.35, wiry: 0.65, double: 0.75 }[fur.type] ?? 0.7;
    // skin(v, normal) may override a vertex (mesh space): { col, w } blends to a bare-skin colour.
    const paint = (geo, toWorld = null, clear = null, rim = null, skin = null) => {
      const p = geo.attributes.position, c = geo.attributes.color, nrm = geo.attributes.normal;
      const len = new Float32Array(p.count), cmb = new Float32Array(p.count * 3);
      const v = new THREE.Vector3(), n = new THREE.Vector3(), g = new THREE.Vector3();
      const back = toWorld ? new THREE.Matrix4().copy(toWorld).invert() : null;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        const k0 = clear ? clear(v) : 1;
        const bare = skin ? skin(v, n.fromBufferAttribute(nrm, i)) : null;
        if (toWorld) v.applyMatrix4(toWorld);
        const s = nearest(v.x, v.y, v.z);
        // The skin shows the bottom of the pile: a deep, shadowed shade of the coat.
        const depth = Math.min(1, fur.natLen[s] / 0.08);
        const k = 0.8 - 0.32 * depth;
        // Bare skin right around the eyes is dark, like real eye rims.
        const kr = rim ? k * (0.25 + 0.75 * rim(v0.copy(v).applyMatrix4(back ?? IDENTITY))) : k;
        c.setXYZ(i, fur.color[s * 3] * kr, fur.color[s * 3 + 1] * kr, fur.color[s * 3 + 2] * kr);
        // Short coats (faces, muzzles, paws) are this fur; long coats get a dense undercoat.
        const nl = fur.natLen[s];
        len[i] = clamp(nl * (nl < 0.025 ? 0.9 : 0.5), 0.004, 0.016) * k0;
        g.set(comb[s * 3], comb[s * 3 + 1], comb[s * 3 + 2]);
        if (back) g.transformDirection(back);
        n.fromBufferAttribute(nrm, i);
        g.addScaledVector(n, -g.dot(n)).normalize().multiplyScalar(combK);
        cmb.set([g.x, g.y, g.z], i * 3);
        if (bare) {
          const w = bare.w;
          c.setXYZ(i, c.getX(i) + (bare.col.r - c.getX(i)) * w, c.getY(i) + (bare.col.g - c.getY(i)) * w, c.getZ(i) + (bare.col.b - c.getZ(i)) * w);
          len[i] *= 1 - w;
        }
      }
      c.needsUpdate = true;
      geo.setAttribute('aFurLen', new THREE.BufferAttribute(len, 1));
      geo.setAttribute('aComb', new THREE.BufferAttribute(cmb, 3));
    };
    paint(this.mesh.geometry);
    // Ears are thin flaps under long locks: just a short velvet on them.
    paint(this.earMesh.geometry, null, () => 0.35);
    const H = this.dog.head;
    const headToWorld = new THREE.Matrix4().compose(H.pos, H.quat, new THREE.Vector3(1, 1, 1));
    // Fur thins to nothing at the eyelids and the nose leather.
    const faceClear = (v) => {
      let k = 1;
      for (const e of this.eyeSpots) k *= smooth01((v.distanceTo(e.c) - e.re) / (e.re * 0.6));
      return k * smooth01((v.distanceTo(this.nosePos) - this.noseR * 0.85) / (this.noseR * 0.6));
    };
    const eyeRim = (v) => {
      let k = 1;
      for (const e of this.eyeSpots) k *= smooth01((v.distanceTo(e.c) - e.re * 1.05) / (e.re * 0.35));
      return k;
    };
    // Inside the mouth: a ridged pink palate, a dark floor under the tongue and dark gums along the
    // inside of the lips; the lips themselves are bare black skin at their edges.
    const hc = this.headCell, sy = this.dog.B.snout.r[1];
    const palate = new THREE.Color(0x4f2229), palateRidge = new THREE.Color(0x63303a), floor = new THREE.Color(0x35181c);
    const gum = new THREE.Color(0x2a1719), lipBlack = new THREE.Color(0x151010), tmp = new THREE.Color();
    const mouthSkin = (upper) => (v, nn) => {
      const inner = smooth01((-this.headSdf(v.x, v.y, v.z) - 0.3 * hc) / (0.8 * hc));
      if (inner > 0) {
        const flat = Math.abs(nn.y) > 0.6;
        if (!flat) tmp.copy(gum);
        else if (upper) tmp.copy(palate).lerp(palateRidge, 0.5 + 0.5 * Math.sin(v.z * 900));
        else tmp.copy(floor);
        return { col: tmp, w: inner };
      }
      const lip = 1 - smooth01((this.lipDistance(v.x, v.y, v.z) - 0.08 * sy) / (0.14 * sy));
      return lip > 0 ? { col: lipBlack, w: lip * 0.92 } : null;
    };
    // Face fur lies close: a thinner pile than the body's, so the face stays sleek.
    const faceFur = (v) => 0.65 * faceClear(v);
    paint(this.headMesh.geometry, headToWorld, faceFur, eyeRim, mouthSkin(true));
    paint(this.jawMesh.geometry, headToWorld, faceFur, eyeRim, mouthSkin(false));

    // The lids take a dark shade of the fur around the eyes (their vertex colours hold the margin).
    this.eyes.forEach((e, i) => {
      const ec = this.eyeSpots[i];
      const wp = ec.c.clone().addScaledVector(ec.Y, ec.re * 1.9).applyMatrix4(headToWorld);
      const s = nearest(wp.x, wp.y, wp.z);
      for (const lid of [e.upper, e.lower]) {
        const col = lid.geometry.attributes.color;
        for (let i = 0; i < col.count; i++) {
          const m = col.getX(i);
          col.setXYZ(i, fur.color[s * 3] * m * 0.32, fur.color[s * 3 + 1] * m * 0.32, fur.color[s * 3 + 2] * m * 0.32);
        }
        col.needsUpdate = true;
      }
    });

    // Shell layers of short fur over all of it.
    const B = this.dog.B;
    this.shellU = shellUniforms(0.0015 * clamp(B.stand / 0.4, 0.8, 1.2));
    const body = [...addShells(this.mesh, this.shellU), ...addShells(this.earMesh, this.shellU)];
    const head = addShells(this.headMesh, this.shellU);
    const jaw = addShells(this.jawMesh, this.shellU);
    this.dog.group.add(...body);
    this.face.add(...head);
    this.jawContent.add(...jaw);
    this.shells = [...body, ...head, ...jaw];
  }

  // ---------------------------------------------------------------- per frame
  // open: 1 wide open, 0 shut. The upper lid swings down over the eye.
  blink(open) {
    for (const e of this.eyes) e.upper.rotation.x = (1 - open) * 0.75;
  }

  // open: how far the lower jaw swings down (radians); out: how far the tongue hangs out (0-1);
  // phase drives the bob of a panting tongue.
  setMouth(open, out, phase) {
    if (!this.jawPivot) return;
    this.jawPivot.rotation.x = open;
    const show = open > 0.02;
    this.tongue.visible = show;
    if (!show) return;
    const key = `${open.toFixed(3)}|${out.toFixed(3)}|${phase.toFixed(2)}`;
    if (key === this._tongueKey) return;
    this._tongueKey = key;
    this._shapeTongue(out, phase);
  }

  // The tongue's centre line runs forward along the floor of the mouth, curls over the lower
  // teeth and hangs down and a little forward, bobbing as the dog pants. Rings of vertices are
  // placed along it: a flattened oval with a groove along the top and a rounded tip.
  _shapeTongue(out, phase) {
    const T = this.tongueSpec, M = this.mouthSpec;
    const pos = this.tongueGeo.attributes.position;
    const inside = T.front - T.back, total = inside + out * T.out;
    const lean = 0.62 + 0.1 * Math.sin(phase);
    const aMax = Math.PI / 2 - lean;
    const yLip = M.floorY(T.front) + 0.4 * T.th;
    const centre = (s, P, D) => {
      if (s <= inside) {
        const z = T.back + s;
        P.set(0, M.floorY(z) + 0.4 * T.th, z);
        D.set(0, M.slope, 1).normalize();
        return;
      }
      const s2 = s - inside, arc = T.rc * aMax;
      const a = Math.min(s2 / T.rc, aMax);
      P.set(0, yLip - T.rc + T.rc * Math.cos(a), T.front + T.rc * Math.sin(a));
      D.set(0, -Math.sin(a), Math.cos(a));
      if (s2 > arc) P.addScaledVector(D, s2 - arc);
    };
    const P = new THREE.Vector3(), D = new THREE.Vector3(), X = new THREE.Vector3(1, 0, 0), Bn = new THREE.Vector3();
    for (let i = 0; i < TONGUE_N; i++) {
      const s = (i / (TONGUE_N - 1)) * total;
      centre(s, P, D);
      Bn.crossVectors(D, X);
      const u = s / Math.max(1e-6, total);
      let hw = T.hw * (0.72 + 0.28 * Math.min(1, u * 1.6));
      // A rounded tip.
      const tip = total - s;
      if (tip < hw) hw *= Math.sqrt(Math.max(0, 1 - ((hw - tip) / hw) ** 2));
      const th = T.th * (1 - 0.45 * u);
      for (let k = 0; k < TONGUE_R; k++) {
        const phi = (k / TONGUE_R) * Math.PI * 2;
        const cx = Math.cos(phi), sn = Math.sin(phi);
        let n = th * 0.5 * sn;
        if (sn > 0) n -= th * 0.35 * Math.pow(1 - Math.abs(cx), 4);
        pos.setXYZ(i * TONGUE_R + k, P.x + X.x * hw * cx + Bn.x * n, P.y + Bn.y * n, P.z + Bn.z * n);
      }
    }
    pos.needsUpdate = true;
    this.tongueGeo.computeVertexNormals();
  }

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
    for (const m of [this.skinMat, this.earMat, this.headMat, this.lidMat]) m.color.setScalar(1 - wet * 0.25).lerp(mud, Math.min(0.8, dirt * 0.7));
    // Wet fur has a sheen.
    const rough = 0.92 - 0.22 * wet;
    for (const m of [this.skinMat, this.earMat, this.headMat]) m.roughness = rough;
    if (!this.shells) return;
    for (const l of this.shells) {
      l.material.color.copy(this.skinMat.color);
      l.material.roughness = rough;
    }
    // A soaked coat lies flat.
    this.shellU.uFlat.value = wet;
  }

  dispose() {
    for (const m of [this.mesh, this.earMesh, this.headMesh, this.jawMesh]) m.geometry.dispose();
    for (const m of [this.skinMat, this.earMat, this.headMat]) m.dispose();
    for (const l of this.shells ?? []) {
      l.material.dispose();
      l.removeFromParent();
    }
    this.face.traverse((o) => {
      if (o.isMesh && o !== this.headMesh && o !== this.jawMesh && !this.shells?.includes(o)) {
        o.geometry.dispose();
        o.material.dispose?.();
      }
    });
    this.skeleton.dispose();
  }
}
