/**
 * PhysiCell 3D viewer — application shell.
 *
 * Wires the data layer (MultiCellDS XML + MATLAB v4 matrices) to the impostor
 * sphere renderer, the lineage store and the DOM controls. Everything runs in
 * the browser: no server beyond a static file host, no build step.
 */

import * as THREE from 'three';
import { Dataset } from './data/dataset.js';
import { HttpSource, FileSource } from './data/source.js';
import { LineageStore } from './data/lineage.js';
import { Viewer } from './render/viewer.js';
import { CellSpheres, FLAG_SELECTED, FLAG_DIMMED, FLAG_HIDDEN } from './render/cellSpheres.js';
import { computeColors, colorModes, PHASE_NAMES } from './render/coloring.js';
import { pickCell } from './render/picking.js';
import { SubstrateSlice } from './render/substrate.js';
import { CellLinks, buildParentLinks } from './render/links.js';
import { renderSVG } from './render/svgExport.js';
import { LineageTree } from './ui/lineageTree.js';
import { RAMP_NAMES, rampCss, UI } from './render/colors.js';

const el = (id) => document.getElementById(id);

const state = {
  dataset: null,
  frame: null,
  frameIndex: 0,
  playing: false,
  loading: false,
  playAccumulator: 0,

  lineage: new LineageStore(),
  hasLineageColumns: false,

  colorMode: 'cell_type',
  subcloneDepth: 0,
  ramp: 'viridis',
  log: false,
  lockedRange: null,
  hiddenValues: new Set(),
  hideDead: false,
  cellScale: 1,

  selection: null,
  highlightMode: 'clade',
  isolate: false,
  highlightSet: null,

  clip: { on: false, axis: 'z', t: 0, cap: true, flip: false },
  links: { on: false, scope: 'all', opacity: 0.55, onTop: true, departed: false },
  substrate: { on: false, field: 0, axis: 'z', slot: 0, ramp: 'viridis', opacity: 0.9 },

  statusBase: 'no dataset',
  colors: null,
  values: null,
  legend: null,
  flags: null,
  bbox: [-500, -500, -500, 500, 500, 500],
};

const viewer = new Viewer(el('stage'));
const cells = new CellSpheres();
viewer.add(cells.mesh);

const substrate = new SubstrateSlice();
viewer.add(substrate.object3D);

const links = new CellLinks();
viewer.add(links.object3D);

const tree = new LineageTree(el('treeCanvas'), state.lineage);
tree.onSelect = (id) => selectCell(id);

const worldClipPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
const viewClipPlane = new THREE.Plane();
const worldUp = new THREE.Vector3(0, 1, 0);
const tmpVec = new THREE.Vector3();

/* ------------------------------------------------------------------ data */

async function openSource(source) {
  setStatus('loading…');
  try {
    const dataset = await Dataset.open(source);
    state.dataset = dataset;
    state.lineage = new LineageStore();
    tree.lineage = state.lineage;
    tree.reset();
    state.selection = null;
    state.highlightSet = null;
    state.hiddenValues.clear();
    state.lockedRange = null;
    el('rangeLock').checked = false;

    const meta = dataset.meta;
    state.hasLineageColumns = Boolean(meta.column('parent_ID') && meta.column('birth_time'));
    state.bbox = meta.mesh.boundingBox;

    buildColorModeOptions(meta);
    buildSubstrateOptions(meta);

    viewer.setDomain(state.bbox, { showBox: el('showBox').checked, showGrid: el('showGrid').checked });
    resetCamera();

    el('frameSlider').max = String(dataset.length - 1);
    el('frameSlider').value = '0';
    el('emptyState').hidden = true;
    el('emptyError').hidden = true;
    el('emptyError').textContent = '';
    setStatus(`${source.label} · ${dataset.length} frame${dataset.length === 1 ? '' : 's'}`);

    await setFrame(0, { force: true });
    loadLineageFiles(dataset).then(() => {
      updateLineageStats();
      // The log reattaches parents to cells that looked like founders, so any
      // lineage-derived colouring is now out of date.
      refreshColors();
      refreshHighlight();
      tree.fit();
    });
    dataset.loadAllTimes((done, total) => {
      if (done === total) {
        updateTimeReadout();
        setStatus(`${source.label} · ${dataset.length} frames · ${formatTime(dataset.frames.at(-1)?.time ?? 0, dataset.meta.timeUnits)}`);
      }
    });
  } catch (err) {
    console.error(err);
    state.dataset = null;
    el('emptyState').hidden = false;
    el('emptyError').hidden = false;
    el('emptyError').textContent = String(err.message || err);
    setStatus('no dataset');
  }
}

/** Pull in the fork's lineage CSVs when the run wrote them. */
async function loadLineageFiles(dataset) {
  const { source } = dataset;
  if (source.has('cell_lineage.csv') !== false) {
    try {
      const n = state.lineage.ingestDivisionLog(await source.text('cell_lineage.csv'));
      if (n) console.info(`lineage: ${n} division events from cell_lineage.csv`);
    } catch { /* the run may predate the lineage patch */ }
  }
}

