import * as THREE from 'three';
import { Pendulum, Spring3 } from '../core/springs.js';

const W = 240, H = 290;

// Render a framed shot of the dog into a polaroid canvas (photo + handwritten caption).
// We render to the main canvas and copy it straight away, so the shot gets the same tone mapping
// as the game view (render targets skip it).
export function capturePolaroid(renderer, scene, camera, caption, sub, subject) {
  const cam = camera.clone();
  if (subject) {
    // Frame the dog: look at its middle and widen or tighten the lens to fit it.
    cam.lookAt(subject.center);
    const dist = cam.position.distanceTo(subject.center);
    cam.fov = THREE.MathUtils.clamp((2 * Math.atan(subject.radius / dist) * 180) / Math.PI, 22, 75);
  }
  const src = renderer.domElement;
  cam.aspect = src.width / src.height;
  cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  const s = Math.min(src.width, src.height);

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fffdf8';
  g.fillRect(0, 0, W, H);
  const pad = 14, ph = W - pad * 2;
  g.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, pad, pad, ph, ph);
  // A warm instant-film tint and vignette.
  g.fillStyle = 'rgba(255,214,170,0.10)';
  g.fillRect(pad, pad, ph, ph);
  const vg = g.createRadialGradient(W / 2, pad + ph / 2, ph * 0.3, W / 2, pad + ph / 2, ph * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(60,30,10,0.22)');
  g.fillStyle = vg;
  g.fillRect(pad, pad, ph, ph);
  g.fillStyle = '#3b5c8a';
  g.font = '700 30px Caveat, "Segoe Print", cursive';
  g.textAlign = 'center';
  g.fillText(caption, W / 2, pad + ph + 30);
  g.font = '500 20px Caveat, "Segoe Print", cursive';
  g.fillStyle = '#557069';
  g.fillText(sub, W / 2, pad + ph + 50);
  return c;
}

export function drawStoredPhoto(canvas, dataURL) {
  const g = canvas.getContext('2d');
  const img = new Image();
  img.onload = () => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = dataURL;
}

// Polaroids pinned to the cork board, each swinging on its pin.
export class PhotoWall {
  constructor(salon) {
    this.salon = salon;
    this.items = [];
    this.flying = [];
    this.geo = new THREE.PlaneGeometry(0.2, 0.2 * (H / W));
    this.pinGeo = new THREE.SphereGeometry(0.009, 10, 8);
    this.pinMat = new THREE.MeshStandardMaterial({ color: '#e98f8f', roughness: 0.3 });
  }

  _makeMesh(canvasOrUrl) {
    const tex = canvasOrUrl instanceof HTMLCanvasElement ? new THREE.CanvasTexture(canvasOrUrl) : new THREE.TextureLoader().load(canvasOrUrl);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(this.geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide }));
    mesh.castShadow = true;
    const pivot = new THREE.Group();
    mesh.position.y = -0.2 * (H / W) * 0.5 + 0.012;
    pivot.add(mesh);
    const pin = new THREE.Mesh(this.pinGeo, this.pinMat);
    pin.position.z = 0.006;
    return { pivot, mesh, pin, tex };
  }

  // Rebuild from saved photos (newest last).
  load(photos) {
    for (const it of this.items) {
      it.pivot.removeFromParent();
      it.pin.removeFromParent();
    }
    this.items = [];
    const slots = this.salon.photoSlots;
    const list = photos.slice(-slots.length);
    list.forEach((p, i) => this._pin(this._makeMesh(p.img), i));
  }

  _pin(m, slotIndex) {
    const slot = this.salon.photoSlots[slotIndex % this.salon.photoSlots.length];
    const s = this.salon.photoScale;
    m.pivot.position.copy(slot);
    m.pivot.scale.setScalar(s);
    m.pin.position.copy(slot).add(new THREE.Vector3(0, 0, 0.01));
    this.salon.group.add(m.pivot);
    this.salon.group.add(m.pin);
    const pend = new Pendulum(0.12, 1.4);
    pend.push((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 3);
    m.pend = pend;
    m.baseTilt = (Math.random() - 0.5) * 0.12;
    this.items.push(m);
  }

  // A fresh print flies from the camera to the next free slot, then swings on its pin.
  addFresh(canvas, from, total) {
    const m = this._makeMesh(canvas);
    const slots = this.salon.photoSlots;
    if (this.items.length >= slots.length) {
      const old = this.items.shift();
      old.pivot.removeFromParent();
      old.pin.removeFromParent();
      this.items.forEach((it, i) => {
        it.pivot.position.copy(slots[i]);
        it.pin.position.copy(slots[i]).add(new THREE.Vector3(0, 0, 0.01));
      });
    }
    const slotIndex = this.items.length;
    m.pivot.position.copy(from);
    this.salon.group.add(m.pivot);
    const fly = { m, slotIndex, spring: new Spring3(18, 6.5), t: 0, spin: 0 };
    fly.spring.snap(from);
    fly.spring.velocity.set((Math.random() - 0.5) * 0.6, 1.6, -0.6);
    fly.spring.target.copy(slots[slotIndex]);
    this.flying.push(fly);
  }

  update(dt, wind) {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const f = this.flying[i];
      f.t += dt;
      // Starts loose (like a print tossed in the air), then homes in on its slot.
      f.spring.k = 4 + Math.min(1, f.t) * 30;
      f.spring.velocity.y -= 9.81 * dt * Math.max(0, 0.6 - f.t);
      f.spring.update(dt);
      f.m.pivot.position.copy(f.spring.value);
      f.m.pivot.rotation.set(Math.sin(f.t * 7) * 0.4 * Math.max(0, 1 - f.t), f.t * 3 * Math.max(0, 1 - f.t), Math.sin(f.t * 5) * 0.3);
      if (f.t > 1.6 && f.spring.value.distanceTo(f.spring.target) < 0.02) {
        this.flying.splice(i, 1);
        f.m.pivot.removeFromParent();
        this._pin(f.m, f.slotIndex);
        f.m.pend.push(0, 6);
      }
    }
    for (const it of this.items) {
      if (wind) {
        const w = wind(it.pivot.position, new THREE.Vector3());
        it.pend.push(w.z * dt * 0.3 + w.y * dt * 0.1, -w.x * dt * 0.3);
      }
      it.pend.update(dt);
      it.pivot.rotation.set(Math.max(-0.05, it.pend.ax), 0, it.pend.az + it.baseTilt);
    }
  }
}

export function canvasToDataURL(canvas) {
  // Small JPEG thumbnail keeps the save tiny.
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = Math.round(160 * (H / W));
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}
