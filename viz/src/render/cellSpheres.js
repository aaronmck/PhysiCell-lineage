/**
 * Draws every cell as a ray-traced impostor sphere: one instanced quad per
 * cell, with the sphere solved in the fragment shader and written to the depth
 * buffer. This keeps the whole population in a single draw call with no
 * triangle budget, so a hundred thousand cells stay interactive and every
 * sphere is exactly round at any zoom.
 *
 * The shader also does the section plane, because clipping a ray-traced sphere
 * is a two-line change that yields a real cut face rather than a hollow shell.
 */

import * as THREE from 'three';
import { UI, hexToRgb } from './colors.js';

const VERT = /* glsl */ `
precision highp float;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uRadiusScale;
uniform float uMinPixelRadius;
uniform vec2 uViewport;

in vec3 position;      // base quad corner, in [-1, 1]
in vec3 iPos;          // cell centre, simulation units
in float iRadius;      // cell radius, simulation units
in vec3 iColor;
in float iFlags;       // 1 = selected, 2 = dimmed, 4 = hidden

out vec3 vColor;
out vec3 vCentre;      // view space
out float vRadius;
out vec3 vRay;         // view-space point the fragment ray passes through
out float vFlags;

void main() {
  if (iFlags >= 4.0) {           // hidden: collapse the quad away
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec4 centre = modelViewMatrix * vec4(iPos, 1.0);
  float r = iRadius * uRadiusScale;

  // Keep very distant cells from vanishing into sub-pixel specks.
  if (uMinPixelRadius > 0.0) {
    float pixelScale = projectionMatrix[1][1] * uViewport.y * 0.5 / max(-centre.z, 1e-4);
    r = max(r, uMinPixelRadius / max(pixelScale, 1e-6));
  }

  // The perspective silhouette of a sphere is a cone: at the centre's depth it
  // reads slightly wider than r, so expand the quad by d / sqrt(d^2 - r^2).
  float d = length(centre.xyz);
  float expand = d > r * 1.001 ? d / sqrt(max(d * d - r * r, 1e-6)) : 4.0;

  vec3 p = centre.xyz + vec3(position.xy * r * expand, 0.0);

  vCentre = centre.xyz;
  vRadius = r;
  vColor = iColor;
  vFlags = iFlags;
  vRay = p;

  gl_Position = projectionMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform mat4 projectionMatrix;
uniform vec3 uLightDir;        // view space, normalised, pointing at the light
uniform vec3 uUp;              // world up in view space, for the hemisphere term
uniform vec3 uBackground;
uniform float uAmbient;
uniform float uSpecular;
uniform float uRim;
uniform float uFogStrength;
uniform vec2 uFogRange;        // view-space distances where fog starts and saturates
uniform vec4 uClipPlane;       // view space: xyz = normal, w = offset; keep dot(n,p)+w >= 0
uniform int uClipMode;         // 0 off, 1 cut away, 2 cut and cap
uniform float uDim;            // how far dimmed cells fade toward the background
uniform vec3 uSelection;

in vec3 vColor;
in vec3 vCentre;
in float vRadius;
in vec3 vRay;
in float vFlags;

layout(location = 0) out vec4 fragColor;

void main() {
  vec3 rd = normalize(vRay);
  vec3 oc = -vCentre;                       // eye sits at the origin in view space
  float b = dot(oc, rd);
  float c = dot(oc, oc) - vRadius * vRadius;
  float h = b * b - c;
  if (h < 0.0) discard;                     // ray misses the sphere

  float root = sqrt(h);
  float tNear = -b - root;
  float tFar = -b + root;
  if (tFar < 0.0) discard;                  // sphere is behind the camera
  if (tNear < 0.0) discard;                 // camera is inside this cell

  float t = tNear;
  vec3 normal;
  bool capped = false;

  if (uClipMode > 0) {
    vec3 pNear = rd * tNear;
    if (dot(uClipPlane.xyz, pNear) + uClipPlane.w < 0.0) {
      if (uClipMode == 1) discard;          // plain cut: look straight through
      float denom = dot(uClipPlane.xyz, rd);
      if (abs(denom) < 1e-7) discard;
      float tPlane = -uClipPlane.w / denom;
      if (tPlane < tNear || tPlane > tFar) discard;
      t = tPlane;
      normal = -uClipPlane.xyz;
      capped = true;
    }
  }

  vec3 p = rd * t;
  if (!capped) normal = (p - vCentre) / vRadius;

  vec3 base = vColor;
  bool selected = mod(vFlags, 2.0) >= 1.0;
  bool dimmed = mod(floor(vFlags / 2.0), 2.0) >= 1.0;

  float ndl = max(dot(normal, uLightDir), 0.0);
  float hemi = 0.5 + 0.5 * dot(normal, uUp);
  vec3 col = base * (uAmbient * mix(0.55, 1.0, hemi) + (1.0 - uAmbient) * ndl);

  if (capped) {
    // Flat, slightly darker cut face, with a rim so touching cells stay legible.
    float dc = dot(uClipPlane.xyz, vCentre) + uClipPlane.w;
    float capR = sqrt(max(vRadius * vRadius - dc * dc, 1e-6));
    float edge = length(p - (vCentre - uClipPlane.xyz * dc)) / capR;
    col = base * mix(0.72, 0.30, smoothstep(0.84, 1.0, edge));
  } else {
    vec3 halfDir = normalize(uLightDir - rd);
    col += uSpecular * pow(max(dot(normal, halfDir), 0.0), 40.0);
    float fresnel = pow(1.0 - max(dot(normal, -rd), 0.0), 3.0);
    col += uRim * fresnel * mix(vec3(1.0), base, 0.5);
  }

  if (uFogStrength > 0.0) {
    float fog = smoothstep(uFogRange.x, uFogRange.y, -p.z) * uFogStrength;
    col = mix(col, uBackground, fog);
  }

  if (dimmed) col = mix(col, uBackground, uDim);

  if (selected && !capped) {
    // Silhouette ring, drawn in the shader so selection costs no extra pass.
    float facing = dot(normal, -rd);
    col = mix(col, uSelection, smoothstep(0.55, 0.30, facing));
  }

  vec4 clip = projectionMatrix * vec4(p, 1.0);
  gl_FragDepth = clamp(0.5 * (clip.z / clip.w) + 0.5, 0.0, 1.0);
  fragColor = vec4(col, 1.0);
}
`;