async function setFrame(index, { force = false } = {}) {
  const dataset = state.dataset;
  if (!dataset) return;
  const clamped = Math.max(0, Math.min(index, dataset.length - 1));
  if (!force && clamped === state.frameIndex && state.frame) return;
  state.frameIndex = clamped;
  el('frameSlider').value = String(clamped);

  state.loading = true;
  let frame;
  try {
    frame = await dataset.frame(clamped);
  } catch (err) {
    console.error(err);
    setStatus(`frame ${clamped} failed: ${err.message}`, { transient: true });
    state.loading = false;
    return;
  }
  state.loading = false;
  if (state.frameIndex !== clamped) return; // superseded while loading
  // A previous frame's failure message has been superseded.
  if (el('sourceLabel').textContent !== state.statusBase) setStatus(state.statusBase);

  state.frame = frame;
  if (state.hasLineageColumns) state.lineage.ingestFrame(frame);

  cells.setGeometryData(frame.positions, frame.radii, frame.count);
  el('subcloneDepth').max = String(Math.max(1, state.lineage.maxGeneration()));
  refreshColors();
  refreshHighlight();
  updateTimeReadout();
  updateHud();
  updateSelectionCard();
  updateSubstrate();
  tree.setTime(frame.time, frame.meta.timeUnits);
  viewer.requestRender();

  dataset.prefetch(clamped + 1);
  dataset.prefetch(clamped + 2);
}

/* --------------------------------------------------------------- colours */

function refreshColors() {
  const frame = state.frame;
  if (!frame) return;
  const result = computeColors(state.colorMode, frame, {
    lineage: state.lineage,
    ramp: state.ramp,
    log: state.log,
    fixedRange: state.lockedRange,
    buffer: state.colors,
    camera: viewer.camera,
    subcloneDepth: state.subcloneDepth,
  });
  state.colors = result.colors;
  state.values = result.values;
  state.legend = result.legend;
  cells.setColors(result.colors, frame.count);
  updateLegend();
  refreshFlags();
  viewer.requestRender();
}

function legendValueOf(index) {
  const frame = state.frame;
  if (!frame) return null;
  if (state.colorMode === 'cell_type') return frame.column('cell_type')?.[index] | 0;
  if (state.colorMode === 'cycle_phase') return frame.column('current_phase')?.[index] | 0;
  if (state.colorMode === 'live_dead') {
    const dead = frame.column('dead');
    if (!dead || dead[index] < 0.5) return 0;
    return (frame.column('current_death_model')?.[index] | 0) === 101 ? 2 : 1;
  }
  if (state.colorMode === 'clone') {
    return state.lineage.ancestorAtGeneration(frame.ids[index], state.subcloneDepth);
  }
  return null;
}

/** Selection, isolation and legend filtering all land in the per-cell flag buffer. */
function refreshFlags() {
  const frame = state.frame;
  if (!frame) return;
  const n = frame.count;
  if (!state.flags || state.flags.length < n) state.flags = new Uint8Array(Math.max(n, 1024));
  const flags = state.flags;
  const ids = frame.ids;
  const dead = state.hideDead ? frame.column('dead') : null;
  const filtering = state.hiddenValues.size > 0;
  const highlight = state.highlightSet;
  const dimOthers = highlight !== null;

  for (let i = 0; i < n; i++) {
    let f = 0;
    if (dead && dead[i] >= 0.5) f = FLAG_HIDDEN;
    else if (filtering && state.hiddenValues.has(legendValueOf(i))) f = FLAG_HIDDEN;
    else if (dimOthers && !highlight.has(ids[i])) f = state.isolate ? FLAG_HIDDEN : FLAG_DIMMED;
    if (state.selection !== null && ids[i] === state.selection) f = (f & ~FLAG_DIMMED) | FLAG_SELECTED;
    flags[i] = f;
  }
  cells.setFlags(flags, n);
  refreshLinks();
  viewer.requestRender();
}

/** Rebuild the parent-link graph for the current frame. */
function refreshLinks() {
  const frame = state.frame;
  const cfg = state.links;
  if (!cfg.on || !frame || !state.colors) {
    links.setVisible(false);
    viewer.requestRender();
    return;
  }
  const restrictTo = cfg.scope === 'clade' ? state.highlightSet : null;
  const graph = buildParentLinks(frame, {
    flags: state.flags,
    restrictTo,
    lineage: state.lineage,
    includeDeparted: cfg.departed,
  });
  links.update(graph, frame.positions, state.colors);
  links.setVisible(graph.count > 0);

  const note = el('linkStats');
  if (!frame.parentIds) {
    note.textContent = 'This run has no parent_ID column.';
  } else if (cfg.scope === 'clade' && !restrictTo) {
    note.textContent = 'Select a cell to see its clade.';
  } else {
    const hidden = !cfg.onTop && state.cellScale > 0.7 && graph.count > 0;
    const lost = graph.unresolved;
    note.textContent = `${graph.count.toLocaleString()} link${graph.count === 1 ? '' : 's'} drawn`
      + (graph.departed ? ` · ${graph.departed.toLocaleString()} to departed parents` : '')
      + (lost && cfg.departed
        // A dead parent can only be placed if some visited frame saw it alive.
        ? `\n${lost.toLocaleString()} parent${lost === 1 ? '' : 's'} never seen — play through earlier frames to place ${lost === 1 ? 'it' : 'them'}`
        : lost ? `\n${lost.toLocaleString()} parent${lost === 1 ? '' : 's'} no longer present` : '')
      + (hidden ? '\nThe cells are covering them — shrink Size or tick "Draw over the cells".' : '');
  }
  viewer.requestRender();
}

function refreshHighlight() {
  const id = state.selection;
  if (id === null || state.highlightMode === 'none') {
    state.highlightSet = null;
  } else if (state.highlightMode === 'clade') {
    state.highlightSet = state.lineage.cladeOf(id);
  } else if (state.highlightMode === 'ancestors') {
    state.highlightSet = new Set([id, ...state.lineage.ancestorsOf(id)]);
  } else if (state.highlightMode === 'descendants') {
    state.highlightSet = new Set([id, ...state.lineage.descendantsOf(id)]);
  } else if (state.highlightMode === 'siblings') {
    const parent = state.lineage.parentOf(id);
    state.highlightSet = new Set([id, ...(parent >= 0 ? [parent, ...state.lineage.childrenOf(parent)] : [])]);
  }
  refreshFlags();
}

