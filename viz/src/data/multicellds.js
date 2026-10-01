/**
 * Parser for MultiCellDS "snapshot/simulation" XML as written by
 * save_PhysiCell_to_MultiCellDS_v2(). The XML is the index for a frame: it
 * carries the time, the mesh, the substrate list, the cell-type table and the
 * label schema that describes the columns of the companion *_cells.mat file.
 */

const num = (s, fallback = NaN) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : fallback;
};

const textOf = (node, sel) => {
  const el = node?.querySelector(sel);
  return el ? el.textContent.trim() : null;
};

const numberList = (s) => (s || '').trim().split(/\s+/).filter(Boolean).map(Number);

/** Vector labels get axis suffixes; everything else gets numeric suffixes. */
const AXIS_SUFFIXED = new Set(['position', 'orientation', 'velocity', 'migration_bias_direction',
  'motility_vector', 'total_attack_time_vector']);

function expandLabel(label) {
  const { name, size } = label;
  if (size === 1) return [name];
  if (size === 3 && AXIS_SUFFIXED.has(name)) return [`${name}_x`, `${name}_y`, `${name}_z`];
  return Array.from({ length: size }, (_, i) => `${name}_${i}`);
}

/**
 * @param {string} xmlText
 * @param {string} frameName base name of the frame, e.g. "output00000012"
 */
export function parseMultiCellDS(xmlText, frameName = '') {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`malformed MultiCellDS XML: ${err.textContent.slice(0, 200)}`);

  const root = doc.documentElement;
  if (root.nodeName !== 'MultiCellDS') throw new Error(`expected <MultiCellDS>, got <${root.nodeName}>`);

  const meta = doc.querySelector('metadata');
  const timeEl = meta?.querySelector('current_time');

  const domain = doc.querySelector('microenvironment > domain');
  const mesh = domain?.querySelector('mesh');
  const bbox = numberList(textOf(mesh, 'bounding_box'));
  const mesh0 = {
    units: mesh?.getAttribute('units') || 'micron',
    // [xMin, yMin, zMin, xMax, yMax, zMax]
    boundingBox: bbox.length === 6 ? bbox : [-500, -500, -500, 500, 500, 500],
    x: numberList(textOf(mesh, 'x_coordinates')),
    y: numberList(textOf(mesh, 'y_coordinates')),
    z: numberList(textOf(mesh, 'z_coordinates')),
    voxelsFile: textOf(mesh, 'voxels > filename'),
  };

  const substrates = [...(domain?.querySelectorAll('variables > variable') || [])].map((v, i) => ({
    id: parseInt(v.getAttribute('ID') ?? i, 10),
    name: v.getAttribute('name') || `substrate_${i}`,
    units: v.getAttribute('units') || '',
    diffusionCoefficient: num(textOf(v, 'diffusion_coefficient')),
    decayRate: num(textOf(v, 'decay_rate')),
  }));

  const simplified = doc.querySelector('cell_population > custom > simplified_data');
  const cellTypes = [...(simplified?.querySelectorAll('cell_types > type') || [])].map((t) => ({
    id: parseInt(t.getAttribute('ID') ?? '0', 10),
    name: (t.textContent || '').trim(),
  }));

  const labels = [...(simplified?.querySelectorAll('labels > label') || [])].map((l) => ({
    index: parseInt(l.getAttribute('index') ?? '0', 10),
    size: parseInt(l.getAttribute('size') ?? '1', 10),
    units: l.getAttribute('units') || '',
    name: (l.textContent || '').trim(),
  }));

  // Flatten labels into one entry per scalar column of the .mat matrix. PhysiCell
  // emits duplicate names (elapsed_time_in_phase appears for cycle and death), so
  // later collisions are disambiguated with a numeric suffix.
  const columns = [];
  const byName = new Map();
  const seen = new Map();
  for (const label of labels) {
    const names = expandLabel(label);
    for (let k = 0; k < names.length; k++) {
      let name = names[k];
      const dupes = seen.get(name) ?? 0;
      seen.set(name, dupes + 1);
      if (dupes > 0) name = `${name}.${dupes}`;
      const col = { name, index: label.index + k, units: label.units, label: label.name, component: k, size: label.size };
      columns.push(col);
      byName.set(name, col);
    }
  }

  const custom = simplified?.parentElement;
  const fileOf = (sel) => textOf(custom, `${sel} > filename`);

  return {
    frameName,
    version: root.getAttribute('version') || '',
    software: {
      name: textOf(meta, 'software > name') || 'PhysiCell',
      version: textOf(meta, 'software > version') || '',
    },
    time: num(timeEl?.textContent, 0),
    timeUnits: timeEl?.getAttribute('units') || 'min',
    runtime: num(textOf(meta, 'current_runtime'), NaN),
    created: textOf(meta, 'created'),
    mesh: mesh0,
    substrates,
    cellTypes,
    labels,
    columns,
    /** @param {string} name @returns {{index:number,units:string}|undefined} */
    column: (name) => byName.get(name),
    files: {
      cells: textOf(simplified, 'filename'),
      microenvironment: textOf(domain, 'data > filename'),
      mesh: mesh0.voxelsFile,
      neighborGraph: fileOf('neighbor_graph'),
      attachedGraph: fileOf('attached_cells_graph'),
      springGraph: fileOf('spring_attached_cells_graph'),
    },
  };
}

/**
 * Parses PhysiCell's adjacency text format: one "id: n1,n2,n3" line per cell.
 * @returns {Map<number, number[]>}
 */
export function parseGraph(text) {
  const graph = new Map();
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const id = parseInt(line.slice(0, colon), 10);
    if (!Number.isFinite(id)) continue;
    const rest = line.slice(colon + 1).trim();
    graph.set(id, rest ? rest.split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite) : []);
  }
  return graph;
}
