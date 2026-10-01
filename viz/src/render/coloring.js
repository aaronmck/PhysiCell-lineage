/**
 * Maps a frame of cells onto colours, and describes what it did so the legend
 * can say the same thing in words. Identity encodings (type, phase, clone) use
 * the fixed categorical order; magnitude encodings use a ramp with an explicit
 * range readout.
 */

import { categoricalColor, categoricalHex, cloneColor, rampLUT, sampleRamp, rgbToHex } from './colors.js';

export const PHASE_NAMES = {
  0: 'Ki67+ premitotic', 1: 'Ki67+ postmitotic', 2: 'Ki67+', 3: 'Ki67−',
  4: 'G0/G1', 5: 'G0', 6: 'G1', 7: 'G1a', 8: 'G1b', 9: 'G1c',
  10: 'S', 11: 'G2/M', 12: 'G2', 13: 'M', 14: 'live',
  15: 'G1pm', 16: 'G1ps', 17: 'cycling', 18: 'quiescent',
  100: 'apoptotic', 101: 'necrotic (swelling)', 102: 'necrotic (lysed)',
  103: 'necrotic', 104: 'debris', 9999: 'custom',
};

/** Fixed slot order so a phase keeps its colour whatever else is on screen. */
const PHASE_SLOT_ORDER = [14, 17, 4, 6, 10, 11, 13, 18, 0, 1, 2, 3, 5, 7, 8, 9, 12, 15, 16, 100, 101, 102, 103, 104, 9999];
const PHASE_SLOTS = new Map(PHASE_SLOT_ORDER.map((phase, i) => [phase, i]));

export const CYCLE_MODEL_NAMES = {
  0: 'Ki67 (advanced)', 1: 'Ki67 (basic)', 2: 'flow cytometry', 3: 'live/apoptotic',
  4: 'total cells', 5: 'live', 6: 'flow cytometry (separated)', 7: 'cycling-quiescent',
  100: 'apoptosis', 101: 'necrosis', 102: 'autophagy', 9999: 'custom',
};

export const DEATH_MODEL_NAMES = { 100: 'apoptosis', 101: 'necrosis', 102: 'autophagy' };

/** Columns that are indices into a name table rather than measurements. */
const HIDE_FROM_SCALARS = new Set(['ID', 'parent_ID', 'cell_type', 'cycle_model', 'current_phase',
  'current_death_model', 'dead', 'position_x', 'position_y', 'position_z']);

/**
 * The colour modes available for a dataset, given its label schema.
 * @param {object} meta parsed MultiCellDS metadata
 * @param {{hasLineage:boolean}} caps
 */
export function colorModes(meta, { hasLineage }) {
  const modes = [
    { id: 'cell_type', label: 'Cell type', group: 'Identity' },
    { id: 'cycle_phase', label: 'Cycle phase', group: 'Identity' },
    { id: 'live_dead', label: 'Live / dead', group: 'Identity' },
  ];
  if (hasLineage) {
    modes.push(
      { id: 'clone', label: 'Clone / subclone', group: 'Lineage' },
      { id: 'generation', label: 'Generation', group: 'Lineage' },
      { id: 'birth_time', label: 'Birth time', group: 'Lineage' },
      { id: 'age', label: 'Age since birth', group: 'Lineage' },
    );
  }
  modes.push({ id: 'depth', label: 'Depth (camera)', group: 'Spatial' });
  modes.push({ id: 'uniform', label: 'Single colour', group: 'Spatial' });

  const seen = new Set();
  for (const col of meta.columns) {
    if (HIDE_FROM_SCALARS.has(col.name) || seen.has(col.name)) continue;
    seen.add(col.name);
    modes.push({
      id: `scalar:${col.name}`,
      label: col.units && col.units !== 'none' && col.units !== 'dimensionless'
        ? `${col.name} (${col.units})`
        : col.name,
      group: 'Measurements',
    });
  }
  return modes;
}

function ensure(buffer, n) {
  return buffer && buffer.length >= n * 3 ? buffer : new Float32Array(n * 3);
}

function categoricalPass(frame, out, slotOf, colorOf) {
  const counts = new Map();
  for (let i = 0; i < frame.count; i++) {
    const key = slotOf(i);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const rgb = colorOf(key);
    out[i * 3] = rgb[0];
    out[i * 3 + 1] = rgb[1];
    out[i * 3 + 2] = rgb[2];
  }
  return counts;
}