/* ------------------------------------------------------------------- UI */

/** The steady-state description of the loaded dataset, restored after errors. */
function setStatus(text, { transient = false } = {}) {
  if (!transient) state.statusBase = text;
  el('sourceLabel').textContent = text;
}

function buildColorModeOptions(meta) {
  const select = el('colorMode');
  const previous = state.colorMode;
  select.innerHTML = '';
  const groups = new Map();
  for (const mode of colorModes(meta, { hasLineage: state.hasLineageColumns })) {
    if (!groups.has(mode.group)) {
      const group = document.createElement('optgroup');
      group.label = mode.group;
      groups.set(mode.group, group);
      select.appendChild(group);
    }
    const option = document.createElement('option');
    option.value = mode.id;
    option.textContent = mode.label;
    groups.get(mode.group).appendChild(option);
  }
  const available = new Set([...select.querySelectorAll('option')].map((o) => o.value));
  state.colorMode = available.has(previous) ? previous : 'cell_type';
  select.value = state.colorMode;
  syncModeVisibility();
}

function buildSubstrateOptions(meta) {
  const panel = el('substratePanel');
  const select = el('subField');
  select.innerHTML = '';
  // Value is the position in the list, because that is what indexes the
  // microenvironment matrix rows; the XML ID is only a label.
  meta.substrates.forEach((sub, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = sub.units && sub.units !== 'dimensionless' ? `${sub.name} (${sub.units})` : sub.name;
    select.appendChild(option);
  });
  state.substrate.field = 0;
  select.value = '0';
  panel.hidden = meta.substrates.length === 0;
  const axisCount = meta.mesh[state.substrate.axis]?.length ?? 1;
  state.substrate.slot = Math.floor(axisCount / 2);
  el('subPos').max = String(Math.max(axisCount - 1, 0));
  el('subPos').value = String(state.substrate.slot);
  el('subPosOut').textContent = String(state.substrate.slot);
}

function syncModeVisibility() {
  const sequential = state.legend ? state.legend.kind === 'sequential' : !isCategoricalMode(state.colorMode);
  for (const node of document.querySelectorAll('[data-when="sequential"]')) node.hidden = !sequential;
  for (const node of document.querySelectorAll('[data-when="clone"]')) node.hidden = state.colorMode !== 'clone';
}

function isCategoricalMode(mode) {
  return mode === 'cell_type' || mode === 'cycle_phase' || mode === 'live_dead' || mode === 'clone' || mode === 'uniform';
}

function updateLegend() {
  const legend = state.legend;
  const node = el('legend');
  if (!legend || legend.kind === 'none') { node.hidden = true; syncModeVisibility(); return; }
  node.hidden = false;
  node.innerHTML = '';

  const title = document.createElement('h3');
  title.textContent = legend.title;
  node.appendChild(title);

  if (legend.kind === 'categorical') {
    const list = document.createElement('div');
    list.className = 'entries';
    for (const entry of legend.entries) {
      const row = document.createElement('div');
      row.className = 'entry';
      if (state.hiddenValues.has(entry.value)) row.classList.add('off');
      row.title = 'Click to show or hide this group';
      row.innerHTML = `<span class="swatch" style="background:${entry.hex}"></span>`
        + `<span class="label"></span><span class="count">${entry.count.toLocaleString()}</span>`;
      row.querySelector('.label').textContent = entry.label;
      row.addEventListener('click', () => {
        if (state.hiddenValues.has(entry.value)) state.hiddenValues.delete(entry.value);
        else state.hiddenValues.add(entry.value);
        updateLegend();
        refreshFlags();
        updateHud();
      });
      list.appendChild(row);
    }
    node.appendChild(list);
    if (legend.note) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = legend.note;
      node.appendChild(note);
    }
  } else {
    const bar = document.createElement('div');
    bar.className = 'ramp';
    bar.style.background = rampCss(legend.ramp);
    node.appendChild(bar);
    const scale = document.createElement('div');
    scale.className = 'scale';
    const suffix = legend.units ? ` ${legend.units}` : '';
    scale.innerHTML = `<span>${formatNumber(legend.min)}${suffix}</span><span>${formatNumber(legend.max)}${suffix}</span>`;
    node.appendChild(scale);
    if (legend.log) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = 'log₁₀ scale';
      node.appendChild(note);
    }
    if (!state.lockedRange) {
      el('rangeMin').value = formatNumber(legend.min);
      el('rangeMax').value = formatNumber(legend.max);
    }
  }
  syncModeVisibility();
}

function updateHud() {
  const frame = state.frame;
  const node = el('hud');
  if (!frame) { node.textContent = ''; return; }
  const visible = countVisible();
  node.innerHTML = `<div class="big">${frame.count.toLocaleString()} cell${frame.count === 1 ? '' : 's'}</div>`
    + (visible !== frame.count ? `<div>${visible.toLocaleString()} shown</div>` : '')
    + `<div id="fpsLine"></div>`;
}

function countVisible() {
  const frame = state.frame;
  if (!frame || !state.flags) return frame?.count ?? 0;
  let n = 0;
  for (let i = 0; i < frame.count; i++) if ((state.flags[i] & FLAG_HIDDEN) === 0) n++;
  return n;
}

function updateTimeReadout() {
  const dataset = state.dataset;
  const frame = state.frame;
  if (!dataset || !frame) { el('timeReadout').textContent = '–'; return; }
  el('timeReadout').textContent =
    `frame ${state.frameIndex + 1} / ${dataset.length}  ·  t = ${formatTime(frame.time, frame.meta.timeUnits)}`;
}

