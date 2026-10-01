/**
 * Line segments joining cells to their parents.
 *
 * PhysiCell keeps the mother's ID through a division, so a mother is usually
 * still on screen when her daughters are — most links resolve inside a single
 * frame. Where a parent has died, its last known position can stand in.
 */

import * as THREE from 'three';

const HIDDEN = 4; // must match FLAG_HIDDEN in cellSpheres.js

/**
 * Work out which pairs of cells to join.
 *
 * Pure and DOM-free so it can be tested directly.
 *
 * @param {object} frame the current frame's cell arrays
 * @param {Float64Array} frame.ids
 * @param {Float64Array|null} frame.parentIds
 * @param {Float32Array} frame.positions interleaved xyz
 * @param {Map<number, number>} frame.indexById
 * @param {number} frame.count
 * @param {object} [options]
 * @param {Uint8Array|null} [options.flags] per-cell flags; hidden cells are skipped
 * @param {Set<number>|null} [options.restrictTo] only link cells in this set
 * @param {import('../data/lineage.js').LineageStore|null} [options.lineage]
 *   supplies last known positions for parents that are no longer present
 * @param {boolean} [options.includeDeparted] link to parents absent from this frame
 * @returns {{a: Int32Array, b: Int32Array, extra: Float32Array, count: number, departed: number,
 *            unresolved: number}}
 *   `a`/`b` index into the frame; where `b` is -1 the far end is an "extra"
 *   position (three floats per such link, in order).
 */
export function buildParentLinks(frame, {
  flags = null, restrictTo = null, lineage = null, includeDeparted = false,
} = {}) {
  const { ids, parentIds, indexById, count } = frame;
  const a = new Int32Array(count);
  const b = new Int32Array(count);
  const extras = [];
  let n = 0;
  let departed = 0;
  let unresolved = 0;

  if (!parentIds) return { a: a.subarray(0, 0), b: b.subarray(0, 0), extra: new Float32Array(0), count: 0, departed: 0, unresolved: 0 };

  for (let i = 0; i < count; i++) {
    if (flags && (flags[i] & HIDDEN) !== 0) continue;
    const parentId = parentIds[i];
    if (!(parentId >= 0)) continue; // founder
    if (restrictTo && !(restrictTo.has(ids[i]) && restrictTo.has(parentId))) continue;

    const parentIndex = indexById.get(parentId);
    if (parentIndex !== undefined) {
      if (flags && (flags[parentIndex] & HIDDEN) !== 0) continue;
      a[n] = i;
      b[n] = parentIndex;
      n++;
      continue;
    }

    // The parent is gone from this frame.
    if (!includeDeparted) { unresolved++; continue; }
    const last = lineage?.get(parentId)?.lastPosition;
    if (!last) { unresolved++; continue; }
    a[n] = i;
    b[n] = -1;
    extras.push(last[0], last[1], last[2]);
    n++;
    departed++;
  }

  return {
    a: a.subarray(0, n),
    b: b.subarray(0, n),
    extra: Float32Array.from(extras),
    count: n,
    departed,
    unresolved,
  };
}

export class CellLinks {
  constructor() {
    this.capacity = 0;
    this.count = 0;

    this.geometry = new THREE.BufferGeometry();
    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new THREE.LineSegments(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2; // after the opaque cells, so blending is right
  }

  get object3D() { return this.mesh; }

  setVisible(visible) { this.mesh.visible = visible; }
  setOpacity(opacity) { this.material.opacity = opacity; }

  /** Draw the graph over the cells instead of letting them occlude it. */
  setAlwaysOnTop(onTop) {
    this.material.depthTest = !onTop;
    this.material.needsUpdate = true;
  }

  _ensureCapacity(links) {
    if (links <= this.capacity) return;
    const capacity = Math.max(links, Math.ceil(this.capacity * 1.5), 1024);
    // Replacing attributes in place would strand their GL buffers, so rebuild.
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(capacity * 6), 3);
    const color = new THREE.BufferAttribute(new Float32Array(capacity * 6), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    color.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('color', color);
    this.geometry.dispose();
    this.geometry = geometry;
    this.mesh.geometry = geometry;
    this.aPosition = position;
    this.aColor = color;
    this.capacity = capacity;
  }

  /**
   * @param {{a: Int32Array, b: Int32Array, extra: Float32Array, count: number}} links
   * @param {Float32Array} positions interleaved xyz for the frame
   * @param {Float32Array} colors interleaved rgb for the frame
   */
  update(links, positions, colors) {
    const n = links.count;
    this.count = n;
    if (!n) {
      this.geometry.setDrawRange(0, 0);
      return;
    }
    this._ensureCapacity(n);
    const p = this.aPosition.array;
    const c = this.aColor.array;
    let extraAt = 0;

    for (let i = 0; i < n; i++) {
      const from = links.a[i];
      const to = links.b[i];
      const o = i * 6;

      p[o] = positions[from * 3];
      p[o + 1] = positions[from * 3 + 1];
      p[o + 2] = positions[from * 3 + 2];
      c[o] = colors[from * 3];
      c[o + 1] = colors[from * 3 + 1];
      c[o + 2] = colors[from * 3 + 2];

      if (to >= 0) {
        p[o + 3] = positions[to * 3];
        p[o + 4] = positions[to * 3 + 1];
        p[o + 5] = positions[to * 3 + 2];
        c[o + 3] = colors[to * 3];
        c[o + 4] = colors[to * 3 + 1];
        c[o + 5] = colors[to * 3 + 2];
      } else {
        // A departed parent: fade the far end out so it reads as a loose end.
        p[o + 3] = links.extra[extraAt];
        p[o + 4] = links.extra[extraAt + 1];
        p[o + 5] = links.extra[extraAt + 2];
        extraAt += 3;
        c[o + 3] = colors[from * 3] * 0.25;
        c[o + 4] = colors[from * 3 + 1] * 0.25;
        c[o + 5] = colors[from * 3 + 2] * 0.25;
      }
    }

    this.aPosition.addUpdateRange(0, n * 6);
    this.aColor.addUpdateRange(0, n * 6);
    this.aPosition.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.geometry.setDrawRange(0, n * 2);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
