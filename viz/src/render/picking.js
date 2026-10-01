/**
 * Cell picking. The impostors have no triangles to raycast against, so the hit
 * test is an analytic ray-sphere sweep over the instance buffer — the same
 * intersection the shader does, mirrored on the CPU so what you click is what
 * you see, including the section plane.
 *
 * A linear sweep is fast enough at these sizes (a hundred thousand cells is a
 * fraction of a millisecond) and needs no acceleration structure to keep in
 * sync with the frame.
 */

import * as THREE from 'three';

const ray = new THREE.Ray();
const ndc = new THREE.Vector2();
const origin = new THREE.Vector3();
const direction = new THREE.Vector3();

/**
 * @param {object} opts
 * @param {THREE.Camera} opts.camera
 * @param {number} opts.x pointer x in CSS pixels, relative to the canvas
 * @param {number} opts.y pointer y in CSS pixels, relative to the canvas
 * @param {number} opts.width canvas CSS width
 * @param {number} opts.height canvas CSS height
 * @param {Float32Array} opts.positions interleaved xyz
 * @param {Float32Array} opts.radii
 * @param {number} opts.count
 * @param {number} [opts.radiusScale]
 * @param {Uint8Array} [opts.flags] per-cell flags; hidden cells are skipped
 * @param {{normal:THREE.Vector3, constant:number, mode:number}} [opts.clip]
 * @returns {{index:number, distance:number, point:THREE.Vector3}|null}
 */
export function pickCell({
  camera, x, y, width, height,
  positions, radii, count,
  radiusScale = 1, flags = null, clip = null,
}) {
  if (!count) return null;

  ndc.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
  ray.origin.setFromMatrixPosition(camera.matrixWorld);
  direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(ray.origin).normalize();
  ray.direction.copy(direction);
  origin.copy(ray.origin);

  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = direction.x, dy = direction.y, dz = direction.z;

  const clipping = clip && clip.mode > 0;
  const nx = clipping ? clip.normal.x : 0;
  const ny = clipping ? clip.normal.y : 0;
  const nz = clipping ? clip.normal.z : 0;
  const nw = clipping ? clip.constant : 0;
  const nDotD = clipping ? nx * dx + ny * dy + nz * dz : 0;

  let best = -1;
  let bestT = Infinity;

  for (let i = 0; i < count; i++) {
    if (flags && (flags[i] & 4) !== 0) continue; // hidden

    const cx = positions[i * 3] - ox;
    const cy = positions[i * 3 + 1] - oy;
    const cz = positions[i * 3 + 2] - oz;

    const b = cx * dx + cy * dy + cz * dz;
    if (b <= 0) continue; // behind the camera

    const r = radii[i] * radiusScale;
    const perpSq = cx * cx + cy * cy + cz * cz - b * b;
    const rSq = r * r;
    if (perpSq > rSq) continue; // ray misses

    const root = Math.sqrt(rSq - perpSq);
    let t = b - root;
    if (t < 0) continue; // camera inside this cell

    if (clipping) {
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      if (nx * px + ny * py + nz * pz + nw < 0) {
        if (clip.mode === 1) continue; // cut away entirely
        if (Math.abs(nDotD) < 1e-9) continue;
        const tPlane = -(nx * ox + ny * oy + nz * oz + nw) / nDotD;
        if (tPlane < t || tPlane > b + root) continue;
        t = tPlane;
      }
    }

    if (t < bestT) { bestT = t; best = i; }
  }

  if (best < 0) return null;
  return {
    index: best,
    distance: bestT,
    point: new THREE.Vector3(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT),
  };
}
