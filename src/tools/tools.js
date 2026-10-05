import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { Spring, Spring3 } from '../core/springs.js';
import { clamp, smoothstep } from '../core/math.js';
import { GUARDS, BOW_COLORS } from '../dog/breeds.js';
import { REGION, K } from '../dog/fur.js';

export const TOOL_DEFS = [
  { id: 'hands', name: 'Hands', verb: 'Scrub · pet · pop bubbles' },
  { id: 'spray', name: 'Sprayer', verb: 'Soak & rinse' },
  { id: 'shampoo', name: 'Shampoo', verb: 'Squirt shampoo' },
  { id: 'dryer', name: 'Dryer', verb: 'Blow-dry' },
  { id: 'brush', name: 'Slicker brush', verb: 'Brush out mats' },
  { id: 'clippers', name: 'Clippers', verb: 'Clip to the guard' },
  { id: 'bow', name: 'Bow', verb: 'Tie a bow' },
  { id: 'camera', name: 'Camera', verb: 'Photo for the wall' },
];

const SCENTS = [
  { name: 'Peach', hex: '#f6b49a' },
  { name: 'Bubblegum', hex: '#f6a8c8' },
  { name: 'Mint', hex: '#9fe0c9' },
  { name: 'Lavender', hex: '#c9b6ff' },
];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const FWD = new THREE.Vector3(0, 0, -1);
const col3 = [0, 0, 0];

// Launch velocity that arcs from `from` through `to` at roughly `speed`.
function ballistic(from, to, speed, out) {
  out.subVectors(to, from);
  const d = out.length() || 1e-3;
  const t = d / speed;
  out.multiplyScalar(1 / t);
  out.y += 0.5 * 9.81 * t;
  return out;
}

function M(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.42, ...opts });
}
function rbox(w, h, d, r, material) {
  return new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), material);
}

