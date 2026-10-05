import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {
  tileTexture, tileRoughness, floorTexture, woodTexture, brushedSteel, streetTexture,
  windowLettering, corkTexture, rugTexture, posterTexture, priceBoardTexture,
} from './textures.js';
import { Pendulum } from '../core/springs.js';
import { Cloth } from './cloth.js';
import { Rope } from './rope.js';
import { QUALITY } from '../core/quality.js';

// Room layout (metres). The player looks at the back wall: tub on the left, grooming table on the right.
export const ROOM = { x0: -3, x1: 3, z0: -3, z1: 2.6, h: 2.8 };
export const TUB = { x: -1.25, z: -2.62, w: 1.4, d: 0.76, rim: 0.8, floor: 0.34, wall: 0.045 };
export const TABLE = { x: 1.25, z: -2.15, w: 1.1, d: 0.62, y: 0.8 };
export const COUNTER = { x0: 2.05, x1: 2.95, z0: 0.3, z1: 2.0, y: 1.0 };
export const DOOR = { x: 1.25, w: 0.95, h: 2.1 };

// What a dog can stand on: a floor height inside a footprint (the room floor outside it), and walls.
export const SUPPORTS = {
  tub: {
    y: TUB.floor, below: 0, walls: true, top: TUB.rim,
    x0: TUB.x - TUB.w / 2 + TUB.wall, x1: TUB.x + TUB.w / 2 - TUB.wall,
    z0: TUB.z - TUB.d / 2 + TUB.wall, z1: TUB.z + TUB.d / 2 - TUB.wall,
  },
  table: {
    y: TABLE.y, below: 0, walls: false, top: 0,
    x0: TABLE.x - TABLE.w / 2, x1: TABLE.x + TABLE.w / 2, z0: TABLE.z - TABLE.d / 2, z1: TABLE.z + TABLE.d / 2,
  },
};

// Things a jumping dog has to get over: a footprint and the height of its top edge.
export const OBSTACLES = {
  tub: { x0: TUB.x - TUB.w / 2 - 0.02, x1: TUB.x + TUB.w / 2 + 0.02, z0: TUB.z - TUB.d / 2 - 0.02, z1: TUB.z + TUB.d / 2 + 0.02, y: TUB.rim + 0.02 },
  table: { x0: TABLE.x - TABLE.w / 2, x1: TABLE.x + TABLE.w / 2, z0: TABLE.z - TABLE.d / 2, z1: TABLE.z + TABLE.d / 2, y: TABLE.y },
};

export const STATIONS = {
  outside: new THREE.Vector3(1.3, 0, 4.2),
  doorway: new THREE.Vector3(1.3, 0, 2.2),
  lobby: new THREE.Vector3(0.75, 0, 1.25),
  tubFront: new THREE.Vector3(-1.45, 0, -1.5),
  tub: new THREE.Vector3(-1.25, TUB.floor, -2.62),
  // Far enough back that the front paws can fold up and clear the table edge.
  tableFront: new THREE.Vector3(0.62, 0, -1.3),
  table: new THREE.Vector3(1.25, TABLE.y, -2.15),
  owner: new THREE.Vector3(1.45, 0, 1.45),
  ownerOut: new THREE.Vector3(1.3, 0, 4.4),
};

const _v = new THREE.Vector3();

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...opts });
}

export class Salon {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.colliders = []; // player AABBs {x0,x1,z0,z1}
    this.interactables = [];
    this.pendulums = [];
    this.ceiling = ROOM.h;
    this.time = 0;
    this.tubDirt = 0;
    this.tubFlow = 0;
    this.puddles = [];
    this.upgradeObjects = {};
    this.photoSlots = [];

