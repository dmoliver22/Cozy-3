// Per-browser save. Storage can be unavailable (private windows, sandboxed frames),
// so every access is guarded and the game runs fine without it.
const KEY = 'suds-and-snips-v1';

export function defaultSave() {
  return { money: 0, day: 1, served: 0, appt: 0, upgrades: {}, photos: [], music: true, best: 0, seen: [] };
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return { ...defaultSave(), ...JSON.parse(raw) };
  } catch {
    return null;
  }
}

export function writeSave(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    // Photos are the bulk of the save; drop the oldest and try once more.
    try {
      const slim = { ...data, photos: data.photos.slice(-4) };
      localStorage.setItem(KEY, JSON.stringify(slim));
    } catch {
      /* storage unavailable */
    }
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