function rangeOf(values, n, { ignoreNonFinite = true } = {}) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (ignoreNonFinite && !Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min > max) { min = 0; max = 1; }
  return [min, max];
}

function sequentialPass(values, n, out, ramp, min, max, log) {
  const lut = rampLUT(ramp);
  const lo = log ? Math.log10(Math.max(min, 1e-12)) : min;
  const hi = log ? Math.log10(Math.max(max, 1e-12)) : max;
  const span = hi - lo || 1;
  for (let i = 0; i < n; i++) {
    let v = values[i];
    if (!Number.isFinite(v)) v = lo;
    if (log) v = Math.log10(Math.max(v, 1e-12));
    const t = Math.min(Math.max((v - lo) / span, 0), 1);
    const j = (t * 255 + 0.5) | 0;
    out[i * 3] = lut[j * 3];
    out[i * 3 + 1] = lut[j * 3 + 1];
    out[i * 3 + 2] = lut[j * 3 + 2];
  }
}

/**
 * @param {string} mode
 * @param {import('../data/dataset.js').Frame} frame
 * @param {object} ctx
 * @param {import('../data/lineage.js').LineageStore} ctx.lineage
 * @param {string} ctx.ramp
 * @param {boolean} ctx.log
 * @param {[number,number]|null} ctx.fixedRange
 * @param {Float32Array|null} ctx.buffer scratch buffer to reuse
 * @param {THREE.Camera} [ctx.camera]
 * @param {string} [ctx.uniformColor]
 * @returns {{colors: Float32Array, legend: object, values: Float32Array|null}}
 */