    this._room();
    this._window();
    this._tub();
    this._table();
    this._counter();
    this._decor();
    this._lamps();
    this._photoWall();
    this._hoses();
  }

  add(mesh, cast = true, receive = true) {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.group.add(mesh);
    return mesh;
  }

  box(w, h, d, material, x, y, z, r = 0.02) {
    const g = r > 0 ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)) : new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(g, material);
    m.position.set(x, y, z);
    return this.add(m);
  }

  // ------------------------------------------------------------------
  _room() {
    const { x0, x1, z0, z1, h } = ROOM;
    const W = x1 - x0, D = z1 - z0;
    const tile = tileTexture({ base: '#A8DCCB', tiles: 6 });
    const tileR = tileRoughness({ tiles: 6 });
    const wallMat = (rx, ry) => {
      const t = tile.clone();
      t.repeat.set(rx, ry);
      t.needsUpdate = true;
      const r = tileR.clone();
      r.repeat.set(rx, ry);
      r.needsUpdate = true;
      return new THREE.MeshStandardMaterial({ map: t, roughnessMap: r, roughness: 0.55, metalness: 0, envMapIntensity: 0.6 });
    };
    // Upper wall: soft bubble-white paint above the tile line.
    const paint = mat('#f3f7f4', { roughness: 0.9 });
    const tileH = 1.45;

    const floorT = floorTexture();
    floorT.repeat.set(W / 1.2, D / 1.2);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: floorT, roughness: 0.35, envMapIntensity: 0.5 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
    this.add(floor, false, true);

    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat('#fbfcfb', { roughness: 1 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set((x0 + x1) / 2, h, (z0 + z1) / 2);
    this.add(ceil, false, true);

    const wall = (w, cx, cz, ry, holes = null) => {
      const lower = new THREE.Mesh(new THREE.PlaneGeometry(w, tileH), wallMat(w / 0.9, tileH / 0.9));
      lower.position.set(cx, tileH / 2, cz);
      lower.rotation.y = ry;
      this.add(lower, false, true);
      const upper = new THREE.Mesh(new THREE.PlaneGeometry(w, h - tileH), paint);
      upper.position.set(cx, tileH + (h - tileH) / 2, cz);
      upper.rotation.y = ry;
      this.add(upper, false, true);
      // Peach trim along the tile line.
      const trim = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, 0.03), mat('#F2B38B', { roughness: 0.5 }));
      trim.position.set(cx, tileH, cz);
      trim.rotation.y = ry;
      trim.translateZ(0.012);
      this.add(trim, false, true);
      return [lower, upper];
    };
    wall(W, 0, z0, 0); // back
    // Right wall.
    wall(D, x1, (z0 + z1) / 2, -Math.PI / 2);
    // Front wall with a door opening: build it from pieces.
    const dl = DOOR.x - DOOR.w / 2, dr = DOOR.x + DOOR.w / 2;
    const leftW = dl - x0, rightW = x1 - dr;
    wall(leftW, x0 + leftW / 2, z1, Math.PI);
    wall(rightW, dr + rightW / 2, z1, Math.PI);
    const lintel = new THREE.Mesh(new THREE.PlaneGeometry(DOOR.w, h - DOOR.h), paint);
    lintel.position.set(DOOR.x, DOOR.h + (h - DOOR.h) / 2, z1);
    lintel.rotation.y = Math.PI;
    this.add(lintel, false, true);
    // Left wall has the big window; built in _window().
    this._leftWallTile = wallMat;
    this.paint = paint;
    this.tileH = tileH;

    // Skirting.
    const skirt = mat('#e7f1ed', { roughness: 0.5 });
    this.box(W, 0.08, 0.02, skirt, 0, 0.04, z0 + 0.01, 0);

    // Door: a hinged slab with a spring closer. Its swing is a damped oscillator.
    const doorPivot = new THREE.Group();
    doorPivot.position.set(dl, 0, z1 + 0.02);
    const slab = new THREE.Mesh(new RoundedBoxGeometry(DOOR.w, DOOR.h, 0.05, 2, 0.02), mat('#F2B38B', { roughness: 0.55 }));
    slab.position.set(DOOR.w / 2, DOOR.h / 2, 0);
    slab.castShadow = true;
    doorPivot.add(slab);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(DOOR.w * 0.6, DOOR.h * 0.38), new THREE.MeshStandardMaterial({ color: '#cfe6ee', roughness: 0.05, transparent: true, opacity: 0.55 }));
    glass.position.set(DOOR.w / 2, DOOR.h * 0.68, -0.03);
    glass.rotation.y = Math.PI;
    doorPivot.add(glass);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), mat('#d8b46a', { metalness: 0.8, roughness: 0.25 }));
    knob.position.set(DOOR.w - 0.1, 1.0, -0.05);
    doorPivot.add(knob);
    this.group.add(doorPivot);
    this.door = { pivot: doorPivot, angle: 0, vel: 0, target: 0 };
    // Bell over the door: a pendulum that rings when shoved.
    const bellPivot = new THREE.Group();
    bellPivot.position.set(DOOR.x, DOOR.h + 0.12, z1 - 0.08);
    const bell = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.08, 14, 1, true), mat('#e8c35a', { metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide }));
    bell.position.y = -0.1;
    bellPivot.add(bell);
    const bellStem = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.06), mat('#555'));
    bellStem.position.y = -0.03;
    bellPivot.add(bellStem);
    this.group.add(bellPivot);
    this.bell = { pivot: bellPivot, pend: new Pendulum(0.1, 1.2) };
  }

  _window() {
    const { x0, z0, z1, h } = ROOM;
    const wz0 = -2.0, wz1 = 1.0, wy0 = 0.78, wy1 = 2.42;
    const wallMat = this._leftWallTile;
    const tileH = this.tileH;
    const piece = (za, zb, ya, yb, material) => {
      if (zb - za <= 0 || yb - ya <= 0) return;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(zb - za, yb - ya), material);
      m.position.set(x0, (ya + yb) / 2, (za + zb) / 2);
      m.rotation.y = Math.PI / 2;
      this.add(m, false, true);
    };
    // Tiles below the sill, paint above, and side panels.
    piece(z0, z1, 0, wy0, wallMat((z1 - z0) / 0.9, wy0 / 0.9));
    piece(z0, wz0, wy0, tileH, wallMat((wz0 - z0) / 0.9, (tileH - wy0) / 0.9));
    piece(wz1, z1, wy0, tileH, wallMat((z1 - wz1) / 0.9, (tileH - wy0) / 0.9));
    piece(z0, wz0, tileH, h, this.paint);
    piece(wz1, z1, tileH, h, this.paint);
    piece(wz0, wz1, wy1, h, this.paint);
    const trimMat = mat('#F2B38B', { roughness: 0.5 });
    for (const [za, zb] of [[z0, wz0], [wz1, z1]]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, zb - za), trimMat);
      t.position.set(x0 + 0.012, tileH, (za + zb) / 2);
      this.add(t, false, true);
    }

    // Frame and mullions.
    const frame = mat('#f7fafa', { roughness: 0.4 });
    const fw = 0.07;
    this.box(0.12, fw, wz1 - wz0 + fw * 2, frame, x0 + 0.02, wy0 - fw / 2, (wz0 + wz1) / 2, 0.01);
    this.box(0.12, fw, wz1 - wz0 + fw * 2, frame, x0 + 0.02, wy1 + fw / 2, (wz0 + wz1) / 2, 0.01);
    this.box(0.12, wy1 - wy0, fw, frame, x0 + 0.02, (wy0 + wy1) / 2, wz0 - fw / 2, 0.01);
    this.box(0.12, wy1 - wy0, fw, frame, x0 + 0.02, (wy0 + wy1) / 2, wz1 + fw / 2, 0.01);
    this.box(0.08, wy1 - wy0, 0.04, frame, x0 + 0.02, (wy0 + wy1) / 2, (wz0 + wz1) / 2, 0.01);
    // Deep sill.
    this.box(0.26, 0.05, wz1 - wz0 + 0.2, mat('#f7fafa', { roughness: 0.3 }), x0 + 0.1, wy0 - 0.03, (wz0 + wz1) / 2, 0.015);

    // Outside: the street and the rain.
    const street = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), new THREE.MeshBasicMaterial({ map: streetTexture(), toneMapped: false }));
    street.position.set(x0 - 7, 2.2, (wz0 + wz1) / 2);
    street.rotation.y = Math.PI / 2;
    this.group.add(street);
    this.streetMat = street.material;
    // Pavement just outside.
    const pave = new THREE.Mesh(new THREE.PlaneGeometry(7, 14), mat('#8f9c9e', { roughness: 0.2, metalness: 0.1 }));
    pave.rotation.x = -Math.PI / 2;
    pave.position.set(x0 - 3.5, -0.05, -0.5);
    this.group.add(pave);

    const N = QUALITY.rain;
    const geo = new THREE.BufferGeometry();
    this.rain = { N, pos: new Float32Array(N * 6), speed: new Float32Array(N) };
    for (let i = 0; i < N; i++) this._resetDrop(i, true);
    geo.setAttribute('position', new THREE.BufferAttribute(this.rain.pos, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#dbe7ec', transparent: true, opacity: 0.55 }));
    lines.frustumCulled = false;
    this.group.add(lines);
    this.rain.geo = geo;

    // Passers-by with umbrellas.
    this.walkers = [];
    const umbCols = ['#e46f6f', '#f6d68a', '#7a8fd6', '#5fae96', '#f2b38b'];
    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.7, 4, 8), mat(['#5f7f9a', '#9e6f8f', '#6f8f6f'][i]));
      body.position.y = 0.6;
      g.add(body);
      const umb = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), mat(umbCols[i % umbCols.length], { side: THREE.DoubleSide }));
      umb.position.y = 1.55;
      g.add(umb);
      g.position.set(x0 - 4 - i * 0.8, 0, -8 + i * 5);
      this.group.add(g);
      this.walkers.push({ g, speed: 0.6 + Math.random() * 0.5, dir: i % 2 ? 1 : -1, phase: Math.random() * 6 });
    }

    // Glass with sliding droplets painted on a canvas.
    const gc = document.createElement('canvas');
    gc.width = 256;
    gc.height = 160;
    this.dropCanvas = gc;
    this.dropCtx = gc.getContext('2d');
    this.dropTex = new THREE.CanvasTexture(gc);
    this.dropTex.colorSpace = THREE.SRGBColorSpace;
    this.drops = [];
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(wz1 - wz0, wy1 - wy0),
      new THREE.MeshBasicMaterial({ map: this.dropTex, transparent: true, depthWrite: false })
    );
    glass.position.set(x0 + 0.03, (wy0 + wy1) / 2, (wz0 + wz1) / 2);
    glass.rotation.y = Math.PI / 2;
    // The drops are painted only when the glass is about to be drawn, not on every update.
    glass.onBeforeRender = () => this._paintDroplets();
    this.group.add(glass);
    const letters = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 0.52), new THREE.MeshBasicMaterial({ map: windowLettering(), transparent: true, depthWrite: false }));
    letters.position.set(x0 + 0.035, wy0 + 0.55, (wz0 + wz1) / 2);
    letters.rotation.y = Math.PI / 2;
    this.group.add(letters);
    this.windowRect = { wz0, wz1, wy0, wy1 };
  }

  _resetDrop(i, anywhere) {
    const r = this.rain;
    const x = ROOM.x0 - 0.4 - Math.random() * 6;
    const y = anywhere ? Math.random() * 5 : 5 + Math.random();
    const z = -5 + Math.random() * 9;
    const len = 0.12 + Math.random() * 0.1;
    r.pos.set([x, y, z, x + 0.02, y - len, z - 0.01], i * 6);
    r.speed[i] = 6 + Math.random() * 3;
  }

  _tub() {
    const T = TUB;
    const steel = new THREE.MeshStandardMaterial({ color: '#c3cbd0', map: brushedSteel(), metalness: 0.55, roughness: 0.32, envMapIntensity: 1.4 });
    this.steel = steel;
    const x = T.x, z = T.z;
    const bottomY = T.floor - 0.04;
    const h = T.rim - bottomY;
    // Basin floor and four walls.
    this.box(T.w, 0.04, T.d, steel, x, bottomY + 0.02, z, 0.01);
    this.box(T.w, h, T.wall, steel, x, bottomY + h / 2, z - T.d / 2 + T.wall / 2, 0.015);
    this.box(T.w, h, T.wall, steel, x, bottomY + h / 2, z + T.d / 2 - T.wall / 2, 0.015);
    this.box(T.wall, h, T.d, steel, x - T.w / 2 + T.wall / 2, bottomY + h / 2, z, 0.015);
    this.box(T.wall, h, T.d, steel, x + T.w / 2 - T.wall / 2, bottomY + h / 2, z, 0.015);
    // Rolled rim.
    const rimMat = new THREE.MeshStandardMaterial({ color: '#b9c2c8', metalness: 0.9, roughness: 0.2 });
    for (const [w, d, ox, oz] of [[T.w + 0.03, 0.05, 0, -T.d / 2], [T.w + 0.03, 0.05, 0, T.d / 2], [0.05, T.d, -T.w / 2, 0], [0.05, T.d, T.w / 2, 0]]) {
      this.box(w, 0.035, d, rimMat, x + ox, T.rim, z + oz, 0.017);
    }
    // Legs.
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, bottomY, 10), rimMat);
      leg.position.set(x + ox * (T.w / 2 - 0.08), bottomY / 2, z + oz * (T.d / 2 - 0.08));
      this.add(leg);
    }
    // Drain.
    const drain = new THREE.Mesh(new THREE.CircleGeometry(0.045, 20), new THREE.MeshStandardMaterial({ color: '#59636a', metalness: 0.9, roughness: 0.35 }));
    drain.rotation.x = -Math.PI / 2;
    drain.position.set(x + T.w / 2 - 0.16, T.floor + 0.002, z);
    this.add(drain, false, true);
    this.drainPos = drain.position.clone();
    // Runoff water: a thin sheet whose colour shows what is washing off.
    this.runoff = new THREE.Mesh(
      new THREE.PlaneGeometry(T.w - T.wall * 2 - 0.01, T.d - T.wall * 2 - 0.01, 1, 1),
      new THREE.MeshStandardMaterial({ color: '#bfe6ef', transparent: true, opacity: 0, roughness: 0.05, metalness: 0.1, envMapIntensity: 1.5 })
    );
    this.runoff.rotation.x = -Math.PI / 2;
    this.runoff.position.set(x, T.floor + 0.006, z);
    this.runoff.renderOrder = 2;
    this.add(this.runoff, false, true);
    // A swirl over the drain.
    const swirlCanvas = document.createElement('canvas');
    swirlCanvas.width = swirlCanvas.height = 64;
    const sg = swirlCanvas.getContext('2d');
    sg.strokeStyle = 'rgba(255,255,255,0.8)';
    sg.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      sg.beginPath();
      for (let a = 0; a < 5; a += 0.1) sg.lineTo(32 + Math.cos(a + i * 2.1) * a * 5.5, 32 + Math.sin(a + i * 2.1) * a * 5.5);
      sg.stroke();
    }
    const swTex = new THREE.CanvasTexture(swirlCanvas);
    this.swirl = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), new THREE.MeshBasicMaterial({ map: swTex, transparent: true, opacity: 0, depthWrite: false }));
    this.swirl.rotation.x = -Math.PI / 2;
    this.swirl.position.copy(this.drainPos).add(new THREE.Vector3(0, 0.008, 0));
    this.group.add(this.swirl);

    // Faucet on the back wall.
    const chrome = new THREE.MeshStandardMaterial({ color: '#dfe5e8', metalness: 1, roughness: 0.15 });
    const spout = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.018, 10, 20, Math.PI), chrome);
    spout.position.set(x + 0.35, T.rim + 0.32, ROOM.z0 + 0.08);
    spout.rotation.z = Math.PI;
    spout.rotation.y = Math.PI / 2;
    this.add(spout);
    this.faucetPos = new THREE.Vector3(x + 0.35, T.rim + 0.3, ROOM.z0 + 0.1);

    this.colliders.push({ x0: x - T.w / 2 - 0.05, x1: x + T.w / 2 + 0.05, z0: ROOM.z0, z1: z + T.d / 2 + 0.05 });

    // Shelf of pastel shampoo bottles.
    const shelfY = 1.62;
    this.box(1.2, 0.035, 0.2, new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.7 }), x, shelfY, ROOM.z0 + 0.11, 0.01);
    const bottleCols = ['#f6a8c8', '#a8dccb', '#f6d68a', '#b9a2e6', '#f2b38b', '#9fd3e8'];
    this.bottles = [];
    bottleCols.forEach((c, i) => {
      const b = new THREE.Group();
      const hgt = 0.15 + (i % 3) * 0.04;
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, hgt - 0.07, 4, 12), mat(c, { roughness: 0.3 }));
      body.position.y = hgt / 2;
      body.castShadow = true;
      b.add(body);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.04, 10), mat('#f7fafa', { roughness: 0.3 }));
      cap.position.y = hgt + 0.01;
      b.add(cap);
      b.position.set(x - 0.5 + i * 0.19, shelfY + 0.018, ROOM.z0 + 0.12);
      this.group.add(b);
      this.bottles.push({ g: b, tilt: 0, vel: 0 });
    });

    // Towel rail with a peach towel (cloth sim).
    const railX0 = x - T.w / 2 - 0.62, railX1 = x - T.w / 2 - 0.08;
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, railX1 - railX0 + 0.1, 10), chrome);
    rail.rotation.z = Math.PI / 2;
    rail.position.set((railX0 + railX1) / 2, 1.32, ROOM.z0 + 0.09);
    this.add(rail);
    const towelMat = new THREE.MeshStandardMaterial({ color: '#F2B38B', roughness: 1, side: THREE.DoubleSide });
    this.towel = new Cloth(railX1 - railX0, 0.62, 8, 10, towelMat);
    this.towel.hang(new THREE.Vector3(railX0, 1.31, ROOM.z0 + 0.1), new THREE.Vector3(railX1, 1.31, ROOM.z0 + 0.1));
    this.group.add(this.towel.mesh);
  }

  _table() {
    const T = TABLE;
    const top = this.box(T.w, 0.05, T.d, mat('#e9eef0', { metalness: 0.3, roughness: 0.4 }), T.x, T.y - 0.025, T.z, 0.02);
    // Peach rubber mat with ridges.
    const matCanvas = document.createElement('canvas');
    matCanvas.width = 128;
    matCanvas.height = 64;
    const g = matCanvas.getContext('2d');
    g.fillStyle = '#F2B38B';
    g.fillRect(0, 0, 128, 64);
    g.fillStyle = 'rgba(180,100,60,0.18)';
    for (let i = 0; i < 128; i += 8) g.fillRect(i, 0, 3, 64);
    const mt = new THREE.CanvasTexture(matCanvas);
    mt.colorSpace = THREE.SRGBColorSpace;
    this.box(T.w - 0.06, 0.012, T.d - 0.06, new THREE.MeshStandardMaterial({ map: mt, roughness: 0.95 }), T.x, T.y + 0.003, T.z, 0.005);
    const legMat = new THREE.MeshStandardMaterial({ color: '#b9c2c8', metalness: 0.9, roughness: 0.25 });
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, T.y - 0.05, 10), legMat);
      leg.position.set(T.x + ox * (T.w / 2 - 0.07), (T.y - 0.05) / 2, T.z + oz * (T.d / 2 - 0.07));
      this.add(leg);
    }
    // Grooming arm: an upright post with a bent arm and a loop.
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.0, 10), legMat);
    post.position.set(T.x - T.w / 2 + 0.06, T.y + 0.5, T.z - T.d / 2 + 0.06);
    this.add(post);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.4, 10), legMat);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(T.x - T.w / 2 + 0.26, T.y + 1.0, T.z - T.d / 2 + 0.06);
    this.add(arm);
    this.colliders.push({ x0: T.x - T.w / 2 - 0.05, x1: T.x + T.w / 2 + 0.05, z0: T.z - T.d / 2 - 0.05, z1: T.z + T.d / 2 + 0.05 });
    // Tool cart beside the table.
    const cartMat = mat('#a8dccb', { roughness: 0.45 });
    this.box(0.5, 0.04, 0.38, cartMat, 2.35, 0.82, -2.45, 0.015);
    this.box(0.5, 0.04, 0.38, cartMat, 2.35, 0.42, -2.45, 0.015);
    for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.8, 8), legMat);
      p.position.set(2.35 + ox * 0.22, 0.42, -2.45 + oz * 0.16);
      this.add(p);
    }
    this.colliders.push({ x0: 2.05, x1: 2.65, z0: -2.7, z1: -2.2 });
  }

  _counter() {
    const C = COUNTER;
    const w = C.x1 - C.x0, d = C.z1 - C.z0;
    const wood = new THREE.MeshStandardMaterial({ map: woodTexture('#f0d2ae'), roughness: 0.55 });
    this.box(w, C.y - 0.06, d, mat('#F2B38B', { roughness: 0.6 }), (C.x0 + C.x1) / 2, (C.y - 0.06) / 2, (C.z0 + C.z1) / 2, 0.03);
    this.box(w + 0.08, 0.06, d + 0.08, wood, (C.x0 + C.x1) / 2, C.y - 0.03, (C.z0 + C.z1) / 2, 0.02);
    this.colliders.push({ x0: C.x0 - 0.05, x1: ROOM.x1, z0: C.z0 - 0.05, z1: C.z1 + 0.05 });

    // Register.
    const reg = new THREE.Group();
    const base = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.14, 0.26, 2, 0.03), mat('#a8dccb', { roughness: 0.4 }));
    base.position.y = 0.07;
    reg.add(base);
    const scr = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.11, 0.03, 2, 0.01), mat('#2f4a44', { roughness: 0.3, emissive: '#5fae96', emissiveIntensity: 0.35 }));
    scr.position.set(0, 0.2, -0.04);
    scr.rotation.x = -0.3;
    reg.add(scr);
    reg.position.set(2.5, C.y, 1.45);
    reg.rotation.y = -Math.PI / 2;
    reg.traverse((o) => (o.castShadow = true));
    this.group.add(reg);

    // Tip jar (glass) – coins land inside it.
    const jar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.07, 0.18, 20, 1, true),
      new THREE.MeshStandardMaterial({ color: '#dff1f4', roughness: 0.05, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
    );
    jar.position.set(2.45, C.y + 0.09, 0.95);
    this.group.add(jar);
    const jarBase = new THREE.Mesh(new THREE.CircleGeometry(0.07, 20), mat('#dff1f4', { roughness: 0.1 }));
    jarBase.rotation.x = -Math.PI / 2;
    jarBase.position.set(2.45, C.y + 0.003, 0.95);
    this.group.add(jarBase);
    this.tipJar = { x: 2.45, z: 0.95, y: C.y + 0.004, r: 0.065, h: 0.18 };
    const label = document.createElement('canvas');
    label.width = 128;
    label.height = 48;
    const lg = label.getContext('2d');
    lg.fillStyle = '#fffdf8';
    lg.fillRect(0, 0, 128, 48);
    lg.fillStyle = '#e08a5e';
    lg.font = '700 30px Caveat, cursive';
    lg.textAlign = 'center';
    lg.fillText('tips ♥', 64, 34);
    const lt = new THREE.CanvasTexture(label);
    lt.colorSpace = THREE.SRGBColorSpace;
    const lab = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.04), new THREE.MeshBasicMaterial({ map: lt }));
    lab.position.set(2.45 - 0.074, C.y + 0.1, 0.95);
    lab.rotation.y = -Math.PI / 2;
    this.group.add(lab);

    // Treat jar: interactable.
    const tj = new THREE.Group();
    const tjBody = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 20), new THREE.MeshStandardMaterial({ color: '#f7fafa', transparent: true, opacity: 0.55, roughness: 0.05 }));
    tjBody.position.y = 0.08;
    tj.add(tjBody);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.074, 0.074, 0.03, 20), mat('#f6a8c8', { roughness: 0.4 }));
    lid.position.y = 0.175;
    tj.add(lid);
    for (let i = 0; i < 7; i++) {
      const bone = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.035, 3, 6), mat('#d9a066', { roughness: 0.8 }));
      bone.position.set((Math.random() - 0.5) * 0.08, 0.02 + i * 0.016, (Math.random() - 0.5) * 0.08);
      bone.rotation.set(Math.random() * 3, Math.random() * 3, Math.PI / 2);
      tj.add(bone);
    }
    tj.position.set(2.45, C.y, 0.62);
    this.group.add(tj);
    this.treatJar = tj;
    this.interactables.push({ object: tjBody, id: 'treat', label: 'Give a treat' });

    // The salon catalogue (a chunky ring binder).
    const book = new THREE.Group();
    const cover = new THREE.Mesh(new RoundedBoxGeometry(0.26, 0.04, 0.2, 2, 0.01), mat('#5fae96', { roughness: 0.6 }));
    cover.position.y = 0.02;
    book.add(cover);
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.185), mat('#fffdf8', { roughness: 1 }));
    pages.position.set(0.006, 0.02, 0);
    book.add(pages);
    book.position.set(2.42, C.y, 1.85);
    book.rotation.y = -0.3;
    this.group.add(book);
    this.interactables.push({ object: cover, id: 'shop', label: 'Open the salon catalogue' });

    // Service bell.
    const sb = new THREE.Group();
    const sbBase = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.02, 20), mat('#2f4a44'));
    sb.add(sbBase);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.045, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat('#e8c35a', { metalness: 0.9, roughness: 0.2 }));
    dome.position.y = 0.01;
    sb.add(dome);
    sb.position.set(2.2, C.y + 0.01, 0.4);
    this.group.add(sb);
    this.interactables.push({ object: dome, id: 'bell', label: 'Ding!' });
    this.serviceBell = { g: sb, s: 0, v: 0 };
  }

  _decor() {
    const { x1, z0, z1 } = ROOM;
    // Poster and price board on the right wall.
    const poster = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.66), new THREE.MeshStandardMaterial({ map: posterTexture(), roughness: 0.8 }));
    poster.position.set(x1 - 0.01, 1.85, -1.1);
    poster.rotation.y = -Math.PI / 2;
    this.add(poster, false, true);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.7), new THREE.MeshStandardMaterial({ map: priceBoardTexture(), roughness: 0.9 }));
    board.position.set(x1 - 0.01, 1.85, 1.0);
    board.rotation.y = -Math.PI / 2;
    this.add(board, false, true);
    // A wall clock (ticks with a spring-loaded second hand).
    const clock = new THREE.Group();
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 32), mat('#fffdf8', { roughness: 0.6 }));
    face.rotation.x = Math.PI / 2;
    clock.add(face);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.018, 8, 32), mat('#F2B38B'));
    clock.add(rim);
    const handMat = mat('#22413b');
    this.clockHands = [];
    for (const [len, w] of [[0.09, 0.012], [0.13, 0.008], [0.14, 0.003]]) {
      const pivot = new THREE.Group();
      const hand = new THREE.Mesh(new THREE.BoxGeometry(w, len, 0.004), handMat);
      hand.position.y = len / 2 - 0.015;
      pivot.add(hand);
      pivot.position.z = 0.02;
      clock.add(pivot);
      this.clockHands.push(pivot);
    }
    clock.position.set(-0.75, 2.25, z0 + 0.02);
    this.group.add(clock);
    this.secondHand = { a: 0, v: 0, target: 0 };

    // Bench by the window for waiting owners.
    const benchMat = new THREE.MeshStandardMaterial({ map: woodTexture('#efd0a8'), roughness: 0.6 });
    this.box(0.42, 0.06, 1.3, benchMat, ROOM.x0 + 0.35, 0.45, 1.75, 0.02);
    this.box(0.36, 0.08, 1.2, mat('#b9a2e6', { roughness: 1 }), ROOM.x0 + 0.35, 0.51, 1.75, 0.035);
    for (const oz of [-0.55, 0.55]) this.box(0.38, 0.42, 0.05, benchMat, ROOM.x0 + 0.35, 0.21, 1.75 + oz, 0.01);
    this.colliders.push({ x0: ROOM.x0, x1: ROOM.x0 + 0.6, z0: 1.05, z1: 2.45 });

    // Upgrade props (hidden until bought).
    // Monstera by the window.
    const plant = new THREE.Group();
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.3, 18), mat('#e98f8f', { roughness: 0.7 }));
    pot.position.y = 0.15;
    plant.add(pot);
    this.leaves = [];
    for (let i = 0; i < 7; i++) {
      const stem = new THREE.Group();
      stem.position.y = 0.3;
      stem.rotation.y = (i / 7) * Math.PI * 2;
      const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), mat('#5f9e6e', { roughness: 0.7 }));
      leaf.scale.set(1, 0.12, 0.7);
      leaf.position.set(0, 0.32 + (i % 3) * 0.1, 0.16);
      leaf.rotation.x = 0.5;
      stem.add(leaf);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.4, 5), mat('#4f7f5a'));
      st.position.set(0, 0.18, 0.07);
      st.rotation.x = 0.4;
      stem.add(st);
      plant.add(stem);
      this.leaves.push({ g: stem, pend: new Pendulum(0.35, 1.8), base: stem.rotation.clone() });
    }
    plant.position.set(ROOM.x0 + 0.35, 0, -2.55);
    plant.traverse((o) => (o.castShadow = true));
    this.group.add(plant);
    this.upgradeObjects.plant = plant;

    const rug = new THREE.Mesh(new THREE.CircleGeometry(0.9, 40), new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 1 }));
    rug.rotation.x = -Math.PI / 2;
    rug.scale.set(1.4, 1, 1);
    rug.position.set(0, 0.004, -0.4);
    rug.receiveShadow = true;
    this.group.add(rug);
    this.upgradeObjects.rug = rug;

    // Fairy lights: a sagging verlet string along the back wall.
    const fairy = new THREE.Group();
    const n = 26;
    this.fairy = { n, p: [], prev: [], bulbs: [], a: new THREE.Vector3(-2.9, 2.6, z0 + 0.06), b: new THREE.Vector3(2.9, 2.6, z0 + 0.06), group: fairy };
    const bulbCols = ['#ffd27f', '#ff9ec4', '#9fe0c9', '#c9b6ff'];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const p = new THREE.Vector3().lerpVectors(this.fairy.a, this.fairy.b, t);
      p.y -= Math.sin(t * Math.PI * 4) ** 2 * 0.15;
      this.fairy.p.push(p);
      this.fairy.prev.push(p.clone());
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshBasicMaterial({ color: bulbCols[i % 4] }));
      fairy.add(bulb);
      this.fairy.bulbs.push(bulb);
    }
    this.fairy.wire = new THREE.Line(new THREE.BufferGeometry().setFromPoints(this.fairy.p), new THREE.LineBasicMaterial({ color: '#4f6e67' }));
    fairy.add(this.fairy.wire);
    this.group.add(fairy);
    this.upgradeObjects.lights = fairy;

    // Radio on the counter.
    const radio = new THREE.Group();
    const rb = new THREE.Mesh(new RoundedBoxGeometry(0.28, 0.16, 0.1, 2, 0.03), mat('#f6d68a', { roughness: 0.5 }));
    rb.position.y = 0.08;
    radio.add(rb);
    const spk = new THREE.Mesh(new THREE.CircleGeometry(0.05, 20), mat('#22413b', { roughness: 0.9 }));
    spk.position.set(-0.06, 0.08, 0.051);
    radio.add(spk);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.008, 6, 20, Math.PI), mat('#22413b'));
    handle.position.y = 0.16;
    radio.add(handle);
    radio.position.set(2.5, COUNTER.y, 1.75);
    radio.rotation.y = -Math.PI / 2;
    this.group.add(radio);
    this.upgradeObjects.radio = radio;
    this.radioSpeaker = spk;
    this.interactables.push({ object: rb, id: 'radio', label: 'Toggle the radio' });
  }

  _lamps() {
    const shadeMat = mat('#F7FAFA', { roughness: 0.5, side: THREE.DoubleSide });
    this.lamps = [];
    for (const [x, z] of [[-1.25, -2.0], [1.25, -1.95], [0, 0.6]]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, ROOM.h, z);
      const len = 0.62;
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, len), mat('#4f6e67'));
      cord.position.y = -len / 2;
      pivot.add(cord);
      const shade = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), shadeMat);
      shade.position.y = -len - 0.02;
      shade.castShadow = false;
      pivot.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshBasicMaterial({ color: '#fff1d6' }));
      bulb.position.y = -len - 0.06;
      pivot.add(bulb);
      const light = new THREE.PointLight('#ffd9a8', 2.6, 6, 1.6);
      light.position.y = -len - 0.1;
      pivot.add(light);
      this.group.add(pivot);
      const pend = new Pendulum(len, 0.35);
      pend.push((Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3);
      this.lamps.push({ pivot, pend, len });
    }
  }

  _photoWall() {
    const board = new THREE.Mesh(new RoundedBoxGeometry(1.25, 0.82, 0.03, 2, 0.015), new THREE.MeshStandardMaterial({ map: corkTexture(), roughness: 1 }));
    board.position.set(0.05, 1.82, ROOM.z0 + 0.02);
    this.add(board, true, true);
    const frame = mat('#F7FAFA');
    this.box(1.31, 0.04, 0.04, frame, 0.05, 2.25, ROOM.z0 + 0.03, 0.01);
    this.box(1.31, 0.04, 0.04, frame, 0.05, 1.39, ROOM.z0 + 0.03, 0.01);
    // Title.
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 80;
    const g = c.getContext('2d');
    g.font = '400 54px Sniglet, sans-serif';
    g.fillStyle = '#22413b';
    g.textAlign = 'center';
    g.fillText('Wall of Fluff', 256, 58);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const title = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.1), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
    title.position.set(0.05, 2.36, ROOM.z0 + 0.02);
    this.group.add(title);
    this.setPhotoSlots(8);
  }

  setPhotoSlots(n) {
    const cols = n > 8 ? 6 : 4;
    const rows = Math.ceil(n / cols);
    const W = 1.12, H = 0.7;
    const slots = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols && slots.length < n; c++) {
        const x = 0.05 - W / 2 + (W / cols) * (c + 0.5);
        const y = 2.17 - (H / rows) * r;
        slots.push(new THREE.Vector3(x + (Math.random() - 0.5) * 0.03, y, ROOM.z0 + 0.045));
      }
    this.photoSlots = slots;
    this.photoScale = cols > 4 ? 0.72 : 1;
  }

  _hoses() {
    const hoseMat = new THREE.MeshStandardMaterial({ color: '#9fd3e8', roughness: 0.35 });
    this.sprayHose = new Rope(40, 3.8, 0.014, hoseMat);
    this.sprayHose.reset(this.faucetPos, this.faucetPos.clone().add(new THREE.Vector3(0.2, -0.5, 0.6)));
    this.group.add(this.sprayHose.mesh);
    // Dryer hose comes from a wall unit by the table.
    const unit = this.box(0.32, 0.4, 0.22, mat('#b9a2e6', { roughness: 0.5 }), 2.2, 1.55, ROOM.z0 + 0.12, 0.04);
    const grill = new THREE.Mesh(new THREE.CircleGeometry(0.1, 20), mat('#2f4a44'));
    grill.position.set(2.2, 1.55, ROOM.z0 + 0.235);
    this.group.add(grill);
    this.dryerOrigin = new THREE.Vector3(2.2, 1.4, ROOM.z0 + 0.2);
    const dryerHoseMat = new THREE.MeshStandardMaterial({ color: '#c9b6ff', roughness: 0.5 });
    this.dryerHose = new Rope(36, 3.8, 0.022, dryerHoseMat);
    this.dryerHose.reset(this.dryerOrigin, this.dryerOrigin.clone().add(new THREE.Vector3(-0.5, -0.6, 0.6)));
    this.group.add(this.dryerHose.mesh);
    this.sprayHose.mesh.visible = false;
    this.dryerHose.mesh.visible = false;
    this.hoseCollide = this.hoseCollide.bind(this);
    this.hoseOverRim = this.hoseOverRim.bind(this);
    this.hoseSolids = this._hoseSolids();
    this.hoseDog = null;
  }

  // ------------------------------------------------------------------
  // Where does a falling particle hit something? Returns null or {kind, y}.
  surface(x, y, z) {
    const T = TUB;
    const tx0 = T.x - T.w / 2, tx1 = T.x + T.w / 2, tz0 = T.z - T.d / 2, tz1 = T.z + T.d / 2;
    if (x > tx0 && x < tx1 && z > tz0 && z < tz1) {
      const ix0 = tx0 + T.wall, ix1 = tx1 - T.wall, iz0 = tz0 + T.wall, iz1 = tz1 - T.wall;
      if (x > ix0 && x < ix1 && z > iz0 && z < iz1) {
        if (y < T.floor) return { kind: 'tub', y: T.floor };
      } else if (y < T.rim) return { kind: 'tubwall', y: T.rim };
      if (y < T.floor - 0.05) return { kind: 'tubwall', y: T.floor };
    }
    const B = TABLE;
    if (y < B.y && y > B.y - 0.08 && Math.abs(x - B.x) < B.w / 2 && Math.abs(z - B.z) < B.d / 2) return { kind: 'table', y: B.y };
    const C = COUNTER;
    if (y < C.y && x > C.x0 && x < C.x1 && z > C.z0 && z < C.z1) return { kind: 'table', y: C.y };
    if (y < 0) return { kind: 'floor', y: 0 };
    if (x < ROOM.x0 + 0.02 || x > ROOM.x1 - 0.02 || z < ROOM.z0 + 0.02 || z > ROOM.z1 - 0.02) return { kind: 'wall', y };
    if (y > ROOM.h) return { kind: 'ceiling', y: ROOM.h };
    return null;
  }

  // Runoff: water draining into the tub tints the sheet; it clears as clean water flows.
  addRunoff(n, dirtSum) {
    if (n <= 0) return;
    const avg = dirtSum / n;
    const k = Math.min(1, n * 0.035);
    this.tubDirt += (avg - this.tubDirt) * k;
    this.tubFlow = Math.min(1, this.tubFlow + n * 0.012);
  }

  splashFloor(x, z) {
    // Puddles on the floor from stray spray; they evaporate.
    let p = this.puddles.find((q) => Math.hypot(q.x - x, q.z - z) < 0.25);
    if (!p) {
      if (this.puddles.length > 24) return;
      const m = new THREE.Mesh(new THREE.CircleGeometry(1, 20), new THREE.MeshStandardMaterial({ color: '#cfeef5', transparent: true, opacity: 0.5, roughness: 0.02, metalness: 0.2, envMapIntensity: 2 }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.003, z);
      m.scale.setScalar(0.01);
      m.renderOrder = 1;
      this.group.add(m);
      p = { x, z, size: 0.02, m };
      this.puddles.push(p);
    }
    p.size = Math.min(0.32, p.size + 0.004);
  }

  ringBell() {
    this.bell.pend.push(3, 1);
  }

  openDoor(open) {
    this.door.target = open ? -1.45 : 0;
    this.door.vel += open ? -1.5 : 0.5;
  }

  pressServiceBell() {
    this.serviceBell.v -= 2;
  }

  setUpgrades(owned) {
    for (const [k, obj] of Object.entries(this.upgradeObjects)) obj.visible = !!owned[k];
    this.setPhotoSlots(owned.frames ? 12 : 8);
  }

  // Day light: 0 morning … 1 evening.
  setDayPhase(t) {
    const morning = new THREE.Color('#d8e6e8'), evening = new THREE.Color('#e8b48f');
    this.streetMat.color.copy(morning).lerp(evening, t).multiplyScalar(1 - t * 0.35);
  }

  update(dt, ctx) {
    this.time += dt;
    const wind = ctx.wind;
    // Rain.
    const r = this.rain;
    for (let i = 0; i < r.N; i++) {
      const o = i * 6;
      const dy = r.speed[i] * dt;
      r.pos[o + 1] -= dy;
      r.pos[o + 4] -= dy;
      r.pos[o] += dy * 0.04;
      r.pos[o + 3] += dy * 0.04;
      if (r.pos[o + 4] < 0) this._resetDrop(i, false);
    }
    r.geo.attributes.position.needsUpdate = true;
    for (const w of this.walkers) {
      w.g.position.z += w.speed * w.dir * dt;
      w.g.position.y = Math.abs(Math.sin(this.time * 5 + w.phase)) * 0.04;
      w.g.rotation.z = Math.sin(this.time * 5 + w.phase) * 0.05;
      if (w.g.position.z > 9) w.g.position.z = -9;
      if (w.g.position.z < -9) w.g.position.z = 9;
    }
    this._updateDroplets(dt);

    // Lamps swing on their pendulums (the dryer and the door both nudge them).
    for (const L of this.lamps) {
      if (wind) {
        _v.set(0, 0, 0);
        wind(L.pivot.position.clone().setY(ROOM.h - L.len), _v);
        L.pend.push(_v.z * dt * 0.05, -_v.x * dt * 0.05);
      }
      L.pend.update(dt);
      L.pivot.rotation.set(L.pend.ax, 0, L.pend.az);
    }
    // Door closer: a damped spring.
    const d = this.door;
    const prevA = d.angle;
    d.vel += (40 * (d.target - d.angle) - 7 * d.vel) * dt;
    d.angle += d.vel * dt;
    if (d.angle > 0.02) {
      d.angle = 0.02;
      d.vel *= -0.3;
    }
    d.pivot.rotation.y = d.angle;
    if (Math.abs(d.angle - prevA) > 0.02) this.bell.pend.push((d.angle - prevA) * 30, 0);
    this.bell.pend.update(dt);
    this.bell.pivot.rotation.set(this.bell.pend.ax, 0, this.bell.pend.az);
    this.bellSwing = Math.abs(this.bell.pend.vx) + Math.abs(this.bell.pend.vz);

    // Service bell dome bounce.
    const sb = this.serviceBell;
    sb.v += (-300 * sb.s - 12 * sb.v) * dt;
    sb.s += sb.v * dt;
    sb.g.scale.set(1 + sb.s * 0.5, 1 - sb.s, 1 + sb.s * 0.5);

    // Towel flutters in the dryer wind.
    this.towel.update(dt, wind, ROOM.z0 + 0.06);

    // Plant leaves.
    if (this.upgradeObjects.plant.visible) {
      for (const L of this.leaves) {
        if (wind) {
          _v.set(0, 0, 0);
          wind(this.upgradeObjects.plant.position.clone().setY(0.6), _v);
          L.pend.push(_v.z * dt * 0.08 + (Math.random() - 0.5) * 0.02, -_v.x * dt * 0.08);
        }
        L.pend.update(dt);
        L.g.rotation.set(L.base.x + L.pend.ax * 0.5, L.base.y, L.base.z + L.pend.az * 0.5);
      }
    }
    // Fairy lights.
    if (this.upgradeObjects.lights.visible) this._updateFairy(dt, wind);

    // Radio speaker pulses with the music.
    if (this.upgradeObjects.radio.visible) this.radioSpeaker.scale.setScalar(1 + (ctx.musicOn ? Math.max(0, Math.sin(this.time * 8)) * 0.08 : 0));

    // Clock: the second hand ticks and overshoots on a spring.
    const now = ctx.clockSeconds ?? this.time;
    const sh = this.secondHand;
    sh.target = -Math.floor(now % 60) * ((Math.PI * 2) / 60);
    sh.v += (500 * (sh.target - sh.a) - 18 * sh.v) * dt;
    sh.a += sh.v * dt;
    if (Math.abs(sh.target - sh.a) > 1) sh.a = sh.target;
    this.clockHands[2].rotation.z = sh.a;
    this.clockHands[1].rotation.z = -((now / 3600) % 1) * Math.PI * 2;
    this.clockHands[0].rotation.z = -((now / 43200) % 1) * Math.PI * 2;

    // Runoff sheet and drain swirl.
    this.tubFlow = Math.max(0, this.tubFlow - dt * 0.35);
    const rc = new THREE.Color('#bfe6ef').lerp(new THREE.Color('#7A5A3C'), Math.min(1, this.tubDirt * 1.2));
    this.runoff.material.color.copy(rc);
    this.runoff.material.opacity = Math.min(0.85, this.tubFlow * 1.2);
    this.swirl.material.opacity = Math.min(0.7, this.tubFlow);
    this.swirl.rotation.z -= dt * 6;
    if (this.tubFlow < 0.05) this.tubDirt *= Math.exp(-dt * 0.5);

    // Puddles evaporate.
    for (let i = this.puddles.length - 1; i >= 0; i--) {
      const p = this.puddles[i];
      p.size -= dt * 0.006;
      p.m.scale.setScalar(Math.max(0.001, p.size));
      if (p.size <= 0) {
        p.m.removeFromParent();
        p.m.geometry.dispose();
        this.puddles.splice(i, 1);
      }
    }

    // Hoses follow the fitting on the bottom of the tool in hand.
    this.hoseDog = ctx.dog ?? null;
    for (const [hose, end] of [[this.sprayHose, ctx.sprayEnd], [this.dryerHose, ctx.dryerEnd]]) {
      if (!hose.mesh.visible || !end) continue;
      hose.end.copy(end.at);
      hose.endDir = end.dir;
      hose.update(dt, this.hoseCollide, hose === this.sprayHose ? wind : null, this.hoseOverRim);
    }
  }

  // Solid boxes a hose rests on or drapes over: the tub (everything under the basin floor counts as
  // solid, so hoses never sneak under it), its walls with the rolled rim, the grooming table top and
  // the counter. [x0, y0, z0, x1, y1, z1]
  _hoseSolids() {
    const T = TUB, w = T.wall + 0.012, top = T.rim + 0.018;
    const tx0 = T.x - T.w / 2, tx1 = T.x + T.w / 2, tz0 = T.z - T.d / 2, tz1 = T.z + T.d / 2;
    const B = TABLE, C = COUNTER;
    this.tubBox = { x0: tx0, x1: tx1, z0: tz0, z1: tz1, ix0: tx0 + w, ix1: tx1 - w, iz0: tz0 + w, iz1: tz1 - w, top };
    return [
      [tx0, 0, tz0, tx1, T.floor, tz1],
      [tx0, 0, tz0, tx1, top, tz0 + w],
      [tx0, 0, tz1 - w, tx1, top, tz1],
      [tx0, 0, tz0, tx0 + w, top, tz1],
      [tx1 - w, 0, tz0, tx1, top, tz1],
      [B.x - B.w / 2, B.y - 0.05, B.z - B.d / 2, B.x + B.w / 2, B.y, B.z + B.d / 2],
      [C.x0, 0, C.z0, C.x1, C.y, C.z1],
    ];
  }

  // A hose segment from inside the basin to outside the tub must pass over the rim, not through
  // the wall: lift its low end(s) onto the rim. `fa`/`fb` say whether an end is pinned.
  hoseOverRim(a, b, r, fa, fb) {
    const t = this.tubBox;
    const inA = a.x > t.ix0 && a.x < t.ix1 && a.z > t.iz0 && a.z < t.iz1;
    const inB = b.x > t.ix0 && b.x < t.ix1 && b.z > t.iz0 && b.z < t.iz1;
    if (inA === inB) return;
    const outA = a.x < t.x0 || a.x > t.x1 || a.z < t.z0 || a.z > t.z1;
    const outB = b.x < t.x0 || b.x > t.x1 || b.z < t.z0 || b.z > t.z1;
    if (!(outA || outB)) return;
    const lip = t.top + r;
    if (Math.min(a.y, b.y) >= lip) return;
    if (!fa && a.y < lip) a.y = lip;
    if (!fb && b.y < lip) b.y = lip;
  }

  // Keep a hose point out of the solids, the walls and the dog. True when it touched something.
  hoseCollide(p, r) {
    let hit = false;
    for (const b of this.hoseSolids) {
      const x0 = b[0] - r, y0 = b[1] - r, z0 = b[2] - r, x1 = b[3] + r, y1 = b[4] + r, z1 = b[5] + r;
      if (p.x <= x0 || p.x >= x1 || p.y <= y0 || p.y >= y1 || p.z <= z0 || p.z >= z1) continue;
      // Out through the nearest face, preferring the top so hoses settle onto things.
      const dx0 = p.x - x0, dx1 = x1 - p.x, dy0 = p.y - y0, dy1 = y1 - p.y, dz0 = p.z - z0, dz1 = z1 - p.z;
      const m = Math.min(dx0, dx1, dy0, dy1, dz0, dz1);
      if (m === dy1) p.y = y1;
      else if (m === dx0) p.x = x0;
      else if (m === dx1) p.x = x1;
      else if (m === dz0) p.z = z0;
      else if (m === dz1) p.z = z1;
      else p.y = y0;
      hit = true;
    }
    if (p.y < r) {
      p.y = r;
      hit = true;
    }
    p.x = Math.min(ROOM.x1 - r, Math.max(ROOM.x0 + r, p.x));
    p.z = Math.min(ROOM.z1 - r, Math.max(ROOM.z0 + r, p.z));
    if (this.hoseDog && this.hoseDog.colliders.pushOut(p, r + 0.012) >= 0) hit = true;
    return hit;
  }

  _updateFairy(dt, wind) {
    const F = this.fairy;
    const g = -9.81 * dt * dt;
    for (let i = 1; i < F.n - 1; i++) {
      const p = F.p[i], pv = F.prev[i];
      const vx = (p.x - pv.x) * 0.98, vy = (p.y - pv.y) * 0.98, vz = (p.z - pv.z) * 0.98;
      pv.copy(p);
      p.x += vx;
      p.y += vy + g;
      p.z += vz;
      if (wind) {
        _v.set(0, 0, 0);
        wind(p, _v);
        p.addScaledVector(_v, dt * dt * 0.2);
      }
      if (p.z < ROOM.z0 + 0.03) p.z = ROOM.z0 + 0.03;
    }
    const seg = (F.b.x - F.a.x) / (F.n - 1) * 1.06;
    F.p[0].copy(F.a);
    F.p[F.n - 1].copy(F.b);
    for (let it = 0; it < 4; it++) {
      for (let i = 0; i < F.n - 1; i++) {
        const a = F.p[i], b = F.p[i + 1];
        _v.subVectors(b, a);
        const d = _v.length();
        const diff = (d - seg) / d;
        const wa = i === 0 ? 0 : 0.5, wb = i + 1 === F.n - 1 ? 0 : 0.5;
        const s = wa + wb || 1;
        a.addScaledVector(_v, (wa / s) * diff);
        b.addScaledVector(_v, -(wb / s) * diff);
      }
    }
    F.bulbs.forEach((b, i) => {
      b.position.copy(F.p[i]);
      b.position.y -= 0.02;
      b.material.color.offsetHSL(0, 0, 0);
    });
    F.wire.geometry.setFromPoints(F.p);
  }

  _updateDroplets(dt) {
    const W = this.dropCanvas.width, H = this.dropCanvas.height;
    // Spawn a new drop every so often; they cling, then slide when heavy enough.
    if (this.drops.length < 70 && Math.random() < dt * 25) {
      this.drops.push({ x: Math.random() * W, y: Math.random() * H * 0.9, r: 1 + Math.random() * 2.2, vy: 0, stick: Math.random() * 2 });
    }
    this._dropT = (this._dropT || 0) + dt;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.stick -= dt;
      if (d.r > 2.6 && d.stick <= 0) {
        d.vy += 60 * dt * (d.r / 3);
        d.vy *= 0.92;
        d.y += d.vy * dt * 10;
        d.x += Math.sin(d.y * 0.2 + i) * 0.15;
        d.r -= dt * 0.25; // leaves a trail behind
        if (Math.random() < dt * 4) d.stick = Math.random() * 0.4;
      }
      if (d.y > H + 5 || d.r < 0.8) this.drops.splice(i, 1);
    }
    // Merge touching drops.
    for (let i = 0; i < this.drops.length; i++)
      for (let j = i + 1; j < this.drops.length; j++) {
        const a = this.drops[i], b = this.drops[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) {
          a.r = Math.sqrt(a.r * a.r + b.r * b.r);
          a.y = Math.max(a.y, b.y);
          this.drops.splice(j, 1);
          j--;
        }
      }
  }

  // Repaint the glass, at most 20 times a second.
  _paintDroplets() {
    if (this._dropT < 1 / 20) return;
    this._dropT = 0;
    const g = this.dropCtx;
    const W = this.dropCanvas.width, H = this.dropCanvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(220,235,240,0.08)';
    g.fillRect(0, 0, W, H);
    for (const d of this.drops) {
      const grd = g.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, d.r * 0.1, d.x, d.y, d.r);
      grd.addColorStop(0, 'rgba(255,255,255,0.85)');
      grd.addColorStop(0.6, 'rgba(200,220,228,0.35)');
      grd.addColorStop(1, 'rgba(90,110,120,0.5)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(d.x, d.y, d.r, d.r * (1 + Math.min(0.6, d.vy * 0.02)), 0, 0, Math.PI * 2);
      g.fill();
    }
    this.dropTex.needsUpdate = true;
  }
}
