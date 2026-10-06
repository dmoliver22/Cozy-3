// Device detection and the matching quality tier. Phones get fewer fur strands and hairs, smaller
// shadow maps and lighter rain so the simulation keeps its frame rate.
const mm = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;

export const TOUCH_FIRST = mm('(pointer: coarse)') || (navigator.maxTouchPoints > 0 && !mm('(pointer: fine)'));
const shortSide = Math.min(screen.width || 9999, screen.height || 9999);
export const IS_PHONE = TOUCH_FIRST && shortSide < 820;

// fur: share of simulated guide strands; hairs: locks drawn around each guide; shells: layers of
// short fur on the skin; segs: most particles per guide strand.
export const QUALITY = IS_PHONE
  ? { fur: 0.72, hairs: 16, shells: 8, segs: 4, shadow: 1024, rain: 320, maxDpr: 1.5, startDpr: 1.25 }
  : TOUCH_FIRST
    ? { fur: 0.85, hairs: 22, shells: 10, segs: 5, shadow: 2048, rain: 500, maxDpr: 1.5, startDpr: 1.5 }
    : { fur: 1, hairs: 28, shells: 14, segs: 6, shadow: 2048, rain: 700, maxDpr: 1.6, startDpr: 1.6 };