export function computeColors(mode, frame, ctx) {
  const n = frame.count;
  const out = ensure(ctx.buffer, n);
  const meta = frame.meta;

  if (mode === 'cell_type') {
    const types = frame.column('cell_type');
    const nameById = new Map(meta.cellTypes.map((t) => [t.id, t.name]));
    const counts = categoricalPass(frame, out, (i) => (types ? types[i] | 0 : 0), (slot) => categoricalColor(slot));
    const ids = [...new Set([...nameById.keys(), ...counts.keys()])].sort((a, b) => a - b);
    return {
      colors: out,
      values: types,
      legend: {
        kind: 'categorical',
        title: 'Cell type',
        entries: ids.map((id) => ({
          value: id,
          label: nameById.get(id) ?? `type ${id}`,
          hex: categoricalHex(id),
          count: counts.get(id) ?? 0,
        })),
      },
    };
  }

  if (mode === 'cycle_phase') {
    const phases = frame.column('current_phase');
    const slotOf = (i) => (phases ? phases[i] | 0 : 14);
    const counts = categoricalPass(frame, out, slotOf, (phase) => categoricalColor(PHASE_SLOTS.get(phase) ?? phase));
    const present = [...counts.keys()].sort((a, b) => (PHASE_SLOTS.get(a) ?? 99) - (PHASE_SLOTS.get(b) ?? 99));
    return {
      colors: out,
      values: phases,
      legend: {
        kind: 'categorical',
        title: 'Cycle phase',
        entries: present.map((phase) => ({
          value: phase,
          label: PHASE_NAMES[phase] ?? `phase ${phase}`,
          hex: categoricalHex(PHASE_SLOTS.get(phase) ?? phase),
          count: counts.get(phase) ?? 0,
        })),
      },
    };
  }

  if (mode === 'live_dead') {
    const dead = frame.column('dead');
    const deathModel = frame.column('current_death_model');
    const slotOf = (i) => {
      if (!dead || dead[i] < 0.5) return 0;
      const model = deathModel ? deathModel[i] | 0 : 100;
      return model === 101 ? 2 : 1;
    };
    const palette = [categoricalColor(2), categoricalColor(7), categoricalColor(3)];
    const counts = categoricalPass(frame, out, slotOf, (slot) => palette[slot]);
    const labels = ['alive', 'apoptotic', 'necrotic'];
    return {
      colors: out,
      values: dead,
      legend: {
        kind: 'categorical',
        title: 'Live / dead',
        entries: [0, 1, 2].filter((s) => counts.has(s)).map((slot) => ({
          value: slot,
          label: labels[slot],
          hex: rgbToHex(palette[slot]),
          count: counts.get(slot) ?? 0,
        })),
      },
    };
  }

  if (mode === 'clone') {
    const depth = Math.max(0, ctx.subcloneDepth | 0);
    const ids = frame.ids;
    const slots = ctx.lineage.cladeSlots(depth);
    const counts = new Map();
    for (let i = 0; i < n; i++) {
      const ancestor = ctx.lineage.ancestorAtGeneration(ids[i], depth);
      counts.set(ancestor, (counts.get(ancestor) ?? 0) + 1);
      const rgb = cloneColor(slots.get(ancestor) ?? 0);
      out[i * 3] = rgb[0];
      out[i * 3 + 1] = rgb[1];
      out[i * 3 + 2] = rgb[2];
    }
    const entries = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ancestor, count]) => ({
        value: ancestor,
        label: depth === 0 ? `founder ${ancestor}` : `cell ${ancestor}`,
        hex: rgbToHex(cloneColor(slots.get(ancestor) ?? 0)),
        count,
      }));
    return {
      colors: out,
      values: null,
      legend: {
        kind: 'categorical',
        title: depth === 0 ? 'Clone (founder)' : `Subclone at generation ${depth}`,
        entries,
        note: entries.length > 8
          ? 'Many subclones: hues repeat visually. Click a cell to isolate its clade.'
          : entries.length === 1 && depth === 0
            ? 'One founder — raise the generation to split this clone into subclones.'
            : null,
      },
    };
  }

  if (mode === 'generation' || mode === 'birth_time' || mode === 'age') {
    const ids = frame.ids;
    const values = new Float32Array(n);
    let units = '';
    if (mode === 'generation') {
      for (let i = 0; i < n; i++) values[i] = ctx.lineage.generationOf(ids[i]);
    } else {
      const births = frame.birthTimes;
      for (let i = 0; i < n; i++) {
        const birth = births ? births[i] : (ctx.lineage.get(ids[i])?.birth ?? 0);
        values[i] = mode === 'age' ? frame.time - birth : birth;
      }
      units = meta.timeUnits;
    }
    const [min, max] = ctx.fixedRange ?? rangeOf(values, n);
    sequentialPass(values, n, out, ctx.ramp, min, max, ctx.log && mode !== 'generation');
    return {
      colors: out,
      values,
      legend: {
        kind: 'sequential',
        title: mode === 'generation' ? 'Generation' : mode === 'age' ? 'Age since birth' : 'Birth time',
        ramp: ctx.ramp,
        min,
        max,
        units,
        log: ctx.log && mode !== 'generation',
      },
    };
  }

  if (mode === 'depth') {
    const positions = frame.positions;
    const values = new Float32Array(n);
    const camera = ctx.camera;
    for (let i = 0; i < n; i++) {
      const dx = positions[i * 3] - camera.position.x;
      const dy = positions[i * 3 + 1] - camera.position.y;
      const dz = positions[i * 3 + 2] - camera.position.z;
      values[i] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const [min, max] = rangeOf(values, n);
    sequentialPass(values, n, out, ctx.ramp, min, max, false);
    return {
      colors: out,
      values,
      legend: { kind: 'sequential', title: 'Distance to camera', ramp: ctx.ramp, min, max, units: meta.mesh.units },
    };
  }

  if (mode === 'uniform') {
    const rgb = sampleRamp(ctx.ramp, 0.62);
    for (let i = 0; i < n; i++) {
      out[i * 3] = rgb[0];
      out[i * 3 + 1] = rgb[1];
      out[i * 3 + 2] = rgb[2];
    }
    return { colors: out, values: null, legend: { kind: 'none', title: 'Single colour' } };
  }

  if (mode.startsWith('scalar:')) {
    const name = mode.slice(7);
    const values = frame.column(name);
    if (!values) {
      return computeColors('uniform', frame, ctx);
    }
    const [min, max] = ctx.fixedRange ?? rangeOf(values, n);
    sequentialPass(values, n, out, ctx.ramp, min, max, ctx.log);
    const spec = meta.column(name);
    return {
      colors: out,
      values,
      legend: {
        kind: 'sequential',
        title: name,
        ramp: ctx.ramp,
        min,
        max,
        units: spec?.units && spec.units !== 'none' ? spec.units : '',
        log: ctx.log,
      },
    };
  }

  return computeColors('cell_type', frame, ctx);
}