function updateLineageStats() {
  const store = state.lineage;
  const node = el('lineageStats');
  if (!store.size) {
    node.textContent = state.hasLineageColumns
      ? 'No lineage recorded yet.'
      : 'This run has no parent_ID / birth_time columns.';
    return;
  }
  const roots = store.roots().length;
  const maxGeneration = store.maxGeneration();
  node.textContent = `${store.size.toLocaleString()} cells tracked · ${roots} founder${roots === 1 ? '' : 's'}`
    + ` · max generation ${maxGeneration}`
    + (store.hasDivisionLog ? '\ncell_lineage.csv loaded (includes dead cells)' : '');
  el('subcloneDepth').max = String(Math.max(1, maxGeneration));
}

function updateSelectionCard() {
  const node = el('selection');
  const frame = state.frame;
  const id = state.selection;
  if (id === null || !frame) {
    node.innerHTML = '<div class="empty">Click a cell to inspect it.</div>';
    return;
  }
  const index = frame.indexById.get(id);
  const store = state.lineage;
  const info = store.get(id);
  const rows = [];
  const add = (label, value) => rows.push(`<dt>${label}</dt><dd>${value}</dd>`);

  add('ID', id);
  if (index !== undefined) {
    const typeId = frame.column('cell_type')?.[index] | 0;
    const typeName = frame.meta.cellTypes.find((t) => t.id === typeId)?.name ?? `type ${typeId}`;
    const hex = swatchFor(index);
    add('type', `<span class="swatch" style="background:${hex}"></span>${typeName}`);
    const phase = frame.column('current_phase')?.[index];
    if (phase !== undefined) add('phase', PHASE_NAMES[phase | 0] ?? `phase ${phase | 0}`);
    const dead = frame.column('dead')?.[index];
    if (dead !== undefined) add('state', dead >= 0.5 ? 'dead' : 'alive');
    const p = frame.positions;
    add('position', `${p[index * 3].toFixed(1)}, ${p[index * 3 + 1].toFixed(1)}, ${p[index * 3 + 2].toFixed(1)}`);
    add('radius', `${frame.radii[index].toFixed(2)} µm`);
    const pressure = frame.column('pressure')?.[index];
    if (pressure !== undefined) add('pressure', pressure.toFixed(4));
    if (state.values && state.legend?.kind === 'sequential') {
      add(state.legend.title, formatNumber(state.values[index]));
    }
  } else {
    add('state', 'not present in this frame');
  }

  if (info) {
    add('parent', info.parent >= 0 ? info.parent : '— founder');
    if (Number.isFinite(info.birth)) add('born', formatTime(info.birth, frame.meta.timeUnits));
    if (info.parent >= 0) {
      const parentInfo = store.get(info.parent);
      if (parentInfo && Number.isFinite(parentInfo.birth) && Number.isFinite(info.birth)) {
        add('branch', formatTime(info.birth - parentInfo.birth, frame.meta.timeUnits));
      }
    }
    add('generation', store.generationOf(id));
    add('founder', store.rootOf(id));
    add('daughters', info.children.length);
    add('clade', store.cladeOf(id).size);
  }

  node.innerHTML = `<dl>${rows.join('')}</dl>`
    + '<div class="actions">'
    + (info && info.parent >= 0 ? '<button data-act="parent" type="button">Select parent</button>' : '')
    + (info && info.children.length ? '<button data-act="child" type="button">First daughter</button>' : '')
    + '<button data-act="focus" type="button">Centre view</button>'
    + '<button data-act="clear" type="button">Clear</button>'
    + '</div>';

  node.querySelector('[data-act="parent"]')?.addEventListener('click', () => selectCell(info.parent));
  node.querySelector('[data-act="child"]')?.addEventListener('click', () => selectCell(info.children[0]));
  node.querySelector('[data-act="focus"]')?.addEventListener('click', () => focusSelection());
  node.querySelector('[data-act="clear"]')?.addEventListener('click', () => selectCell(null));
}

function swatchFor(index) {
  if (!state.colors) return UI.accent;
  const to255 = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, '0');
  return `#${to255(state.colors[index * 3])}${to255(state.colors[index * 3 + 1])}${to255(state.colors[index * 3 + 2])}`;
}

function selectCell(id) {
  state.selection = id ?? null;
  refreshHighlight();
  updateSelectionCard();
  updateHud();
  tree.setSelected(state.selection);
  viewer.requestRender();
}

function focusSelection() {
  const frame = state.frame;
  if (!frame || state.selection === null) return;
  const index = frame.indexById.get(state.selection);
  if (index === undefined) return;
  const p = frame.positions;
  tmpVec.set(p[index * 3], p[index * 3 + 1], p[index * 3 + 2]);
  const offset = viewer.camera.position.clone().sub(viewer.controls.target);
  viewer.controls.target.copy(tmpVec);
  viewer.camera.position.copy(tmpVec).add(offset);
  viewer.controls.update();
  viewer.requestRender();
}

/* -------------------------------------------------------------- clipping */

function updateClipPlane() {
  const { on, axis, t, cap, flip } = state.clip;
  cells.uniforms.uClipMode.value = on ? (cap ? 2 : 1) : 0;
  if (!on) { viewer.requestRender(); return; }

  const [x0, y0, z0, x1, y1, z1] = state.bbox;
  const normal = new THREE.Vector3();
  const point = new THREE.Vector3();
  let readout;
  if (axis === 'camera') {
    normal.copy(viewer.camera.position).sub(viewer.controls.target).normalize();
    const centre = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    const radius = Math.max(x1 - x0, y1 - y0, z1 - z0) / 2;
    point.copy(centre).addScaledVector(normal, t * radius);
    readout = `${formatNumber(t * radius)} from centre`;
  } else {
    const lo = axis === 'x' ? x0 : axis === 'y' ? y0 : z0;
    const hi = axis === 'x' ? x1 : axis === 'y' ? y1 : z1;
    normal.set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const value = (lo + hi) / 2 + (t * (hi - lo)) / 2;
    point.copy(normal).multiplyScalar(value);
    readout = `${axis} = ${formatNumber(value)}`;
  }
  if (flip) normal.negate();
  worldClipPlane.setFromNormalAndCoplanarPoint(normal, point);
  el('clipPosOut').textContent = readout;
  viewer.requestRender();
}

