import * as THREE from 'three';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function tex(c, repeatX = 1, repeatY = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Glossy mint wall tiles with soft grout and a little hand-made colour drift.
export function tileTexture({ base = '#A8DCCB', grout = '#e9f3ef', tiles = 8, size = 512, jitter = 0.05 } = {}) {
  const [c, g] = canvas(size, size);
  g.fillStyle = grout;
  g.fillRect(0, 0, size, size);
  const s = size / tiles;
  const col = new THREE.Color(base);
  for (let y = 0; y < tiles; y++)
    for (let x = 0; x < tiles; x++) {
      const k = 1 + (Math.random() - 0.5) * jitter * 2;
      const cc = col.clone().multiplyScalar(k);
      g.fillStyle = `#${cc.getHexString()}`;
      const p = s * 0.045;
      roundRect(g, x * s + p, y * s + p, s - 2 * p, s - 2 * p, s * 0.06);
      g.fill();
      // Glaze highlight.
      const grd = g.createLinearGradient(x * s, y * s, x * s + s, y * s + s);
      grd.addColorStop(0, 'rgba(255,255,255,0.22)');
      grd.addColorStop(0.45, 'rgba(255,255,255,0)');
      grd.addColorStop(1, 'rgba(0,0,0,0.05)');
      g.fillStyle = grd;
      roundRect(g, x * s + p, y * s + p, s - 2 * p, s - 2 * p, s * 0.06);
      g.fill();
    }
  return tex(c);
}

// Glazed-tile roughness: grout lines are matte, tile faces are glossy.
export function tileRoughness({ tiles = 8, size = 256 } = {}) {
  const [c, g] = canvas(size, size);
  g.fillStyle = '#ddd';
  g.fillRect(0, 0, size, size);
  const s = size / tiles;
  g.fillStyle = '#3a3a3a';
  for (let y = 0; y < tiles; y++)
    for (let x = 0; x < tiles; x++) {
      const p = s * 0.05;
      g.fillRect(x * s + p, y * s + p, s - 2 * p, s - 2 * p);
    }
  return tex(c, 1, 1, false);
}

// Checkerboard floor in bubble white and mint.
export function floorTexture() {
  const size = 512, n = 4;
  const [c, g] = canvas(size, size);
  const s = size / n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      g.fillStyle = (x + y) % 2 ? '#cfeadf' : '#f4f8f6';
      g.fillRect(x * s, y * s, s, s);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(x * s + 4, y * s + 4, s - 8, s * 0.35);
    }
  g.strokeStyle = 'rgba(120,150,140,0.35)';
  g.lineWidth = 3;
  for (let i = 0; i <= n; i++) {
    g.beginPath();
    g.moveTo(i * s, 0);
    g.lineTo(i * s, size);
    g.moveTo(0, i * s);
    g.lineTo(size, i * s);
    g.stroke();
  }
  return tex(c);
}

export function woodTexture(base = '#e9c9a3') {
  const [c, g] = canvas(256, 256);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {
    g.strokeStyle = `rgba(140,90,50,${0.04 + Math.random() * 0.06})`;
    g.lineWidth = 1 + Math.random() * 2;
    g.beginPath();
    const y = Math.random() * 256;
    g.moveTo(0, y);
    for (let x = 0; x <= 256; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 3);
    g.stroke();
  }
  return tex(c);
}

export function brushedSteel() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#9AA4AB';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 400; i++) {
    const v = 140 + Math.random() * 60;
    g.strokeStyle = `rgba(${v},${v + 6},${v + 10},0.18)`;
    g.beginPath();
    const y = Math.random() * 256;
    g.moveTo(0, y);
    g.lineTo(256, y + (Math.random() - 0.5) * 2);
    g.stroke();
  }
  return tex(c, 2, 1);
}

