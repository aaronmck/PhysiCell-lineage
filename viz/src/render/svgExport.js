/**
 * Vector export of the current view. Rebuilds what the impostor renderer shows
 * from the same inputs — positions, radii, colours, flags, camera — as an SVG:
 * each cell is a depth-sorted circle with a shared shading gradient, plus the
 * domain box and the parent-link graph when they are on screen.
 *
 * Approximations against the GL view, chosen to keep the output plain vector:
 * the section plane keeps or drops whole cells by their centre (no cut faces),
 * sphere intersections resolve by centre depth rather than per pixel, and the
 * substrate slice, floor grid and axis gizmo are not exported.
 *
 * Pure and DOM-free: camera matrices arrive as column-major 16-element arrays
 * (three.js `.elements`), so this module can be tested under node.
 */

import { rgbToHex } from './colors.js';

// Must match cellSpheres.js.
const FLAG_SELECTED = 1;
const FLAG_DIMMED = 2;
const FLAG_HIDDEN = 4;

/** Column-major 4x4 times (x, y, z, 1). */
function apply(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

const num = (v) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

function smoothstep(a, b, x) {
  const t = Math.min(Math.max((x - a) / (b - a || 1), 0), 1);
  return t * t * (3 - 2 * t);
}

const mix = (a, b, t) => a + (b - a) * t;

/**
 * @param {object} o
 * @param {number} o.width CSS-pixel size of the output
 * @param {number} o.height
 * @param {number[]} o.view camera.matrixWorldInverse.elements
 * @param {number[]} o.projection camera.projectionMatrix.elements
 * @param {Float32Array} o.positions interleaved xyz, simulation units
 * @param {Float32Array} o.radii
 * @param {Float32Array} o.colors interleaved rgb in 0..1
 * @param {Uint8Array|null} o.flags per-cell FLAG_* bits
 * @param {number} o.count
 * @param {number} [o.radiusScale]
 * @param {string} [o.background] fill behind everything; '' or 'none' for transparent
 * @param {{strength:number, near:number, far:number}|null} [o.fog]
 *   view-space depth-cueing, matching the shader's uFogStrength / uFogRange
 * @param {number} [o.dim] how far dimmed cells fade toward the background
 * @param {string} [o.selection] outline colour for selected cells
 * @param {{normal:number[], constant:number}|null} [o.clip]
 *   world-space section plane; cells whose centre has normal·p + constant < 0 are dropped
 * @param {{bbox:number[], color:string}|null} [o.box] domain wireframe
 * @param {{a:Int32Array, b:Int32Array, extra:Float32Array, count:number,
 *          opacity:number, onTop:boolean}|null} [o.links] parent-link graph,
 *   as built by buildParentLinks; coloured by the child cell
 * @param {string} [o.meta] human-readable description, embedded as <desc>
 * @returns {string} a complete SVG document
 */
export function renderSVG({
  width, height, view, projection,
  positions, radii, colors, flags = null, count = 0,
  radiusScale = 1,
  background = '#ffffff',
  fog = null,
  dim = 0.86,
  selection = '#c77700',
  clip = null,
  box = null,
  links = null,
  meta = '',
} = {}) {
  const halfH = height / 2;
  const halfW = width / 2;
  const pxPerView = (z) => (projection[5] * halfH) / Math.max(-z, 1e-6);

  const toScreen = (x, y, z) => {
    const [vx, vy, vz] = apply(view, x, y, z);
    if (vz > -1e-6) return null; // at or behind the eye
    const c = apply(projection, vx, vy, vz);
    return { x: halfW + (c[0] / c[3]) * halfW, y: halfH - (c[1] / c[3]) * halfH, z: vz };
  };

  const bgHex = [0, 0, 0];
  if (background && background !== 'none') {
    const h = background.replace('#', '');
    const v = parseInt(h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h, 16);
    bgHex[0] = ((v >> 16) & 255) / 255;
    bgHex[1] = ((v >> 8) & 255) / 255;
    bgHex[2] = (v & 255) / 255;
  } else {
    bgHex[0] = bgHex[1] = bgHex[2] = 1;
  }

  /** The shader's fog and dim, collapsed to one colour per cell. */
  const cellHex = (i, z, dimmed) => {
    let r = colors[i * 3];
    let g = colors[i * 3 + 1];
    let b = colors[i * 3 + 2];
    if (fog && fog.strength > 0) {
      const f = smoothstep(fog.near, fog.far, -z) * fog.strength;
      r = mix(r, bgHex[0], f);
      g = mix(g, bgHex[1], f);
      b = mix(b, bgHex[2], f);
    }
    if (dimmed) {
      r = mix(r, bgHex[0], dim);
      g = mix(g, bgHex[1], dim);
      b = mix(b, bgHex[2], dim);
    }
    return rgbToHex([r, g, b]);
  };

  const visible = (i) => {
    if (flags && (flags[i] & FLAG_HIDDEN) !== 0) return false;
    if (clip) {
      const dot = clip.normal[0] * positions[i * 3]
        + clip.normal[1] * positions[i * 3 + 1]
        + clip.normal[2] * positions[i * 3 + 2];
      if (dot + clip.constant < 0) return false;
    }
    return true;
  };

  // Project every visible cell, then paint back to front.
  const cells = [];
  for (let i = 0; i < count; i++) {
    if (!visible(i)) continue;
    const s = toScreen(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    if (!s) continue;
    const r = Math.max(radii[i] * radiusScale * pxPerView(s.z), 0.4);
    if (s.x + r < 0 || s.x - r > width || s.y + r < 0 || s.y - r > height) continue;
    cells.push({ i, x: s.x, y: s.y, z: s.z, r });
  }
  cells.sort((a, b) => a.z - b.z);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  if (meta) parts.push(`<desc>${meta.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</desc>`);
  parts.push(
    '<defs><radialGradient id="shade" cx="0.35" cy="0.3" r="0.75">'
    + '<stop offset="0" stop-color="#fff" stop-opacity="0.45"/>'
    + '<stop offset="0.4" stop-color="#fff" stop-opacity="0"/>'
    + '<stop offset="0.75" stop-color="#000" stop-opacity="0"/>'
    + '<stop offset="1" stop-color="#000" stop-opacity="0.28"/>'
    + '</radialGradient></defs>',
  );
  if (background && background !== 'none') {
    parts.push(`<rect width="${width}" height="${height}" fill="${background}"/>`);
  }

  if (box) {
    const [x0, y0, z0, x1, y1, z1] = box.bbox;
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ].map(([x, y, z]) => toScreen(x, y, z));
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const segs = [];
    for (const [a, b] of edges) {
      const p = corners[a];
      const q = corners[b];
      if (!p || !q) continue;
      segs.push(`<line x1="${num(p.x)}" y1="${num(p.y)}" x2="${num(q.x)}" y2="${num(q.y)}"/>`);
    }
    if (segs.length) {
      parts.push(`<g stroke="${box.color ?? '#a9a9a4'}" stroke-opacity="0.85" fill="none">${segs.join('')}</g>`);
    }
  }

  const drawLinks = () => {
    if (!links || !links.count) return;
    const segs = [];
    let extraAt = 0;
    for (let k = 0; k < links.count; k++) {
      const from = links.a[k];
      const to = links.b[k];
      const p = toScreen(positions[from * 3], positions[from * 3 + 1], positions[from * 3 + 2]);
      let q;
      if (to >= 0) {
        q = toScreen(positions[to * 3], positions[to * 3 + 1], positions[to * 3 + 2]);
      } else {
        q = toScreen(links.extra[extraAt], links.extra[extraAt + 1], links.extra[extraAt + 2]);
        extraAt += 3;
      }
      if (!p || !q) continue;
      const dimmed = flags ? (flags[from] & FLAG_DIMMED) !== 0 : false;
      segs.push(`<line x1="${num(p.x)}" y1="${num(p.y)}" x2="${num(q.x)}" y2="${num(q.y)}" stroke="${cellHex(from, p.z, dimmed)}"/>`);
    }
    if (segs.length) {
      parts.push(`<g stroke-opacity="${num(links.opacity ?? 0.55)}" stroke-width="1" fill="none">${segs.join('')}</g>`);
    }
  };

  if (links && !links.onTop) drawLinks();

  const circles = [];
  for (const c of cells) {
    const isFlagged = flags ? flags[c.i] : 0;
    const hex = cellHex(c.i, c.z, (isFlagged & FLAG_DIMMED) !== 0);
    const sel = (isFlagged & FLAG_SELECTED) !== 0
      ? ` stroke="${selection}" stroke-width="${num(Math.max(1, c.r * 0.1))}"`
      : '';
    circles.push(`<circle cx="${num(c.x)}" cy="${num(c.y)}" r="${num(c.r)}" fill="${hex}"${sel}/>`);
    // The shading overlay reads as sphericity; sub-pixel circles don't need it.
    if (c.r >= 2.5) {
      circles.push(`<circle cx="${num(c.x)}" cy="${num(c.y)}" r="${num(c.r)}" fill="url(#shade)"/>`);
    }
  }
  parts.push(`<g>${circles.join('')}</g>`);

  if (links && links.onTop) drawLinks();

  parts.push('</svg>');
  return parts.join('\n');
}