// Chunky pastel tool models, built from primitives. Forward is -Z.
function buildModels() {
  const steel = M('#c9d1d6', { metalness: 0.85, roughness: 0.25 });
  const models = {};

  // Hands: a soft grooming mitt.
  {
    const g = new THREE.Group();
    const mitt = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), M('#f6c7a7', { roughness: 0.75 }));
    mitt.scale.set(1.1, 0.7, 1.4);
    g.add(mitt);
    const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), mitt.material);
    thumb.position.set(-0.05, 0.005, -0.01);
    thumb.scale.set(1, 0.8, 1.5);
    g.add(thumb);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.048, 0.04, 16), M('#a8dccb'));
    cuff.rotation.x = Math.PI / 2;
    cuff.position.z = 0.07;
    g.add(cuff);
    models.hands = { g, tip: new THREE.Vector3(0, 0, -0.07), reach: true };
  }
  // Sprayer.
  {
    const g = new THREE.Group();
    const handle = rbox(0.04, 0.12, 0.05, 0.018, M('#a8dccb'));
    handle.position.set(0, -0.05, 0.02);
    handle.rotation.x = 0.35;
    g.add(handle);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.15, 16), steel);
    head.rotation.x = Math.PI / 2;
    head.position.set(0, 0.01, -0.05);
    g.add(head);
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.03, 0.03, 18), M('#f7fafa', { roughness: 0.3 }));
    rose.rotation.x = Math.PI / 2;
    rose.position.set(0, 0.01, -0.13);
    g.add(rose);
    const trigger = rbox(0.018, 0.05, 0.02, 0.008, M('#F2B38B'));
    trigger.position.set(0, -0.03, -0.02);
    g.add(trigger);
    models.spray = { g, tip: new THREE.Vector3(0, 0.01, -0.15), trigger, rose };
  }
  // Shampoo bottle.
  {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.1, 6, 16), M('#f6a8c8', { roughness: 0.25 }));
    body.rotation.x = -Math.PI / 2 + 0.25;
    g.add(body);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.06, 14), M('#f7fafa'));
    cap.rotation.x = -Math.PI / 2 + 0.25;
    cap.position.set(0, 0.024, -0.1);
    g.add(cap);
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0405, 0.0405, 0.05, 16, 1, true), M('#fffdf8'));
    label.rotation.x = -Math.PI / 2 + 0.25;
    g.add(label);
    models.shampoo = { g, tip: new THREE.Vector3(0, 0.032, -0.13), body };
  }
  // Dryer.
  {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.06, 18, 12), M('#c9b6ff'));
    body.scale.set(1, 1, 1.15);
    body.position.z = 0.02;
    g.add(body);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.14, 18), M('#c9b6ff'));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.08;
    g.add(barrel);
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.035, 0.03, 18, 1, true), M('#2f4a44', { side: THREE.DoubleSide }));
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.z = -0.16;
    g.add(nozzle);
    const handle = rbox(0.036, 0.12, 0.045, 0.016, M('#f7fafa'));
    handle.position.set(0, -0.08, 0.04);
    handle.rotation.x = 0.2;
    g.add(handle);
    const fan = new THREE.Mesh(new THREE.CircleGeometry(0.03, 6), M('#e8e2ff'));
    fan.position.z = -0.17;
    fan.rotation.y = Math.PI;
    g.add(fan);
    models.dryer = { g, tip: new THREE.Vector3(0, 0, -0.18), fan };
  }
  // Slicker brush.
  {
    const g = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.12, 4, 10), M('#F2B38B'));
    handle.rotation.x = Math.PI / 2;
    handle.position.z = 0.06;
    g.add(handle);
    const head = rbox(0.09, 0.022, 0.07, 0.01, M('#f7fafa'));
    head.position.set(0, 0, -0.05);
    g.add(head);
    const bristles = new THREE.Group();
    const pin = new THREE.CylinderGeometry(0.0018, 0.0018, 0.022, 4);
    for (let i = 0; i < 7; i++)
      for (let j = 0; j < 5; j++) {
        const b = new THREE.Mesh(pin, steel);
        b.position.set(-0.036 + i * 0.012, -0.02, -0.075 + j * 0.012);
        bristles.add(b);
      }
    g.add(bristles);
    models.brush = { g, tip: new THREE.Vector3(0, -0.03, -0.05), reach: true, head: g };
  }
  // Clippers.
  {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.12, 6, 16), M('#a8dccb'));
    body.rotation.x = Math.PI / 2;
    body.scale.set(1, 1, 0.85);
    g.add(body);
    const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.025, 16), M('#F2B38B'));
    stripe.rotation.x = Math.PI / 2;
    stripe.position.z = 0.02;
    g.add(stripe);
    const blade = rbox(0.06, 0.012, 0.03, 0.004, steel);
    blade.position.set(0, -0.005, -0.1);
    g.add(blade);
    const guard = rbox(0.062, 0.03, 0.04, 0.008, M('#f6d68a', { transparent: true, opacity: 0.85 }));
    guard.position.set(0, -0.018, -0.105);
    g.add(guard);
    models.clippers = { g, tip: new THREE.Vector3(0, -0.02, -0.12), reach: true, guard };
  }
  // Bow (in hand).
  {
    const g = new THREE.Group();
    const m = M('#7fd1b4', { roughness: 0.35 });
    for (const s of [-1, 1]) {
      const loop = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.012, 8, 16), m);
      loop.position.x = s * 0.03;
      loop.scale.set(1, 0.7, 0.55);
      g.add(loop);
    }
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), m));
    models.bow = { g, tip: new THREE.Vector3(0, 0, -0.03), mat: m, reach: true };
  }
  // Instant camera.
  {
    const g = new THREE.Group();
    const body = rbox(0.16, 0.12, 0.08, 0.02, M('#f7fafa', { roughness: 0.35 }));
    g.add(body);
    const top = rbox(0.16, 0.03, 0.08, 0.012, M('#F2B38B'));
    top.position.y = 0.06;
    g.add(top);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.038, 0.03, 20), M('#2f4a44', { roughness: 0.2 }));
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, -0.005, -0.05);
    g.add(lens);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(0.026, 20), M('#7fb6d9', { roughness: 0.05, metalness: 0.5 }));
    glass.position.set(0, -0.005, -0.066);
    glass.rotation.y = Math.PI;
    g.add(glass);
    const flash = rbox(0.035, 0.02, 0.01, 0.004, new THREE.MeshBasicMaterial({ color: '#fff7d6' }));
    flash.position.set(0.05, 0.035, -0.041);
    g.add(flash);
    models.camera = { g, tip: new THREE.Vector3(0, 0, -0.07), flash };
  }
  for (const k of Object.keys(models)) {
    models[k].g.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = false;
        o.renderOrder = 3;
      }
    });
  }
  return models;
}