function uploadClipUniform() {
  if (!state.clip.on) return;
  viewClipPlane.copy(worldClipPlane).applyMatrix4(viewer.camera.matrixWorldInverse);
  cells.uniforms.uClipPlane.value.set(
    viewClipPlane.normal.x, viewClipPlane.normal.y, viewClipPlane.normal.z, viewClipPlane.constant,
  );
}

/* ------------------------------------------------------------- substrate */

let substrateRequest = 0;

async function updateSubstrate() {
  const cfg = state.substrate;
  substrate.setVisible(cfg.on);
  if (!cfg.on || !state.dataset) { viewer.requestRender(); return; }
  // Dragging the slider outruns the loads; only the newest one may draw.
  const request = ++substrateRequest;
  const matrix = await state.dataset.microenvironment(state.frameIndex);
  if (request !== substrateRequest) return;
  if (!matrix) {
    el('subRange').textContent = 'no microenvironment file for this frame';
    substrate.setVisible(false);
    viewer.requestRender();
    return;
  }
  const result = substrate.update(matrix, state.dataset.meta.mesh, {
    substrate: cfg.field,
    axis: cfg.axis,
    slot: cfg.slot,
    ramp: cfg.ramp,
    range: null,
    log: false,
  });
  substrate.setOpacity(cfg.opacity);
  if (result) {
    const name = state.dataset.meta.substrates[cfg.field]?.name ?? 'substrate';
    el('subRange').textContent = `${name} @ ${cfg.axis} = ${formatNumber(result.position)}\n`
      + `${formatNumber(result.min)} … ${formatNumber(result.max)}`;
  }
  viewer.requestRender();
}

/* --------------------------------------------------------------- picking */

let pendingHover = null;

function onPointerMove(event) {
  if (!state.frame) return;
  pendingHover = event;
}

/** @returns {{index:number}|null} */
function pickAt(clientX, clientY) {
  if (!state.frame) return null;
  const rect = viewer.canvas.getBoundingClientRect();
  return pickCell({
    camera: viewer.camera,
    x: clientX - rect.left,
    y: clientY - rect.top,
    width: rect.width,
    height: rect.height,
    positions: state.frame.positions,
    radii: state.frame.radii,
    count: state.frame.count,
    radiusScale: state.cellScale,
    flags: state.flags,
    clip: state.clip.on
      ? { normal: worldClipPlane.normal, constant: worldClipPlane.constant, mode: state.clip.cap ? 2 : 1 }
      : null,
  });
}

function processHover() {
  if (!pendingHover || !state.frame) return;
  const event = pendingHover;
  pendingHover = null;
  const rect = viewer.canvas.getBoundingClientRect();
  const hit = pickAt(event.clientX, event.clientY);

  const tooltip = el('tooltip');
  if (!hit) {
    tooltip.hidden = true;
    viewer.canvas.style.cursor = 'default';
    return;
  }
  viewer.canvas.style.cursor = 'pointer';
  const frame = state.frame;
  const id = frame.ids[hit.index];
  const typeId = frame.column('cell_type')?.[hit.index] | 0;
  const typeName = frame.meta.cellTypes.find((t) => t.id === typeId)?.name ?? `type ${typeId}`;
  const lines = [`cell ${id}  ·  ${typeName}`];
  if (state.hasLineageColumns) {
    const parent = frame.parentIds?.[hit.index];
    lines.push(`parent ${parent >= 0 ? parent : '—'}  ·  gen ${state.lineage.generationOf(id)}`);
  }
  if (state.values && state.legend?.kind === 'sequential') {
    lines.push(`${state.legend.title}: ${formatNumber(state.values[hit.index])}`);
  }
  tooltip.textContent = lines.join('\n');
  tooltip.hidden = false;
  tooltip.style.left = `${event.clientX - rect.left}px`;
  tooltip.style.top = `${event.clientY - rect.top}px`;
}

/* ---------------------------------------------------------------- events */

