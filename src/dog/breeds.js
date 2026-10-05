import * as THREE from 'three';
import { fbm3 } from '../core/math.js';
import { REGION } from './fur.js';

const col = (hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const vary = (c, rng, amt = 0.06) => {
  const k = 1 + (rng() - 0.5) * amt * 2;
  return [c[0] * k, c[1] * k, c[2] * k];
};

// Clipper guard combs, in metres of coat left behind.
export const GUARDS = [
  { n: 1, len: 0.02 },
  { n: 2, len: 0.035 },
  { n: 3, len: 0.06 },
  { n: 4, len: 0.09 },
  { n: 5, len: 0.13 },
];

const R = REGION;
function lengths(map) {
  const arr = new Array(12).fill(null);
  for (const [k, v] of Object.entries(map)) arr[R[k]] = v;
  return arr;
}

export const CUTS = {
  tidy: {
    name: 'Bath & Fluff',
    detail: 'No clipping. Clean, dry, de-matted, big fluff.',
    lengths: lengths({}),
    price: 30,
  },
  puppy: {
    name: 'Puppy Cut',
    detail: 'Body, legs and head #3, all one even length',
    lengths: lengths({ back: 0.06, belly: 0.06, chest: 0.06, rear: 0.06, neck: 0.06, legs: 0.06, paws: 0.06, headtop: 0.06, face: 0.06 }),
    price: 40,
  },
  teddy: {
    name: 'Teddy Bear',
    detail: 'Body #3 · legs #4 · keep the face round',
    lengths: lengths({ back: 0.06, belly: 0.06, chest: 0.06, rear: 0.06, neck: 0.06, legs: 0.09, paws: 0.09, tail: 0.09 }),
    price: 45,
  },
  lion: {
    name: 'Lion Cut',
    detail: 'Body & upper legs #1 · keep mane, cuffs and tail pom',
    lengths: lengths({ back: 0.02, belly: 0.02, rear: 0.02, legs: 0.02, tail: 0.02 }),
    price: 55,
  },
  summer: {
    name: 'Summer Shave',
    detail: 'Body #2 · head & ears #3',
    lengths: lengths({ back: 0.035, belly: 0.035, chest: 0.035, rear: 0.035, neck: 0.035, legs: 0.035, paws: 0.035, tail: 0.035, tailtip: 0.035, headtop: 0.06, face: 0.06, ears: 0.06 }),
    price: 50,
  },
  pants: {
    name: 'Tidy Trousers',
    detail: 'Fluffy pants #2 · legs & paws #2',
    lengths: lengths({ rear: 0.035, legs: 0.035, paws: 0.035 }),
    price: 35,
  },
  feathers: {
    name: 'Feather Trim',
    detail: 'Leg feathers #3 · paws #2 · tail #4',
    lengths: lengths({ legs: 0.06, paws: 0.035, tail: 0.09, tailtip: 0.09, belly: 0.06 }),
    price: 40,
  },
};

export const BOW_COLORS = [
  { name: 'Mint', hex: '#7fd1b4' },
  { name: 'Peach', hex: '#f2a27a' },
  { name: 'Lilac', hex: '#b9a2e6' },
  { name: 'Lemon', hex: '#f4d35e' },
  { name: 'Rose', hex: '#f08aa8' },
];

// Geometry is in metres, dog-local frame: +Z forward, +Y up.
export const BREEDS = {
  sheepdog: {
    name: 'Old English Sheepdog',
    mass: 26,
    torso: [0.155, 0.165, 0.29],
    stand: 0.43,
    hipF: [0.082, -0.085, 0.17],
    hipB: [0.082, -0.075, -0.19],
    legR: 0.045,
    neck: [0, 0.07, 0.22],
    neckR: 0.07,
    head: { r: [0.1, 0.1, 0.108], at: [0, 0.16, 0.34] },
    snout: { r: [0.056, 0.05, 0.062], at: [0, -0.035, 0.1] },
    eyes: { at: [0.045, 0.022, 0.09], r: 0.019 },
    ears: { kind: 'floppy', at: [0.083, 0.045, -0.01], seg: 0.045, w: 0.05 },
    tail: { at: [0, 0.06, -0.27], segs: 2, seg: 0.04, dirs: [[0, 0.5, -1], [0, 0.3, -1]], stiff: 0.25, r: 0.035 },
    fur: {
      len: 0.15, count: 1150, puff: 0.03, curl: 0.12, stiff: 0.13, stand: 0.36,
      regions: { face: 0.4, headtop: 0.7, ears: 0.9, paws: 0.75, tail: 0.6, tailtip: 0.6 },
      fringe: true,
    },
    dirt: 0.95,
    mats: 6,
    bark: 0.95,
    cuts: ['teddy', 'teddy', 'puppy', 'summer', 'tidy'],
    coat(part, P, region, rng) {
      const white = col('#f2efe7'), grey = col('#8b949b');
      if (part === 'torso') {
        const t = THREE.MathUtils.smoothstep(-P[2], -0.02, 0.1);
        return vary(mix(white, grey, P[1] > -0.09 ? t : t * 0.3), rng);
      }
      if (part === 'ear') return vary(mix(white, grey, 0.55), rng);
      if (part.startsWith('legB')) return vary(mix(white, grey, 0.15), rng);
      return vary(white, rng, 0.04);
    },
    skin: '#d9d2c8',
  },
  poodle: {
    name: 'Standard Poodle',
    mass: 20,
    torso: [0.12, 0.13, 0.22],
    stand: 0.47,
    hipF: [0.07, -0.08, 0.13],
    hipB: [0.07, -0.07, -0.15],
    legR: 0.034,
    neck: [0, 0.08, 0.16],
    neckR: 0.05,
    head: { r: [0.08, 0.085, 0.09], at: [0, 0.22, 0.27] },
    snout: { r: [0.04, 0.038, 0.075], at: [0, -0.03, 0.1] },
    eyes: { at: [0.036, 0.018, 0.072], r: 0.0169 },
    ears: { kind: 'floppy', at: [0.07, 0.03, -0.01], seg: 0.055, w: 0.045 },
    tail: { at: [0, 0.07, -0.2], segs: 3, seg: 0.045, dirs: [[0, 1, -0.5], [0, 1, -0.2], [0, 1, 0]], stiff: 0.3, r: 0.022 },
    fur: {
      len: 0.085, count: 1000, puff: 0.025, curl: 0.62, stiff: 0.26, stand: 0.62,
      regions: { face: 0.35, headtop: 1.25, ears: 1.2, tailtip: 1.4, paws: 0.9 },
    },
    dirt: 0.75,
    mats: 5,
    bark: 0.7,
    cuts: ['lion', 'teddy', 'puppy', 'lion'],
    colorways: ['#f0c393', '#f6f1e8', '#c9ccd0'],
    coat(part, P, region, rng, colorway) {
      return vary(col(colorway), rng, 0.05);
    },
    skin: '#e3cdb4',
  },
  corgi: {
    name: 'Pembroke Corgi',
    mass: 12,
    torso: [0.125, 0.125, 0.25],
    stand: 0.25,
    hipF: [0.075, -0.07, 0.16],
    hipB: [0.075, -0.06, -0.18],
    legR: 0.038,
    neck: [0, 0.06, 0.2],
    neckR: 0.06,
    head: { r: [0.095, 0.09, 0.095], at: [0, 0.14, 0.31] },
    snout: { r: [0.045, 0.04, 0.07], at: [0, -0.03, 0.095] },
    eyes: { at: [0.042, 0.018, 0.078], r: 0.0182 },
    ears: { kind: 'upright', at: [0.058, 0.07, -0.01], seg: 0.045, w: 0.055 },
    tail: { at: [0, 0.05, -0.24], segs: 2, seg: 0.04, dirs: [[0, 0.2, -1], [0, 0, -1]], stiff: 0.3, r: 0.03 },
    fur: {
      len: 0.045, count: 850, puff: 0.022, curl: 0.05, stiff: 0.32, stand: 0.3,
      regions: { rear: 1.8, chest: 1.5, neck: 1.4, face: 0.5, ears: 0.6, tail: 1.6, tailtip: 1.6, legs: 1.2 },
    },
    dirt: 0.85,
    mats: 2,
    bark: 0.45,
    cuts: ['tidy', 'pants', 'pants'],
    coat(part, P, region, rng) {
      const red = col('#d9873f'), white = col('#f7f1e6');
      if (region === R.belly || region === R.chest || region === R.paws || region === R.face) return vary(white, rng, 0.04);
      if (part === 'torso' && P[1] < -0.04) return vary(white, rng, 0.04);
      if (part === 'head' && P[0] * P[0] < 0.0004 && P[1] > -0.02) return vary(white, rng, 0.04);
      if (part === 'neck') return vary(mix(red, white, 0.6), rng);
      return vary(red, rng);
    },
    skin: '#e7c3a0',
  },
  pomeranian: {
    name: 'Pomeranian',
    mass: 4,
    torso: [0.085, 0.09, 0.11],
    stand: 0.17,
    hipF: [0.05, -0.05, 0.07],
    hipB: [0.05, -0.045, -0.075],
    legR: 0.022,
    neck: [0, 0.05, 0.08],
    neckR: 0.045,
    head: { r: [0.068, 0.068, 0.068], at: [0, 0.11, 0.13] },
    snout: { r: [0.026, 0.024, 0.035], at: [0, -0.022, 0.065] },
    eyes: { at: [0.03, 0.012, 0.058], r: 0.0156 },
    ears: { kind: 'upright', at: [0.04, 0.055, -0.01], seg: 0.025, w: 0.03 },
    tail: { at: [0, 0.06, -0.1], segs: 3, seg: 0.04, dirs: [[0, 1, -0.3], [0, 0.8, 0.5], [0, 0.2, 1]], stiff: 0.32, r: 0.02 },
    fur: {
      len: 0.08, count: 950, puff: 0.02, curl: 0.18, stiff: 0.34, stand: 0.8,
      regions: { neck: 1.4, chest: 1.3, face: 0.35, ears: 0.5, paws: 0.5, legs: 0.7, tail: 1.2, tailtip: 1.2 },
    },
    dirt: 0.7,
    mats: 3,
    bark: 0.1,
    cuts: ['teddy', 'lion', 'tidy', 'teddy'],
    coat(part, P, region, rng) {
      const orange = col('#eba55c'), cream = col('#f7dcb4');
      if (region === R.chest || region === R.belly || region === R.face) return vary(mix(orange, cream, 0.7), rng);
      return vary(orange, rng, 0.07);
    },
    skin: '#f0d4b0',
  },
  golden: {
    name: 'Golden Retriever',
    mass: 28,
    torso: [0.14, 0.15, 0.3],
    stand: 0.46,
    hipF: [0.075, -0.085, 0.18],
    hipB: [0.075, -0.075, -0.2],
    legR: 0.042,
    neck: [0, 0.07, 0.23],
    neckR: 0.065,
    head: { r: [0.095, 0.095, 0.105], at: [0, 0.18, 0.35] },
    snout: { r: [0.05, 0.045, 0.08], at: [0, -0.035, 0.11] },
    eyes: { at: [0.043, 0.022, 0.085], r: 0.0195 },
    ears: { kind: 'floppy', at: [0.083, 0.04, -0.01], seg: 0.05, w: 0.055 },
    tail: { at: [0, 0.07, -0.28], segs: 4, seg: 0.07, dirs: [[0, 0.2, -1], [0, -0.1, -1], [0, -0.3, -1], [0, -0.35, -1]], stiff: 0.2, r: 0.025 },
    fur: {
      len: 0.07, count: 1050, puff: 0.025, curl: 0.12, stiff: 0.2, stand: 0.24,
      regions: { tail: 1.8, tailtip: 1.8, chest: 1.6, belly: 1.5, legs: 1.3, ears: 1.2, face: 0.35, headtop: 0.5, paws: 0.7 },
    },
    dirt: 0.9,
    mats: 4,
    bark: 0.85,
    cuts: ['tidy', 'feathers', 'feathers'],
    coat(part, P, region, rng) {
      const gold = col('#d9a056'), light = col('#efcf96');
      if ([R.chest, R.belly, R.tail, R.tailtip, R.legs].includes(region)) return vary(mix(gold, light, 0.55), rng);
      return vary(gold, rng);
    },
    skin: '#e2b98a',
  },
  bichon: {
    name: 'Bichon Frise',
    mass: 6,
    torso: [0.1, 0.105, 0.15],
    stand: 0.24,
    hipF: [0.058, -0.06, 0.09],
    hipB: [0.058, -0.055, -0.1],
    legR: 0.026,
    neck: [0, 0.06, 0.11],
    neckR: 0.045,
    head: { r: [0.072, 0.072, 0.075], at: [0, 0.13, 0.18] },
    snout: { r: [0.032, 0.029, 0.04], at: [0, -0.026, 0.072] },
    eyes: { at: [0.032, 0.016, 0.064], r: 0.0169 },
    ears: { kind: 'floppy', at: [0.06, 0.03, -0.01], seg: 0.035, w: 0.035 },
    tail: { at: [0, 0.07, -0.13], segs: 3, seg: 0.04, dirs: [[0, 1, -0.4], [0, 0.9, 0.3], [0, 0.3, 1]], stiff: 0.3, r: 0.02 },
    fur: {
      len: 0.07, count: 950, puff: 0.022, curl: 0.7, stiff: 0.3, stand: 0.72,
      regions: { headtop: 1.3, face: 0.6, ears: 1.2, paws: 0.8 },
    },
    dirt: 0.8,
    mats: 4,
    bark: 0.2,
    cuts: ['teddy', 'puppy', 'tidy'],
    coat(part, P, region, rng) {
      return vary(col('#fbf8f2'), rng, 0.025);
    },
    skin: '#f1e3da',
  },
};

export const DOG_NAMES = {
  sheepdog: ['Biscuit', 'Barnaby', 'Mopsy', 'Dumpling', 'Pudding', 'Wooly'],
  poodle: ['Coco', 'Fifi', 'Apricot', 'Bijou', 'Pierre', 'Noodle'],
  corgi: ['Waffles', 'Toast', 'Pickles', 'Nugget', 'Bean', 'Loaf'],
  pomeranian: ['Mochi', 'Pom Pom', 'Tofu', 'Tangerine', 'Puffin', 'Kiki'],
  golden: ['Sunny', 'Honey', 'Maple', 'Butter', 'Rufus', 'Goldie'],
  bichon: ['Puff', 'Marshmallow', 'Cloud', 'Snowy', 'Cotton', 'Meringue'],
};

export const OWNERS = [
  { name: 'Mrs. Pemberton', coat: '#e98f8f', hat: '#f6d68a', skin: '#f1c7a8' },
  { name: 'Theo', coat: '#7fb6d9', hat: '#f2b38b', skin: '#c99872' },
  { name: 'Auntie Rosa', coat: '#c9a3e0', hat: '#a8dccb', skin: '#e0b08c' },
  { name: 'Mr. Okafor', coat: '#f2c55c', hat: '#5f7f9a', skin: '#8a5a3c' },
  { name: 'Juniper', coat: '#9ed1a8', hat: '#e98f8f', skin: '#f3d2bb' },
  { name: 'Dr. Lindqvist', coat: '#f2b38b', hat: '#7a8fd6', skin: '#f6dcc7' },
  { name: 'Kenji', coat: '#a3b8e0', hat: '#f6d68a', skin: '#e6c09a' },
  { name: 'Priya', coat: '#f08aa8', hat: '#a8dccb', skin: '#b9845e' },
];

export const TEMPERAMENTS = ['Wiggly', 'Dramatic', 'A total angel', 'Nervous of dryers', 'Licks everything', 'Very proud', 'Sleepy', 'Zoomies'];

export const NOTES = {
  sheepdog: [
    'Found the duck pond again. Can you make him a cloud?',
    'He has not seen his own eyes since June.',
    'Rolled in something. We do not ask what.',
  ],
  poodle: ['Competition next week, no pressure!', 'She knows she is fancy. Please confirm.', 'Puddle jumper. Every puddle.'],
  corgi: ['Low rider, high mud line.', 'The fluffy trousers are out of control.', 'He herded the ducks into the river.'],
  pomeranian: ['Smaller than the mud she is wearing.', 'Please make her round again.', 'Sneezes at blow dryers. Be gentle!'],
  golden: ['Swam the whole lake. Twice.', 'Tail is a weapon, mind the shelves.', 'Brings everyone a sock. Sorry in advance.'],
  bichon: ['Was white this morning. Promise.', 'Garden. Rain. Joy. Mud.', 'She wants to be a marshmallow.'],
};

// The coat pattern noise a few breeds use for subtle mottling.
export function mottled(P, scale = 10) {
  return fbm3(P[0] * scale, P[1] * scale, P[2] * scale);
}
