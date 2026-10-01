/**
 * The 3D stage: renderer, camera, orbit controls, domain box and the axis
 * gizmo. Rendering is on demand — a frame is drawn when something actually
 * changed — so an idle viewer costs nothing.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { UI } from './colors.js';

const AXIS_COLORS = { x: '#e34948', y: '#1baf7a', z: '#3987e5' };

export class Viewer {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // so screenshots can read the canvas back
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(new THREE.Color(UI.surfaceSunken), 1);
    this.renderer.autoClear = false;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
    this.camera.position.set(600, 420, 700);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.9;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);
    this.domainBox = null;
    this.grid = null;

    this._gizmo = this._buildGizmo();

    this.autoRotate = false;
    this.autoRotateSpeed = 0.35; // radians per second
    this._dirty = true;
    this._timer = new THREE.Timer();
    this._onFrame = null;

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this.resize();
  }

  get canvas() { return this.renderer.domElement; }

  requestRender() { this._dirty = true; }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Extra pixels for crisper impostor silhouettes; 1 = native, 2 = supersampled. */
  setSupersample(factor) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio * factor, 4));
    this.resize();
  }

  /**
   * Frame an axis-aligned box.
   * @param {number[]} bbox [xMin, yMin, zMin, xMax, yMax, zMax]
   */
  fitTo(bbox, { keepAngle = false, direction: preferred = null } = {}) {
    const centre = new THREE.Vector3(
      (bbox[0] + bbox[3]) / 2,
      (bbox[1] + bbox[4]) / 2,
      (bbox[2] + bbox[5]) / 2,
    );
    const size = Math.max(bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2], 1);
    const distance = (size / 2) / Math.tan((this.camera.fov * Math.PI) / 360) * 1.6;

    const direction = keepAngle
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : (preferred ? preferred.clone().normalize() : new THREE.Vector3(0.62, 0.45, 0.65).normalize());

    this.controls.target.copy(centre);
    this.camera.position.copy(centre).addScaledVector(direction, distance);
    this.camera.near = Math.max(size / 1000, 0.1);
    this.camera.far = distance * 8 + size * 4;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
  }

  /** Draw the simulation domain as a wireframe box plus an optional floor grid. */
  setDomain(bbox, { showBox = true, showGrid = true } = {}) {
    for (const old of [this.domainBox, this.grid]) {
      if (!old) continue;
      this.helpers.remove(old);
      old.geometry.dispose();
      old.material.dispose();
    }

    const [x0, y0, z0, x1, y1, z1] = bbox;
    const box = new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
    const helper = new THREE.Box3Helper(box, new THREE.Color(UI.outline));
    helper.material.depthWrite = false;
    helper.material.transparent = true;
    helper.material.opacity = 0.85;
    helper.visible = showBox;
    this.helpers.add(helper);
    this.domainBox = helper;

    const span = Math.max(x1 - x0, z1 - z0, 1);
    // Aim for roughly 100 µm squares, but keep the line count sane either way.
    const divisions = Math.min(60, Math.max(2, Math.round(span / 100)));
    const grid = new THREE.GridHelper(span, divisions, new THREE.Color('#cfcfcb'), new THREE.Color('#e4e4e0'));
    grid.position.set((x0 + x1) / 2, y0, (z0 + z1) / 2);
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.material.depthWrite = false;
    grid.visible = showGrid;
    this.helpers.add(grid);
    this.grid = grid;

    this.requestRender();
  }

  setHelperVisibility({ box, grid }) {
    if (this.domainBox && box !== undefined) this.domainBox.visible = box;
    if (this.grid && grid !== undefined) this.grid.visible = grid;
    this.requestRender();
  }

  setBackground(hex) {
    this.renderer.setClearColor(new THREE.Color(hex), 1);
    this.requestRender();
  }

  add(object) { this.scene.add(object); this.requestRender(); }
  remove(object) { this.scene.remove(object); this.requestRender(); }

  /** A small orientation cube in the corner, drawn with its own camera. */
  _buildGizmo() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    const group = new THREE.Group();
    scene.add(group);

    const arm = 1.0;
    for (const [axis, colour] of Object.entries(AXIS_COLORS)) {
      const dir = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
      const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(colour) });
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, arm, 8), material);
      shaft.position.copy(dir).multiplyScalar(arm / 2);
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      group.add(shaft);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.26, 10), material);
      tip.position.copy(dir).multiplyScalar(arm + 0.1);
      tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      group.add(tip);
    }
    return { scene, camera, group, size: 96 };
  }

  _renderGizmo() {
    const { scene, camera, group, size } = this._gizmo;
    const dpr = this.renderer.getPixelRatio();
    const w = this.renderer.domElement.width;
    const pad = Math.round(10 * dpr);
    const s = Math.round(size * dpr);

    group.quaternion.copy(this.camera.quaternion).invert();
    camera.position.set(0, 0, 3.1);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    this.renderer.setScissorTest(true);
    this.renderer.setViewport(w / dpr - size - 10, 10, size, size);
    this.renderer.setScissor((w - s - pad) / dpr, pad / dpr, size, size);
    this.renderer.clearDepth();
    this.renderer.render(scene, camera);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, this.renderer.domElement.width / dpr, this.renderer.domElement.height / dpr);
  }

  /** @param {() => void} callback runs once per animation frame, before rendering */
  start(callback) {
    this.stop(); // a second start() must not leave two loops running
    this._onFrame = callback;
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this._timer.update();
      const delta = this._timer.getDelta();
      if (this.autoRotate) {
        this.controls.autoRotate = true;
        this.controls.autoRotateSpeed = (this.autoRotateSpeed * 180) / Math.PI / 2;
      } else {
        this.controls.autoRotate = false;
      }
      const moved = this.controls.update(delta);
      this._onFrame?.(delta);
      if (moved || this._dirty) {
        this._dirty = false;
        this.renderer.clear();
        this.renderer.render(this.scene, this.camera);
        this._renderGizmo();
      }
    };
    loop();
  }

  stop() { cancelAnimationFrame(this._raf); }

  /** @returns {Promise<Blob>} PNG of the current view */
  screenshot() {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this._renderGizmo();
    return new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
  }

  dispose() {
    this.stop();
    this._resizeObserver.disconnect();
    this.controls.dispose();
    for (const object of [...this._gizmo.group.children, this.domainBox, this.grid]) {
      object?.geometry?.dispose();
      object?.material?.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