function bindUI() {
  el('folderInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (files.length) openSource(new FileSource(files));
  });

  el('urlLoad').addEventListener('click', () => {
    const url = el('urlInput').value.trim();
    if (url) openSource(new HttpSource(url));
  });
  el('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') el('urlLoad').click(); });

  el('colorMode').addEventListener('change', (e) => {
    state.colorMode = e.target.value;
    state.hiddenValues.clear();
    state.lockedRange = null;
    el('rangeLock').checked = false;
    refreshColors();
  });

  el('subcloneDepth').addEventListener('input', (e) => {
    state.subcloneDepth = parseInt(e.target.value, 10) || 0;
    el('subcloneOut').textContent = String(state.subcloneDepth);
    // Hidden entries are ancestor IDs, which mean something different at each
    // depth; carrying them over would hide an unrelated subclone.
    state.hiddenValues.clear();
    refreshColors();
  });

  el('ramp').addEventListener('change', (e) => { state.ramp = e.target.value; refreshColors(); });
  el('logScale').addEventListener('change', (e) => { state.log = e.target.checked; refreshColors(); });

  el('rangeLock').addEventListener('change', (e) => {
    if (e.target.checked && state.legend?.kind === 'sequential') {
      state.lockedRange = [state.legend.min, state.legend.max];
    } else {
      state.lockedRange = null;
    }
    refreshColors();
  });

  const applyRange = () => {
    const min = parseFloat(el('rangeMin').value);
    const max = parseFloat(el('rangeMax').value);
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
      state.lockedRange = [min, max];
      el('rangeLock').checked = true;
      refreshColors();
    }
  };
  el('rangeMin').addEventListener('change', applyRange);
  el('rangeMax').addEventListener('change', applyRange);

  el('cellScale').addEventListener('input', (e) => {
    state.cellScale = parseFloat(e.target.value);
    el('cellScaleOut').textContent = `${state.cellScale.toFixed(2)}×`;
    cells.uniforms.uRadiusScale.value = state.cellScale;
    if (state.links.on) refreshLinks();
    viewer.requestRender();
  });

  el('hideDead').addEventListener('change', (e) => { state.hideDead = e.target.checked; refreshFlags(); updateHud(); });
  el('showBox').addEventListener('change', (e) => viewer.setHelperVisibility({ box: e.target.checked }));
  el('showGrid').addEventListener('change', (e) => viewer.setHelperVisibility({ grid: e.target.checked }));

  el('fog').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    el('fogOut').textContent = v.toFixed(2);
    cells.uniforms.uFogStrength.value = v;
    viewer.requestRender();
  });

  el('clipOn').addEventListener('change', (e) => {
    state.clip.on = e.target.checked;
    document.querySelector('[data-when="clip"]').hidden = !state.clip.on;
    updateClipPlane();
  });
  el('clipAxis').addEventListener('change', (e) => { state.clip.axis = e.target.value; updateClipPlane(); });
  el('clipPos').addEventListener('input', (e) => { state.clip.t = parseFloat(e.target.value); updateClipPlane(); });
  el('clipCap').addEventListener('change', (e) => { state.clip.cap = e.target.checked; updateClipPlane(); });
  el('clipFlip').addEventListener('change', (e) => { state.clip.flip = e.target.checked; updateClipPlane(); });

  el('subOn').addEventListener('change', (e) => {
    state.substrate.on = e.target.checked;
    document.querySelector('[data-when="substrate"]').hidden = !state.substrate.on;
    updateSubstrate();
  });
  el('subField').addEventListener('change', (e) => { state.substrate.field = parseInt(e.target.value, 10) || 0; updateSubstrate(); });
  el('subAxis').addEventListener('change', (e) => {
    state.substrate.axis = e.target.value;
    const coords = state.dataset?.meta.mesh[state.substrate.axis] ?? [];
    el('subPos').max = String(Math.max(coords.length - 1, 0));
    state.substrate.slot = Math.floor(coords.length / 2);
    el('subPos').value = String(state.substrate.slot);
    el('subPosOut').textContent = String(state.substrate.slot);
    updateSubstrate();
  });
  el('subPos').addEventListener('input', (e) => {
    state.substrate.slot = parseInt(e.target.value, 10) || 0;
    el('subPosOut').textContent = String(state.substrate.slot);
    updateSubstrate();
  });
  el('subRamp').addEventListener('change', (e) => { state.substrate.ramp = e.target.value; updateSubstrate(); });
  el('subOpacity').addEventListener('input', (e) => {
    state.substrate.opacity = parseFloat(e.target.value);
    el('subOpacityOut').textContent = state.substrate.opacity.toFixed(2);
    substrate.setOpacity(state.substrate.opacity);
    viewer.requestRender();
  });

  el('highlightMode').addEventListener('change', (e) => { state.highlightMode = e.target.value; refreshHighlight(); updateHud(); });
  el('isolate').addEventListener('change', (e) => { state.isolate = e.target.checked; refreshFlags(); updateHud(); });
  el('treeClade').addEventListener('change', (e) => tree.setRestrictToClade(e.target.checked));

  el('linksOn').addEventListener('change', (e) => {
    state.links.on = e.target.checked;
    document.querySelector('[data-when="links"]').hidden = !state.links.on;
    refreshLinks();
  });
  el('linkScope').addEventListener('change', (e) => { state.links.scope = e.target.value; refreshLinks(); });
  el('linkOpacity').addEventListener('input', (e) => {
    state.links.opacity = parseFloat(e.target.value);
    el('linkOpacityOut').textContent = state.links.opacity.toFixed(2);
    links.setOpacity(state.links.opacity);
    viewer.requestRender();
  });
  el('linkOnTop').addEventListener('change', (e) => {
    state.links.onTop = e.target.checked;
    links.setAlwaysOnTop(state.links.onTop);
    viewer.requestRender();
  });
  el('linkDeparted').addEventListener('change', (e) => { state.links.departed = e.target.checked; refreshLinks(); });

  el('autoRotate').addEventListener('change', (e) => { viewer.autoRotate = e.target.checked; viewer.requestRender(); });
  el('rotateSpeed').addEventListener('input', (e) => {
    viewer.autoRotateSpeed = parseFloat(e.target.value);
    el('rotateOut').textContent = viewer.autoRotateSpeed.toFixed(2);
  });
  el('supersample').addEventListener('change', (e) => viewer.setSupersample(e.target.checked ? 2 : 1));
  el('resetView').addEventListener('click', resetCamera);
  el('fitView').addEventListener('click', () => fitToCells());
  el('screenshotBtn').addEventListener('click', saveScreenshot);
  el('svgBtn').addEventListener('click', saveScreenshotSVG);
  el('helpBtn').addEventListener('click', () => el('helpDialog').showModal());

  el('playBtn').addEventListener('click', togglePlay);
  el('prevBtn').addEventListener('click', () => { stopPlayback(); setFrame(state.frameIndex - 1); });
  el('nextBtn').addEventListener('click', () => { stopPlayback(); setFrame(state.frameIndex + 1); });
  el('firstBtn').addEventListener('click', () => { stopPlayback(); setFrame(0); });
  el('lastBtn').addEventListener('click', () => { stopPlayback(); setFrame((state.dataset?.length ?? 1) - 1); });
  el('frameSlider').addEventListener('input', (e) => { stopPlayback(); setFrame(parseInt(e.target.value, 10)); });

  el('treeFit').addEventListener('click', () => tree.fit());
  el('treeToggle').addEventListener('click', toggleTree);
  bindTreeResize();

  viewer.canvas.addEventListener('pointermove', onPointerMove);
  viewer.canvas.addEventListener('pointerleave', () => { pendingHover = null; el('tooltip').hidden = true; });

  // Distinguish a selecting click from the tail of an orbit drag.
  let downAt = null;
  viewer.canvas.addEventListener('pointerdown', (event) => {
    downAt = { x: event.clientX, y: event.clientY, button: event.button };
  });
  viewer.canvas.addEventListener('pointerup', (event) => {
    if (!downAt || downAt.button !== 0 || event.button !== 0) { downAt = null; return; }
    const moved = Math.abs(event.clientX - downAt.x) + Math.abs(event.clientY - downAt.y);
    downAt = null;
    if (moved > 4 || !state.frame) return;
    const hit = pickAt(event.clientX, event.clientY);
    selectCell(hit ? state.frame.ids[hit.index] : null);
  });

  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    switch (event.key) {
      case ' ': event.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': stopPlayback(); setFrame(state.frameIndex - 1); break;
      case 'ArrowRight': stopPlayback(); setFrame(state.frameIndex + 1); break;
      case 'Home': stopPlayback(); setFrame(0); break;
      case 'End': stopPlayback(); setFrame((state.dataset?.length ?? 1) - 1); break;
      case 'f': case 'F': fitToCells(); break;
      case 'r': case 'R': resetCamera(); break;
      case 'c': case 'C': el('clipOn').click(); break;
      case 'l': case 'L': toggleTree(); break;
      case 'Escape': selectCell(null); break;
      default: return;
    }
  });

  // Drag and drop an output folder onto the window.
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length) openSource(new FileSource(files, 'dropped folder'));
  });

  for (const select of [el('ramp'), el('subRamp')]) {
    for (const name of RAMP_NAMES) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
  }
  el('ramp').value = state.ramp;
  el('subRamp').value = state.substrate.ramp;

  document.querySelector('[data-when="clip"]').hidden = true;
  document.querySelector('[data-when="substrate"]').hidden = true;
  document.querySelector('[data-when="links"]').hidden = true;
  links.setAlwaysOnTop(state.links.onTop);
  links.setOpacity(state.links.opacity);
  syncModeVisibility();
}