// The rainy street across the road, painted once.
export function streetTexture() {
  const W = 1024, H = 512;
  const [c, g] = canvas(W, H);
  // Overcast sky.
  const sky = g.createLinearGradient(0, 0, 0, H * 0.45);
  sky.addColorStop(0, '#9fb3b8');
  sky.addColorStop(1, '#c7d3d2');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  // Facades across the street.
  const facades = ['#e8b7a4', '#f1d7a8', '#b9d4cf', '#d8c3e0', '#f0c9b8', '#c9dcb8'];
  let x = -20;
  let i = 0;
  while (x < W) {
    const w = 150 + Math.random() * 90;
    const top = 30 + Math.random() * 70;
    g.fillStyle = facades[i % facades.length];
    g.fillRect(x, top, w, H * 0.62 - top);
    // Cornice.
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(x, top, w, 8);
    // Windows, some warmly lit.
    for (let wy = top + 30; wy < H * 0.5; wy += 58) {
      for (let wx = x + 18; wx < x + w - 34; wx += 44) {
        const lit = Math.random() < 0.45;
        g.fillStyle = lit ? '#ffe2a6' : '#7d8f98';
        g.fillRect(wx, wy, 26, 36);
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.fillRect(wx + 12, wy, 2, 36);
      }
    }
    // Shopfront with awning.
    const awn = ['#e46f6f', '#5fae96', '#e8a04a', '#7a8fd6'][i % 4];
    const sy = H * 0.5;
    g.fillStyle = '#4b5a60';
    g.fillRect(x + 10, sy + 8, w - 20, H * 0.12);
    g.fillStyle = 'rgba(255,226,166,0.75)';
    g.fillRect(x + 16, sy + 14, w - 32, H * 0.1);
    for (let s = 0; s < w - 20; s += 18) {
      g.fillStyle = (s / 18) % 2 ? awn : '#fff7ee';
      g.beginPath();
      g.moveTo(x + 10 + s, sy - 18);
      g.lineTo(x + 28 + s, sy - 18);
      g.lineTo(x + 28 + s, sy + 4);
      g.arc(x + 19 + s, sy + 4, 9, 0, Math.PI);
      g.fill();
    }
    x += w + 6;
    i++;
  }
  // Pavement and road with wet reflections.
  g.fillStyle = '#8d9a9c';
  g.fillRect(0, H * 0.62, W, H * 0.08);
  const road = g.createLinearGradient(0, H * 0.7, 0, H);
  road.addColorStop(0, '#59646a');
  road.addColorStop(1, '#3f484d');
  g.fillStyle = road;
  g.fillRect(0, H * 0.7, W, H * 0.3);
  for (let k = 0; k < 60; k++) {
    g.fillStyle = `rgba(255,226,166,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * W, H * 0.72 + Math.random() * H * 0.26, 2 + Math.random() * 30, 2);
  }
  g.fillStyle = 'rgba(255,255,255,0.6)';
  for (let k = 0; k < W; k += 90) g.fillRect(k, H * 0.86, 50, 6);
  // Lamp posts.
  for (let k = 120; k < W; k += 330) {
    g.fillStyle = '#2f3a3f';
    g.fillRect(k, H * 0.3, 6, H * 0.4);
    g.fillStyle = '#ffe7b0';
    g.beginPath();
    g.arc(k + 3, H * 0.3, 12, 0, Math.PI * 2);
    g.fill();
    const glow = g.createRadialGradient(k + 3, H * 0.3, 2, k + 3, H * 0.3, 60);
    glow.addColorStop(0, 'rgba(255,231,176,0.45)');
    glow.addColorStop(1, 'rgba(255,231,176,0)');
    g.fillStyle = glow;
    g.fillRect(k - 60, H * 0.3 - 60, 126, 120);
  }
  // Rain haze.
  g.fillStyle = 'rgba(200,215,220,0.18)';
  g.fillRect(0, 0, W, H);
  const t = tex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// Window lettering, painted backwards because we read it from inside.
export function windowLettering() {
  const [c, g] = canvas(1024, 256);
  g.clearRect(0, 0, 1024, 256);
  g.save();
  g.translate(1024, 0);
  g.scale(-1, 1);
  g.font = '800 120px Sniglet, "Arial Rounded MT Bold", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 14;
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.strokeText('Suds & Snips', 512, 110);
  g.fillStyle = '#f2b38b';
  g.fillText('Suds & Snips', 512, 110);
  g.font = '600 38px Figtree, sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.fillText('DOG GROOMING · WALK-INS WELCOME', 512, 205);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function corkTexture() {
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#d9b48a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(150,100,60,0.25)' : 'rgba(255,240,220,0.25)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  return tex(c, 2, 1);
}

export function rugTexture() {
  const [c, g] = canvas(512, 256);
  const cols = ['#f2b38b', '#f7fafa', '#a8dccb', '#f6d68a', '#c9b6e4', '#f7fafa'];
  const w = 512 / cols.length;
  cols.forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(i * w, 0, w, 256);
  });
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.15})`;
    g.fillRect(Math.random() * 512, Math.random() * 256, 1, 3);
  }
  return tex(c);
}

// A cheerful poster for the wall: "Every dog is a good dog".
export function posterTexture() {
  const [c, g] = canvas(256, 340);
  g.fillStyle = '#fff7ee';
  g.fillRect(0, 0, 256, 340);
  g.fillStyle = '#a8dccb';
  g.beginPath();
  g.arc(128, 140, 92, 0, Math.PI * 2);
  g.fill();
  // A round dog face.
  g.fillStyle = '#f2b38b';
  g.beginPath();
  g.ellipse(128, 150, 62, 56, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#d98f63';
  g.beginPath();
  g.ellipse(72, 128, 20, 40, 0.4, 0, Math.PI * 2);
  g.ellipse(184, 128, 20, 40, -0.4, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2b2b2b';
  g.beginPath();
  g.arc(106, 140, 7, 0, Math.PI * 2);
  g.arc(150, 140, 7, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(128, 166, 12, 9, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ef7f8f';
  g.beginPath();
  g.ellipse(128, 190, 9, 12, 0, 0, Math.PI);
  g.fill();
  g.fillStyle = '#22413b';
  g.font = '400 30px Sniglet, sans-serif';
  g.textAlign = 'center';
  g.fillText('every dog is', 128, 278);
  g.fillText('a good dog', 128, 312);
  return tex(c);
}

export function priceBoardTexture() {
  const [c, g] = canvas(320, 400);
  g.fillStyle = '#2f4a44';
  g.fillRect(0, 0, 320, 400);
  g.strokeStyle = '#e9c9a3';
  g.lineWidth = 14;
  g.strokeRect(7, 7, 306, 386);
  g.fillStyle = '#f7fafa';
  g.font = '400 34px Sniglet, sans-serif';
  g.textAlign = 'center';
  g.fillText('Menu', 160, 60);
  g.font = '28px Caveat, cursive';
  const rows = [
    ['Bath & fluff', '$30'],
    ['Puppy cut', '$40'],
    ['Teddy bear', '$45'],
    ['Lion cut', '$55'],
    ['De-matting', '+$5'],
    ['Bow', 'free!'],
  ];
  rows.forEach(([a, b], i) => {
    g.textAlign = 'left';
    g.fillText(a, 32, 118 + i * 44);
    g.textAlign = 'right';
    g.fillText(b, 290, 118 + i * 44);
  });
  return tex(c);
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export { roundRect };