export class Tools {
  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.rig = new THREE.Group();
    this.camera.add(this.rig);
    this.models = buildModels();
    for (const def of TOOL_DEFS) {
      const m = this.models[def.id];
      m.g.visible = false;
      this.rig.add(m.g);
    }
    this.index = 0;
    this.current = this.models.hands;
    this.current.g.visible = true;
    this.rest = new THREE.Vector3(0.22, -0.2, -0.45);
    this.pos = new Spring3(170, 17);
    this.pos.snap(this.rest);
    this.rot = new Spring3(120, 13); // small euler offsets
    this.drop = new Spring(0, 150, 13);
    this.kick = new Spring(0, 400, 18);
    this.aimQuat = new THREE.Quaternion();

    this.sprayMode = 0; // 0 jet, 1 shower
    this.guard = 2;
    this.bowColor = 0;
    this.scent = 0;
    this.dryerHigh = true;

    this.using = false;
    this.prevHit = null;
    this.hit = null;
    this.target = new THREE.Vector3();
    this.nozzleWorld = new THREE.Vector3();
    this.nozzleDir = new THREE.Vector3(0, 0, -1);
    this.dryerOn = 0;
    this.sprayAcc = 0;
    this.gelAcc = 0;
    this.tuftAcc = 0;
    this.snipAcc = 0;
    this.faceTimer = 0;
    this.hint = '';
    this.windAt = this.windAt.bind(this);
  }

  get id() {
    return TOOL_DEFS[this.index].id;
  }

  select(i) {
    i = (i + TOOL_DEFS.length) % TOOL_DEFS.length;
    if (i === this.index) return;
    this.current.g.visible = false;
    this.index = i;
    this.current = this.models[this.id];
    this.current.g.visible = true;
    this.drop.value = -0.3;
    this.drop.velocity = 0;
    this.game.audio.click();
    this.game.hud.selectTool(i);
    const sal = this.game.salon;
    sal.sprayHose.mesh.visible = this.id === 'spray';
    sal.dryerHose.mesh.visible = this.id === 'dryer';
    if (this.id === 'spray') sal.sprayHose.reset(sal.faucetPos, this.nozzleWorld.lengthSq() ? this.nozzleWorld : sal.faucetPos);
    if (this.id === 'dryer') sal.dryerHose.reset(sal.dryerOrigin, this.nozzleWorld.lengthSq() ? this.nozzleWorld : sal.dryerOrigin);
    this._optionLabel();
  }

  alt() {
    const g = this.game;
    switch (this.id) {
      case 'spray':
        this.sprayMode = 1 - this.sprayMode;
        g.toast(this.sprayMode ? 'Gentle shower' : 'Jet stream');
        break;
      case 'shampoo':
        this.scent = (this.scent + 1) % SCENTS.length;
        g.gel.mesh.material.color.set(SCENTS[this.scent].hex);
        g.gel.mesh.material.emissive.set(SCENTS[this.scent].hex);
        this.models.shampoo.body.material.color.set(SCENTS[this.scent].hex);
        g.toast(`${SCENTS[this.scent].name} shampoo`);
        break;
      case 'dryer':
        this.dryerHigh = !this.dryerHigh;
        g.toast(this.dryerHigh ? 'Dryer: high' : 'Dryer: low and gentle');
        break;
      case 'clippers':
        this.guard = (this.guard + 1) % GUARDS.length;
        this.kick.velocity += 3;
        g.audio.clink();
        break;
      case 'bow':
        this.bowColor = (this.bowColor + 1) % BOW_COLORS.length;
        this.models.bow.mat.color.set(BOW_COLORS[this.bowColor].hex);
        g.toast(`${BOW_COLORS[this.bowColor].name} ribbon`);
        if (g.dog?.bow) g.dog.bow.setColor(BOW_COLORS[this.bowColor].hex);
        break;
      default:
        return;
    }
    this.game.audio.click();
    this._optionLabel();
  }

  _optionLabel() {
    let label = '';
    const how = this.game.input.touchMode ? 'gear to change' : 'R to change';
    if (this.id === 'clippers') {
      const gd = GUARDS[this.guard];
      label = `Guard #${gd.n} · ${Math.round(gd.len * 100)} cm  (${how})`;
    } else if (this.id === 'bow') label = `${BOW_COLORS[this.bowColor].name} ribbon  (${how})`;
    else if (this.id === 'spray') label = `${this.sprayMode ? 'Gentle shower' : 'Jet stream'}  (${how})`;
    else if (this.id === 'dryer') label = `${this.dryerHigh ? 'High' : 'Low'} power  (${how})`;
    else if (this.id === 'shampoo') label = `${SCENTS[this.scent].name}  (${how})`;
    this.game.hud.setGuard(label);
    if (this.id === 'clippers') this.models.clippers.guard.scale.y = 0.6 + this.guard * 0.25;
  }

  // Dryer wind field: everything that can flutter asks this.
  windAt(p, out) {
    if (this.dryerOn <= 0) return out;
    _c.subVectors(p, this.nozzleWorld);
    const dist = _c.length();
    const range = 1.3;
    if (dist > range || dist < 1e-4) return out;
    const cos = _c.dot(this.nozzleDir) / dist;
    if (cos < 0.8) return out;
    const f = this.dryerOn * (1 - dist / range) * smoothstep(0.8, 0.97, cos);
    out.addScaledVector(this.nozzleDir, 70 * f);
    return out;
  }

  update(dt, ctx) {
    const g = this.game;
    const { input, dog, origin, dir } = ctx;
    const up = g.upgrades;
    this.hint = '';
    if (input.wheel) this.select(this.index + input.wheel);
    for (let i = 0; i < TOOL_DEFS.length; i++) if (input.hit('Digit' + (i + 1))) this.select(i);
    if (input.altPressed || input.hit('KeyR')) this.alt();

    const use = input.use && ctx.canUse;
    const usePressed = input.usePressed && ctx.canUse;
    this.using = use;

    // What are we pointing at?
    let hit = null;
    if (dog?.fur) hit = dog.raycast(origin, dir, 2.6);
    this.hit = hit;
    const reachable = hit && hit.t < 1.45;
    this.target.copy(origin).addScaledVector(dir, hit ? hit.t : 2.5);

    // ---------- Viewmodel physics ----------
    // Keep the held tool inside narrow (portrait) views.
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.rest.set(Math.min(0.22, tanV * this.camera.aspect * 0.45 * 0.62), -Math.min(0.2, tanV * 0.45 * 0.6), -0.45);
    const m = this.current;
    const reaching = m.reach && use && reachable;
    if (reaching) {
      // Reach out to the coat: the target is the hit point in camera space.
      _a.copy(hit.point).addScaledVector(dir, -0.03);
      this.camera.worldToLocal(_a);
      _a.y -= 0.02;
      this.pos.target.copy(_a);
    } else {
      this.pos.target.copy(this.rest);
      if (this.id === 'camera') this.pos.target.set(0, -0.08, -0.32);
    }
    const [lvx, lvy] = g.player.lookVel;
    this.rot.target.set(clamp(lvy * 0.00008, -0.15, 0.15), clamp(lvx * 0.00008, -0.2, 0.2), clamp(lvx * 0.00005, -0.1, 0.1));
    this.pos.update(dt);
    this.rot.update(dt);
    this.drop.update(dt);
    this.kick.update(dt);
    this.rig.position.copy(this.pos.value);
    this.rig.position.y += this.drop.value + g.player.bob.value * 0.01;
    this.rig.position.z += this.kick.value * 0.02;
    // Aim tools at the crosshair point so water and air go where you look.
    _b.copy(this.target);
    this.camera.worldToLocal(_b);
    _b.sub(this.rig.position).normalize();
    _q.setFromUnitVectors(FWD, _b);
    this.aimQuat.slerp(_q, 1 - Math.exp(-dt * 18));
    this.rig.quaternion.copy(this.aimQuat);
    _q.setFromEuler(new THREE.Euler(this.rot.value.x + this.kick.value * 0.2, this.rot.value.y, this.rot.value.z));
    this.rig.quaternion.multiply(_q);
    if (this.id === 'clippers' && use) {
      this.rig.position.x += (Math.random() - 0.5) * 0.003;
      this.rig.position.y += (Math.random() - 0.5) * 0.003;
    }
    this.rig.updateMatrixWorld(true);
    m.g.localToWorld(this.nozzleWorld.copy(m.tip));
    this.nozzleDir.subVectors(this.target, this.nozzleWorld).normalize();

    // ---------- Tool behaviour ----------
    let sprayLevel = 0, dryLevel = 0, clipLevel = 0, scrubLevel = 0;
    this.dryerOn = 0;
    const stroke = new THREE.Vector3();
    if (hit && this.prevHit && reachable) stroke.subVectors(hit.point, this.prevHit);
    const strokeSpeed = stroke.length() / Math.max(dt, 1e-3);
    if (stroke.lengthSq() > 0) stroke.normalize();

    switch (this.id) {
      case 'hands': {
        if (use) {
          if (g.bubbles.pokeRay(origin, dir, 1.5, (p, r) => g.popBubble(p, r))) break;
          if (reachable) {
            const res = dog.fur.scrub(hit.point.x, hit.point.y, hit.point.z, 0.12, stroke.x, stroke.y, stroke.z, 0.6 + Math.min(2.5, strokeSpeed * 2.5), dt, up.bubbly ? 1.6 : 1);
            scrubLevel = Math.min(1, 0.3 + strokeSpeed);
            for (const pi of res.bubbles) g.bubbles.stick(pi, dog.fur);
            if (res.needsWater > 2) this.hint = 'Soak the coat with the sprayer first';
            else if (res.dryPet > 0) {
              dog.please(dt * 0.12 * Math.min(1, res.dryPet / 20) * (up.treats ? 1.3 : 1));
              dog.squint = Math.max(dog.squint, 0.6);
              if (Math.random() < dt * 3) g.sparkles.emit('heart', hit.point.clone().add(_a.set(0, 0.05, 0)), { v: new THREE.Vector3(0, 0.25, 0) });
              this.hint = 'Good dog. Very good dog.';
            } else if (res.touched && res.lather <= 0 && dog.fur.stats && ctx.stage === 'bath') {
              this.hint = 'Add shampoo, then scrub it in';
            }
            if (res.lather > 0 || res.dirtMoved > 0) {
              this.hint = 'Scrub scrub scrub';
              dog.please(dt * 0.03);
            }
          }
        }
        break;
      }
      case 'spray': {
        if (use) {
          const shower = this.sprayMode === 1 || up.jet;
          const rate = (shower ? 420 : 260) * (up.jet ? 1.3 : 1);
          const spread = shower ? 0.085 : 0.03;
          const speed = shower ? 5.2 : 6.8;
          this.sprayAcc += rate * dt;
          while (this.sprayAcc > 1) {
            this.sprayAcc -= 1;
            ballistic(this.nozzleWorld, this.target, speed, _a);
            const sp = _a.length();
            _a.x += (Math.random() - 0.5) * spread * 2 * sp;
            _a.y += (Math.random() - 0.5) * spread * 2 * sp;
            _a.z += (Math.random() - 0.5) * spread * 2 * sp;
            _a.multiplyScalar(0.94 + Math.random() * 0.12);
            const j = Math.random() * 0.02;
            g.water.spawn(this.nozzleWorld.x + _a.x * j, this.nozzleWorld.y + _a.y * j, this.nozzleWorld.z + _a.z * j, _a.x, _a.y, _a.z, 0, 0.007 + Math.random() * 0.004);
          }
          g.water.amount = (up.jet ? 1.7 : 1) * (shower ? 0.8 : 1);
          sprayLevel = shower ? 0.6 : 0.8;
          this.kick.velocity += dt * 6;
          this.models.spray.trigger.position.z = -0.012;
          if (hit && (hit.region === REGION.face || hit.region === REGION.headtop) && hit.t < 2) {
            dog.squint = 1;
            if (!shower) {
              this.faceTimer += dt;
              if (this.faceTimer > 0.4) {
                this.faceTimer = 0;
                dog.upset(0.03);
                dog.flinchYaw = (Math.random() < 0.5 ? -1 : 1) * 0.6;
                this.hint = `Not in the face! Try the gentle shower (${g.optKey})`;
              }
            }
          }
        } else this.models.spray.trigger.position.z = -0.02;
        break;
      }
      case 'shampoo': {
        if (use) {
          this.gelAcc += dt * 7;
          if (usePressed) this.gelAcc = Math.max(this.gelAcc, 1);
          while (this.gelAcc >= 1) {
            this.gelAcc -= 1;
            ballistic(this.nozzleWorld, this.target, 4.2, _a);
            _a.x += (Math.random() - 0.5) * 0.2;
            _a.y += (Math.random() - 0.5) * 0.2;
            _a.z += (Math.random() - 0.5) * 0.2;
            g.gel.spawn(this.nozzleWorld, _a, 0.011 + Math.random() * 0.006);
            g.audio.splat();
            this.models.shampoo.body.scale.set(1.15, 0.85, 1.15);
          }
        }
        const b = this.models.shampoo.body.scale;
        b.lerp(_a.set(1, 1, 1), 1 - Math.exp(-dt * 12));
        break;
      }
      case 'dryer': {
        const fan = this.models.dryer.fan;
        if (use) {
          const power = (this.dryerHigh ? 1 : 0.55) * (up.turbo ? 1.7 : 1);
          this.dryerOn = power;
          dryLevel = power;
          fan.rotation.z += dt * 60;
          if (dog?.fur) {
            const res = dog.fur.blow(this.nozzleWorld.x, this.nozzleWorld.y, this.nozzleWorld.z, this.nozzleDir.x, this.nozzleDir.y, this.nozzleDir.z, power, 1.2, dt, up.cloud ? 1.4 : 1);
            dog.blowChains(this.nozzleWorld, this.nozzleDir, power, 1.2);
            for (const pi of res.fling) {
              const p3 = pi * 3;
              const f = dog.fur;
              g.water.spawn(f.pos[p3], f.pos[p3 + 1], f.pos[p3 + 2],
                this.nozzleDir.x * 2.2 + (Math.random() - 0.5), this.nozzleDir.y * 2.2 + Math.random() * 0.6, this.nozzleDir.z * 2.2 + (Math.random() - 0.5),
                0.05, 0.006, 2);
            }
            if (res.face > 0.3) {
              dog.squint = 1;
              if (this.dryerHigh) {
                this.faceTimer += dt;
                if (this.faceTimer > 0.8) {
                  this.faceTimer = 0;
                  dog.flinchYaw = (Math.random() < 0.5 ? -1 : 1) * 0.5;
                  dog.upset(0.005 * g.dogFear.dryer);
                  g.maybeSneeze(dog);
                  this.hint = `Easy on the face. Low power (${g.optKey}) is gentler`;
                }
              }
            }
          }
          // Visible air: little wisps.
          if (Math.random() < dt * 30) {
            _a.copy(this.nozzleDir).multiplyScalar(1.8).add(_b.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.3));
            g.sparkles.emit('mist', this.nozzleWorld.clone().addScaledVector(this.nozzleDir, 0.05), { v: _a.clone(), size: 0.02, life: 0.4, color: '#ffffff' });
          }
        } else fan.rotation.z += dt * 4;
        break;
      }
      case 'brush': {
        if (use && reachable) {
          const res = dog.fur.brush(hit.point.x, hit.point.y, hit.point.z, 0.08, stroke.x, stroke.y, stroke.z, Math.min(10, strokeSpeed * 6), dt, up.detangler ? 2 : 1);
          g.audio.brush(Math.min(1.5, strokeSpeed));
          if (res.tangle > 0) {
            this.hint = 'Tangle! Keep brushing';
            if (strokeSpeed > 0.2 && Math.random() < dt * 8) g.audio.snip();
          } else if (strokeSpeed > 0.2) {
            dog.please(dt * 0.02);
            this.hint = 'Brushing';
          } else this.hint = 'Stroke the brush through the coat';
          for (const mi of res.cleared) g.onMatCleared(mi);
        }
        break;
      }
      case 'clippers': {
        clipLevel = 0.25;
        if (use && reachable) {
          const guard = GUARDS[this.guard].len;
          const cuts = dog.fur.clip(hit.point.x, hit.point.y, hit.point.z, up.whisper ? 0.065 : 0.05, guard);
          if (cuts.length) {
            clipLevel = 0.9;
            g.buzz(12);
            this.snipAcc += cuts.length;
            for (const c of cuts) {
              this.tuftAcc += 0.5 + c.amount;
              if (this.tuftAcc >= 1) {
                this.tuftAcc -= 1;
                dog.fur.strandColor(c.s, false, col3);
                g.tufts.spawn(c.x, c.y, c.z, c.vx * 0.3 + (Math.random() - 0.5) * 0.4, c.vy * 0.3 + Math.random() * 0.3, c.vz * 0.3 + (Math.random() - 0.5) * 0.4, c.r, [...col3]);
              }
            }
          }
          const tgt = dog.fur.target, len = dog.fur.len, s = hit.s;
          if (s >= 0) {
            if (guard < tgt[s] - 0.008) this.hint = `Guard #${GUARDS[this.guard].n} is shorter than the ${g.cutName()} asks for here`;
            else if (len[s] > tgt[s] + 0.01) this.hint = 'Pink fur still needs a trim';
            else this.hint = 'This bit is done';
          }
        } else if (reachable && hit.s >= 0) {
          const f = dog.fur;
          if (f.len[hit.s] > f.target[hit.s] + 0.01) this.hint = 'Pink fur still needs a trim';
        }
        break;
      }
      case 'bow': {
        if (usePressed && reachable && dog) {
          if (hit.region === REGION.headtop || hit.region === REGION.ears || hit.region === REGION.face) {
            g.placeBow(hit.point, BOW_COLORS[this.bowColor].hex);
          } else this.hint = 'Bows go on the head';
        } else if (reachable) this.hint = hit.region === REGION.headtop || hit.region === REGION.ears ? 'Click to tie the bow here' : 'Aim at the head';
        break;
      }
      case 'camera': {
        if (usePressed) g.takePhoto();
        this.hint = ctx.stage === 'groom' ? 'Click to take the photo and finish' : 'Click to snap a photo';
        break;
      }
    }
    this.prevHit = hit && reachable ? hit.point.clone() : null;

    // Sound beds.
    const a = g.audio;
    if (a.ctx) {
      a.setLoop('spray', sprayLevel * 0.22, this.sprayMode);
      a.setLoop('dryer', dryLevel ? 0.16 + dryLevel * 0.06 : 0, dryLevel);
      a.setLoop('clip', this.id === 'clippers' && use ? clipLevel * 0.1 : 0, clipLevel);
      a.setLoop('scrub', scrubLevel * 0.1, scrubLevel);
    }
    return { hit };
  }
}

export { SCENTS };