async function collectDroppedFiles(dataTransfer) {
  const entries = [...(dataTransfer.items ?? [])]
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) return [...(dataTransfer.files ?? [])];

  const files = [];
  const walk = async (entry) => {
    if (entry.isFile) {
      files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      while (true) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return files;
}

/**
 * Frame the whole domain. A 2D run is a thin slab, and a three-quarter view of
 * a monolayer is nearly edge-on, so those open looking straight down the flat
 * axis instead.
 */
function resetCamera() {
  const [x0, y0, z0, x1, y1, z1] = state.bbox;
  const extents = [x1 - x0, y1 - y0, z1 - z0];
  const widest = Math.max(...extents);
  const flatAxis = extents.findIndex((e) => e < widest * 0.1);
  const direction = flatAxis < 0 ? null : new THREE.Vector3(
    flatAxis === 0 ? 1 : 0, flatAxis === 1 ? 1 : 0, flatAxis === 2 ? 1 : 0,
  );
  viewer.fitTo(state.bbox, { direction });
}

function fitToCells() {
  const frame = state.frame;
  if (!frame || !frame.count) return;
  const p = frame.positions;
  const r = frame.radii;
  let box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < frame.count; i++) {
    if (state.flags && (state.flags[i] & FLAG_HIDDEN) !== 0) continue;
    for (let a = 0; a < 3; a++) {
      box[a] = Math.min(box[a], p[i * 3 + a] - r[i]);
      box[a + 3] = Math.max(box[a + 3], p[i * 3 + a] + r[i]);
    }
  }
  if (box[0] > box[3]) return;
  viewer.fitTo(box, { keepAngle: true });
}

function togglePlay() {
  if (!state.dataset) return;
  state.playing = !state.playing;
  el('playBtn').textContent = state.playing ? '❚❚' : '▶';
  state.playAccumulator = 0;
}

function stopPlayback() {
  if (!state.playing) return;
  state.playing = false;
  el('playBtn').textContent = '▶';
}

