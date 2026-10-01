/**
 * An axis-aligned slice through the diffusing microenvironment, drawn as a
 * textured plane. The voxel grid is read straight out of the *_microenvironment
 * .mat file; voxel centres come from the file itself rather than from an
 * assumed traversal order, so any mesh ordering maps correctly.
 */

import * as THREE from 'three';
import { rampLUT } from './colors.js';

export class SubstrateSlice {
  constructor() {
    this.texture = null;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      }),
    );
    this.mesh.visible = false;
    // Drawn after the opaque cells: it tests depth so cells in front of the
    // plane occlude it, but writes none so cells behind show through.
    this.mesh.renderOrder = 1;
    this.lastRange = [0, 1];
  }

  get object3D() { return this.mesh; }

  setVisible(visible) { this.mesh.visible = visible; }
  setOpacity(opacity) { this.mesh.material.opacity = opacity; }

  /**
   * @param {{rows:number, cols:number, data:Float64Array}} matrix microenvironment matrix
   * @param {object} mesh parsed mesh block (x/y/z coordinate arrays)
   * @param {object} options
   * @param {number} options.substrate index of the substrate (0-based)
   * @param {'x'|'y'|'z'} options.axis slice normal
   * @param {number} options.slot index along that axis
   * @param {string} options.ramp
   * @param {[number,number]|null} options.range null to autoscale to the slice
   * @param {boolean} options.log
   */
  update(matrix, mesh, { substrate = 0, axis = 'z', slot = 0, ramp = 'viridis', range = null, log = false }) {
    if (!matrix) { this.mesh.visible = false; return null; }

    const { rows, cols, data } = matrix;
    const valueRow = 4 + substrate; // rows 0..2 are xyz, row 3 is voxel volume
    if (valueRow >= rows) { this.mesh.visible = false; return null; }

    const coords = { x: mesh.x, y: mesh.y, z: mesh.z };
    const axes = { z: ['x', 'y'], y: ['x', 'z'], x: ['z', 'y'] }[axis];
    const [uName, vName] = axes;
    const uCoords = coords[uName];
    const vCoords = coords[vName];
    const nCoords = coords[axis];
    if (!uCoords?.length || !vCoords?.length || !nCoords?.length) { this.mesh.visible = false; return null; }

    const clampedSlot = Math.min(Math.max(slot | 0, 0), nCoords.length - 1);
    const slicePos = nCoords[clampedSlot];
    const spacing = nCoords.length > 1 ? Math.abs(nCoords[1] - nCoords[0]) : 1;

    const rowOf = { x: 0, y: 1, z: 2 };
    const width = uCoords.length;
    const height = vCoords.length;
    const values = new Float32Array(width * height).fill(NaN);

    const indexIn = (list, value) => {
      if (list.length < 2) return 0;
      const step = list[1] - list[0];
      const i = Math.round((value - list[0]) / step);
      return i >= 0 && i < list.length ? i : -1;
    };

    for (let c = 0; c < cols; c++) {
      const base = c * rows;
      if (Math.abs(data[base + rowOf[axis]] - slicePos) > spacing * 0.5) continue;
      const iu = indexIn(uCoords, data[base + rowOf[uName]]);
      const iv = indexIn(vCoords, data[base + rowOf[vName]]);
      if (iu < 0 || iv < 0) continue;
      values[iv * width + iu] = data[base + valueRow];
    }

    let [min, max] = range ?? [Infinity, -Infinity];
    if (!range) {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) { min = 0; max = 1; }
      if (min === max) max = min + 1e-9;
    }
    this.lastRange = [min, max];

    const lut = rampLUT(ramp);
    const pixels = new Uint8Array(width * height * 4);
    const lo = log ? Math.log10(Math.max(min, 1e-12)) : min;
    const hi = log ? Math.log10(Math.max(max, 1e-12)) : max;
    const span = hi - lo || 1;
    for (let i = 0; i < values.length; i++) {
      const raw = values[i];
      if (!Number.isFinite(raw)) { pixels[i * 4 + 3] = 0; continue; }
      const v = log ? Math.log10(Math.max(raw, 1e-12)) : raw;
      const t = Math.min(Math.max((v - lo) / span, 0), 1);
      const j = ((t * 255 + 0.5) | 0) * 3;
      pixels[i * 4] = lut[j] * 255;
      pixels[i * 4 + 1] = lut[j + 1] * 255;
      pixels[i * 4 + 2] = lut[j + 2] * 255;
      pixels[i * 4 + 3] = 255;
    }

    if (!this.texture || this.texture.image.width !== width || this.texture.image.height !== height) {
      this.texture?.dispose();
      this.texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
      this.texture.minFilter = THREE.LinearFilter;
      this.texture.magFilter = THREE.LinearFilter;
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.mesh.material.map = this.texture;
      this.mesh.material.needsUpdate = true;
    } else {
      this.texture.image.data = pixels;
    }
    this.texture.needsUpdate = true;

    // Cover the full voxel extent, not just centre-to-centre.
    const uStep = uCoords.length > 1 ? uCoords[1] - uCoords[0] : spacing;
    const vStep = vCoords.length > 1 ? vCoords[1] - vCoords[0] : spacing;
    const uSpan = Math.abs(uCoords[uCoords.length - 1] - uCoords[0]) + Math.abs(uStep);
    const vSpan = Math.abs(vCoords[vCoords.length - 1] - vCoords[0]) + Math.abs(vStep);
    const uMid = (uCoords[0] + uCoords[uCoords.length - 1]) / 2;
    const vMid = (vCoords[0] + vCoords[vCoords.length - 1]) / 2;

    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(uSpan, vSpan);
    // Orient the quad so its local +x follows uCoords and +y follows vCoords.
    this.mesh.rotation.set(0, 0, 0);
    if (axis === 'z') {
      this.mesh.position.set(uMid, vMid, slicePos);
    } else if (axis === 'y') {
      this.mesh.rotation.x = Math.PI / 2; // local +y -> world +z
      this.mesh.position.set(uMid, slicePos, vMid);
    } else {
      this.mesh.rotation.y = -Math.PI / 2; // local +x -> world +z
      this.mesh.position.set(slicePos, vMid, uMid);
    }

    return { min, max, width, height, position: slicePos };
  }

  dispose() {
    this.texture?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
