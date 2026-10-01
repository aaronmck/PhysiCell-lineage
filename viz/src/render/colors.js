/**
 * Colour vocabulary for the viewer: one fixed categorical order for identity
 * (cell type, cycle phase) and perceptually-ordered ramps for magnitude.
 */

/**
 * Categorical slots in fixed order. Validated as a set on the white surface
 * (lightness band, chroma floor, adjacent CVD separation; contrast vs #fff is
 * ≥ 3:1 for every slot except the yellow at 2.99:1, which leans on the relief
 * below). Slots are assigned by cell-type index and never recycled when the
 * visible set changes, so a type keeps its colour as you filter.
 *
 * Colour alone never carries identity here: the legend is always on screen, the
 * hover readout names the type, and clicking a legend entry isolates it.
 */
export const CATEGORICAL = [
  '#3987e5', // blue
  '#d95926', // orange
  '#199e70', // aqua
  '#c98500', // yellow
  '#d55181', // magenta
  '#008300', // green
  '#9085e9', // violet
  '#e66767', // red
];

/**
 * Past eight, more hues are needed than the validated set provides — real runs
 * can define a dozen cell types and folding them into "Other" would throw away
 * the science. These extra slots stay a fixed, documented list (never generated
 * per-run) and lean on the legend plus isolate-on-click for identity.
 */
export const CATEGORICAL_EXTENDED = [
  ...CATEGORICAL,
  '#00a3a3', // teal
  '#b06fd0', // purple
  '#8a9a2b', // olive
  '#e08a3c', // amber
  '#5b8ff9', // periwinkle
  '#c25b9e', // plum
  '#3fa66b', // moss
  '#cf7b6b', // clay
];

export const UI = {
  surface: '#ffffff',
  surfaceRaised: '#f4f4f2',
  surfaceSunken: '#ffffff',
  border: '#d8d8d4',
  outline: '#a9a9a4', // domain box and other stage furniture: visible on white, still recessive
  textPrimary: '#1b1b18',
  textSecondary: '#4b4b46',
  textMuted: '#85857d',
  accent: '#3987e5',
  selection: '#c77700',
};

/** @param {string} hex @returns {[number, number, number]} linear-ish 0..1 sRGB triple */
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex([r, g, b]) {
  const c = (x) => Math.round(Math.min(Math.max(x, 0), 1) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Anchor stops for each ramp; sampled with linear interpolation in sRGB. */
const RAMPS = {
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  magma: ['#000004', '#180f3d', '#440f76', '#721f81', '#9e2f7f', '#cd4071', '#f1605d', '#fd9668', '#feca8d', '#fcfdbf'],
  plasma: ['#0d0887', '#41049d', '#6a00a8', '#8f0da4', '#b12a90', '#cc4778', '#e16462', '#f2844b', '#fca636', '#fcce25'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8678', '#a59c74', '#c3b369', '#e1cc55', '#fee838'],
  turbo: ['#30123b', '#4145ab', '#4675ed', '#39a2fc', '#1bcfd4', '#24eca6', '#61fc6c', '#a4fc3b', '#d1e834', '#f3c53a', '#fe9b2d', '#ea4f0d', '#900c00'],
  // Single-hue ramp from the design system, light to dark so high values stand
  // out on the white surface.
  blue: ['#cde2fb', '#86b6ef', '#5598e7', '#3987e5', '#2a78d6', '#256abf', '#184f95', '#0d366b'],
  grey: ['#eeeeee', '#c6c6c8', '#a0a0a2', '#7c7c7e', '#5a5a5c', '#3a3a3c', '#1c1c1e'],
  // Diverging: two poles that read as opposite, with a light neutral midpoint
  // that recedes into the white surface.
  coolwarm: ['#3987e5', '#7fb0ee', '#b9d2f6', '#d9d9d6', '#f3b6b6', '#e88b8b', '#e34948'],
};

export const RAMP_NAMES = Object.keys(RAMPS);
export const DIVERGING_RAMPS = new Set(['coolwarm']);

const rampCache = new Map();

/** @returns {Float32Array} 256*3 RGB lookup table for a named ramp */
export function rampLUT(name) {
  const key = name in RAMPS ? name : 'viridis';
  let lut = rampCache.get(key);
  if (lut) return lut;
  const stops = RAMPS[key].map(hexToRgb);
  lut = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const i0 = Math.min(Math.floor(t), stops.length - 2);
    const f = t - i0;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[i0][c] * (1 - f) + stops[i0 + 1][c] * f;
  }
  rampCache.set(key, lut);
  return lut;
}

/** @returns {[number, number, number]} */
export function sampleRamp(name, t) {
  const lut = rampLUT(name);
  const i = Math.round(Math.min(Math.max(t, 0), 1) * 255) * 3;
  return [lut[i], lut[i + 1], lut[i + 2]];
}

export function rampCss(name, stops = 12) {
  const parts = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    parts.push(`${rgbToHex(sampleRamp(name, t))} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/**
 * A colour for an unbounded categorical space (lineage clones, of which a run
 * can have hundreds). The first slots reuse the validated palette; beyond that
 * hues advance by the golden angle with alternating lightness so neighbouring
 * indices stay apart. Pairwise CVD safety is impossible at this cardinality —
 * identity comes from click-to-isolate and the hover readout, not the hue.
 */
export function cloneColor(slot) {
  if (slot < CATEGORICAL_EXTENDED.length) return hexToRgb(CATEGORICAL_EXTENDED[slot]);
  const i = slot - CATEGORICAL_EXTENDED.length;
  const hue = (i * 137.508) % 360;
  const light = 0.5 + 0.16 * ((i % 3) - 1);
  return hslToRgb(hue / 360, 0.62, light);
}

export function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** Slot colour for identity encodings that have a bounded, ordered set. */
export function categoricalColor(slot) {
  const list = CATEGORICAL_EXTENDED;
  return hexToRgb(list[slot % list.length]);
}

export function categoricalHex(slot) {
  const list = CATEGORICAL_EXTENDED;
  return list[slot % list.length];
}