function bindTreeResize() {
  const handle = el('treeResize');
  const panel = el('treePanel');
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener('pointerdown', (event) => {
    if (panel.classList.contains('collapsed')) return;
    startY = event.clientY;
    startHeight = panel.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    const onMove = (move) => {
      const height = Math.max(80, Math.min(startHeight + (startY - move.clientY), window.innerHeight - 220));
      panel.style.height = `${height}px`;
      tree.draw();
    };
    const onUp = (up) => {
      handle.releasePointerCapture?.(up.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

function toggleTree() {
  const panel = el('treePanel');
  panel.classList.toggle('collapsed');
  el('treeToggle').textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
  if (!panel.classList.contains('collapsed')) requestAnimationFrame(() => tree.draw());
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function saveScreenshot() {
  const blob = await viewer.screenshot();
  if (!blob) return;
  downloadBlob(blob, `physicell_frame${String(state.frameIndex).padStart(5, '0')}.png`);
}

function saveScreenshotSVG() {
  const frame = state.frame;
  if (!frame || !state.colors) return;
  viewer.camera.updateMatrixWorld();

  let linkGraph = null;
  if (state.links.on && frame.parentIds) {
    const restrictTo = state.links.scope === 'clade' ? state.highlightSet : null;
    const graph = buildParentLinks(frame, {
      flags: state.flags,
      restrictTo,
      lineage: state.lineage,
      includeDeparted: state.links.departed,
    });
    if (graph.count) linkGraph = { ...graph, opacity: state.links.opacity, onTop: state.links.onTop };
  }

  const fogStrength = cells.uniforms.uFogStrength.value;
  const distance = viewer.camera.position.distanceTo(viewer.controls.target);
  const span = Math.max(state.bbox[3] - state.bbox[0], state.bbox[4] - state.bbox[1], state.bbox[5] - state.bbox[2]);

  const svg = renderSVG({
    width: viewer.canvas.clientWidth,
    height: viewer.canvas.clientHeight,
    view: viewer.camera.matrixWorldInverse.elements,
    projection: viewer.camera.projectionMatrix.elements,
    positions: frame.positions,
    radii: frame.radii,
    colors: state.colors,
    flags: state.flags,
    count: frame.count,
    radiusScale: state.cellScale,
    background: UI.surfaceSunken,
    fog: fogStrength > 0
      ? { strength: fogStrength, near: Math.max(distance - span * 0.55, 1), far: distance + span * 0.85 }
      : null,
    selection: UI.selection,
    clip: state.clip.on
      ? { normal: worldClipPlane.normal.toArray(), constant: worldClipPlane.constant }
      : null,
    box: viewer.domainBox?.visible ? { bbox: state.bbox, color: UI.outline } : null,
    links: linkGraph,
    meta: `PhysiCell frame ${state.frameIndex} · t = ${formatTime(frame.time, frame.meta.timeUnits)}`,
  });
  downloadBlob(new Blob([svg], { type: 'image/svg+xml' }),
    `physicell_frame${String(state.frameIndex).padStart(5, '0')}.svg`);
}

/* ------------------------------------------------------------ frame loop */

let fpsAccumulator = 0;
let fpsFrames = 0;
let lastCameraKey = '';

function tick(delta) {
  processHover();

  if (state.playing && state.dataset && !state.loading) {
    state.playAccumulator += delta;
    const interval = 1 / Math.max(1, parseFloat(el('fps').value) || 10);
    if (state.playAccumulator >= interval) {
      state.playAccumulator = 0;
      const next = state.frameIndex + 1;
      if (next >= state.dataset.length) {
        if (el('loopPlay').checked) setFrame(0);
        else stopPlayback();
      } else {
        setFrame(next);
      }
    }
  }

  // View-dependent uniforms live in view space, and tick() runs before the
  // renderer refreshes the camera matrices — do it here or they lag a frame.
  viewer.camera.updateMatrixWorld();
  const view = viewer.camera.matrixWorldInverse;
  cells.uniforms.uUp.value.copy(worldUp).transformDirection(view);
  uploadClipUniform();
  cells.uniforms.uViewport.value.set(viewer.canvas.width, viewer.canvas.height);

  const distance = viewer.camera.position.distanceTo(viewer.controls.target);
  const span = Math.max(state.bbox[3] - state.bbox[0], state.bbox[4] - state.bbox[1], state.bbox[5] - state.bbox[2]);
  cells.uniforms.uFogRange.value.set(Math.max(distance - span * 0.55, 1), distance + span * 0.85);

  if (state.colorMode === 'depth') {
    const key = viewer.camera.position.toArray().map((v) => v.toFixed(1)).join(',');
    if (key !== lastCameraKey) { lastCameraKey = key; refreshColors(); }
  }
  if (state.clip.on && state.clip.axis === 'camera') updateClipPlane();

  fpsAccumulator += delta;
  fpsFrames++;
  if (fpsAccumulator >= 0.5) {
    const fps = fpsFrames / fpsAccumulator;
    const line = document.getElementById('fpsLine');
    if (line) line.textContent = `${fps.toFixed(0)} fps`;
    fpsAccumulator = 0;
    fpsFrames = 0;
  }
}

/* ------------------------------------------------------------- utilities */

function formatNumber(value) {
  if (!Number.isFinite(value)) return '–';
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs >= 1e5 || abs < 1e-3) return value.toExponential(2);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toPrecision(3);
}

function formatTime(value, units) {
  if (!Number.isFinite(value)) return '–';
  const base = `${formatNumber(value)} ${units}`;
  if (units !== 'min' || Math.abs(value) < 60) return base;
  const total = Math.floor(value);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const human = days ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
  return `${base}  (${human})`;
}

/* ----------------------------------------------------------------- start */

/**
 * Scripting handle. Everything the UI drives is reachable here, so a run can be
 * automated from the console or a bookmarklet:
 *   pc.setFrame(20); pc.state.colorMode = 'clone'; pc.refreshColors();
 */
window.pc = {
  state,
  viewer,
  cells,
  substrate,
  links,
  tree,
  setFrame,
  refreshColors,
  refreshFlags,
  refreshLinks,
  selectCell,
  saveScreenshotSVG,
  openSource,
  HttpSource,
  FileSource,
  get dataset() { return state.dataset; },
  get frame() { return state.frame; },
  get lineage() { return state.lineage; },
};

bindUI();
viewer.start(tick);
updateLineageStats();

// ?dir=… overrides the default; otherwise assume the conventional layout, where
// the viewer lives in viz/ and the run's output/ is its sibling.
const requestedDir = new URLSearchParams(location.search).get('dir');
if (requestedDir) el('urlInput').value = requestedDir;
openSource(new HttpSource(el('urlInput').value));