export const FLAG_SELECTED = 1;
export const FLAG_DIMMED = 2;
export const FLAG_HIDDEN = 4;

export class CellSpheres {
  constructor() {
    this.capacity = 0;
    this.count = 0;

    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3,
    ));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.geometry = quad;

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uRadiusScale: { value: 1 },
        uMinPixelRadius: { value: 1.2 }, // device pixels; keeps distant cells from vanishing
        uViewport: { value: new THREE.Vector2(1, 1) },
        uLightDir: { value: new THREE.Vector3(0.4, 0.7, 0.6).normalize() },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        // These two must be plain sRGB triples, not THREE.Color. Colour
        // management would store a Color's components as linear, but this is a
        // RawShaderMaterial — three injects no output conversion, so the
        // fragment colour reaches the framebuffer as written, and iColor comes
        // straight from the sRGB palette. Mixing the two encodings would fade
        // cells to near-black instead of to the background.
        uBackground: { value: new THREE.Vector3(...hexToRgb(UI.surfaceSunken)) },
        uAmbient: { value: 0.38 },
        uSpecular: { value: 0.16 },
        uRim: { value: 0.12 },
        uFogStrength: { value: 0.45 },
        uFogRange: { value: new THREE.Vector2(500, 2500) },
        uClipPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
        uClipMode: { value: 0 },
        uDim: { value: 0.86 },
        uSelection: { value: new THREE.Vector3(...hexToRgb(UI.selection)) },
      },
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });

    this.mesh = new THREE.Mesh(quad, this.material);
    this.mesh.frustumCulled = false; // one draw call; the GPU clips per fragment
    this.mesh.renderOrder = 0;
  }

  get uniforms() { return this.material.uniforms; }

  /**
   * Grow the instance buffers, carrying existing contents over.
   *
   * The geometry is rebuilt rather than having its attributes swapped:
   * replacing an attribute in place leaves its GL buffer allocated forever,
   * because three only deletes buffers for attributes still attached when the
   * geometry is disposed.
   */
  _ensureCapacity(n) {
    if (n <= this.capacity) return;
    const capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 1024);
    const previous = { pos: this.aPos, radius: this.aRadius, color: this.aColor, flags: this.aFlags };
    const instanceCount = this.geometry.instanceCount;

    const make = (size, old) => {
      const array = new Float32Array(capacity * size);
      if (old) array.set(old.array);
      const attr = new THREE.InstancedBufferAttribute(array, size);
      attr.setUsage(THREE.DynamicDrawUsage);
      return attr;
    };

    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3,
    ));
    quad.setIndex([0, 1, 2, 0, 2, 3]);

    this.aPos = make(3, previous.pos);
    this.aRadius = make(1, previous.radius);
    this.aColor = make(3, previous.color);
    this.aFlags = make(1, previous.flags);
    quad.setAttribute('iPos', this.aPos);
    quad.setAttribute('iRadius', this.aRadius);
    quad.setAttribute('iColor', this.aColor);
    quad.setAttribute('iFlags', this.aFlags);
    quad.instanceCount = instanceCount;

    this.geometry.dispose();
    this.geometry = quad;
    this.mesh.geometry = quad;
    this.capacity = capacity;
  }

  /**
   * @param {Float32Array} positions interleaved xyz, length 3n
   * @param {Float32Array} radii length n
   */
  setGeometryData(positions, radii, n) {
    this._ensureCapacity(n);
    this.count = n;
    this.aPos.array.set(positions.subarray(0, n * 3));
    this.aRadius.array.set(radii.subarray(0, n));
    this.aPos.addUpdateRange(0, n * 3);
    this.aRadius.addUpdateRange(0, n);
    this.aPos.needsUpdate = true;
    this.aRadius.needsUpdate = true;
    this.geometry.instanceCount = n;
  }

  /** @param {Float32Array} colors interleaved rgb in 0..1, length 3n */
  setColors(colors, n = this.count) {
    this._ensureCapacity(n);
    this.aColor.array.set(colors.subarray(0, n * 3));
    this.aColor.addUpdateRange(0, n * 3);
    this.aColor.needsUpdate = true;
  }

  /** @param {Float32Array|Uint8Array} flags length n */
  setFlags(flags, n = this.count) {
    this._ensureCapacity(n);
    const dst = this.aFlags.array;
    for (let i = 0; i < n; i++) dst[i] = flags[i];
    this.aFlags.addUpdateRange(0, n);
    this.aFlags.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
