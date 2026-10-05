// Chunky pastel tool icons for the hotbar (inline SVG, 48×48).
const S = 'stroke="#22413b" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';

export const ICONS = {
  hands: `<svg viewBox="0 0 48 48"><path ${S} fill="#f6c7a7" d="M14 30c-3-4-4-9-1-11 2-1 4 1 5 3V12c0-2 1.5-3 3-3s3 1 3 3v-1c0-2 1.5-3 3-3s3 1 3 3v2c0-2 1.5-3 3-3s3 1 3 3v15c0 7-5 12-12 12-5 0-8-2-10-6z"/><path ${S} fill="#a8dccb" d="M17 37h16v5H17z"/></svg>`,
  spray: `<svg viewBox="0 0 48 48"><path ${S} fill="#a8dccb" d="M10 22h14l3 18h-9z"/><path ${S} fill="#c9d1d6" d="M10 16h18v8H10z"/><path ${S} fill="#f7fafa" d="M28 13h6v14h-6z"/><path ${S} fill="none" d="M38 14l4-2M39 20h5M38 26l4 2"/></svg>`,
  shampoo: `<svg viewBox="0 0 48 48"><path ${S} fill="#f6a8c8" d="M15 19c0-3 2-5 5-5h8c3 0 5 2 5 5v20c0 2-1 3-3 3H18c-2 0-3-1-3-3z"/><path ${S} fill="#f7fafa" d="M20 8h8v6h-8z"/><path ${S} fill="#fffdf8" d="M19 25h10v9H19z"/><circle ${S} fill="#f7fafa" cx="38" cy="10" r="3.5"/><circle ${S} fill="#f7fafa" cx="10" cy="14" r="2.5"/></svg>`,
  dryer: `<svg viewBox="0 0 48 48"><path ${S} fill="#c9b6ff" d="M8 16c0-5 4-8 9-8h6c5 0 8 3 8 8s-3 8-8 8h-6c-5 0-9-3-9-8z"/><path ${S} fill="#c9b6ff" d="M28 12h8v8h-8z"/><path ${S} fill="#f7fafa" d="M14 23h7l-2 17h-6z"/><path ${S} fill="none" d="M39 11h5M40 16h6M39 21h5"/></svg>`,
  brush: `<svg viewBox="0 0 48 48"><path ${S} fill="#F2B38B" d="M21 26l-9 15c-1 2 1 4 3 3l11-13z"/><path ${S} fill="#f7fafa" d="M18 10h22v14H18z" transform="rotate(-25 29 17)"/><path ${S} fill="none" d="M21 27l-3 4M26 25l-2 4M31 23l-2 4M36 20l-2 4"/></svg>`,
  clippers: `<svg viewBox="0 0 48 48"><rect ${S} fill="#a8dccb" x="15" y="12" width="16" height="30" rx="8"/><path ${S} fill="#F2B38B" d="M15 30h16v5H15z"/><path ${S} fill="#c9d1d6" d="M14 6h18v7H14z"/><path ${S} fill="none" d="M17 6v-2M21 6v-2M25 6v-2M29 6v-2"/></svg>`,
  bow: `<svg viewBox="0 0 48 48"><path ${S} fill="#7fd1b4" d="M24 23c-5-7-15-11-17-6-2 6 8 11 17 6zM24 23c5-7 15-11 17-6 2 6-8 11-17 6z"/><path ${S} fill="#7fd1b4" d="M22 25l-6 15 5-2 3 4zM26 25l6 15-5-2-3 4z"/><circle ${S} fill="#a8f0d6" cx="24" cy="23" r="4"/></svg>`,
  camera: `<svg viewBox="0 0 48 48"><rect ${S} fill="#f7fafa" x="7" y="14" width="34" height="26" rx="5"/><path ${S} fill="#F2B38B" d="M7 19c0-3 2-5 5-5h24c3 0 5 2 5 5v2H7z"/><circle ${S} fill="#2f4a44" cx="24" cy="29" r="7"/><circle fill="#7fb6d9" cx="24" cy="29" r="3.5"/><rect fill="#fff7d6" ${S} x="31" y="9" width="7" height="5" rx="1.5"/></svg>`,
};

export function starSVG(filled) {
  return `<svg class="star" viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.2 1.3-6.6L2.5 9.3l6.6-.8z" fill="${filled ? '#f2c55c' : '#e3ece9'}" stroke="#22413b" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
}
