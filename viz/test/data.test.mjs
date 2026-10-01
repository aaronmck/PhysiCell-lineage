/**
 * Tests for the parts of the viewer that do not touch the DOM.
 *
 *   node --test viz/test/
 *
 * The XML parser and everything under render/ and ui/ need a browser and are
 * not covered here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readMat4 } from '../src/data/mat4.js';
import { LineageStore } from '../src/data/lineage.js';
import { buildParentLinks } from '../src/render/links.js';

/* ---------------------------------------------------------------- mat4 */

/** Build a MATLAB level-4 matrix the way BioFVM writes one. */
function makeMat4(name, rows, cols, values, { bigEndian = false } = {}) {
  const nameBytes = new TextEncoder().encode(`${name}\0`);
  const buffer = new ArrayBuffer(20 + nameBytes.length + rows * cols * 8);
  const view = new DataView(buffer);
  const le = !bigEndian;
  view.setUint32(0, bigEndian ? 1000 : 0, le);
  view.setUint32(4, rows, le);
  view.setUint32(8, cols, le);
  view.setUint32(12, 0, le);
  view.setUint32(16, nameBytes.length, le);
  new Uint8Array(buffer, 20, nameBytes.length).set(nameBytes);
  for (let i = 0; i < values.length; i++) view.setFloat64(20 + nameBytes.length + i * 8, values[i], le);
  return buffer;
}

test('mat4: reads a little-endian double matrix column-major', () => {
  const values = [1, 2, 3, 4, 5, 6];
  const { name, rows, cols, data } = readMat4(makeMat4('cells', 3, 2, values));
  assert.equal(name, 'cells');
  assert.equal(rows, 3);
  assert.equal(cols, 2);
  assert.deepEqual([...data], values);
  // Column c starts at c * rows — that is what makes each cell contiguous.
  assert.deepEqual([...data.slice(1 * rows, 2 * rows)], [4, 5, 6]);
});

test('mat4: reads big-endian files', () => {
  const { data } = readMat4(makeMat4('cells', 2, 1, [1.5, -2.25], { bigEndian: true }));
  assert.deepEqual([...data], [1.5, -2.25]);
});

test('mat4: rejects non-MATLAB input instead of returning nonsense', () => {
  const junk = new Uint8Array(64).fill(0xab).buffer;
  assert.throws(() => readMat4(junk), /not a MATLAB v4 file/);
  assert.throws(() => readMat4(new ArrayBuffer(8)), /too short/);
});

test('mat4: rejects a truncated matrix', () => {
  const full = makeMat4('cells', 4, 4, new Array(16).fill(1));
  assert.throws(() => readMat4(full.slice(0, full.byteLength - 8)), /truncated/);
});

test('mat4: a corrupt name length does not throw an opaque RangeError', () => {
  const buffer = makeMat4('cells', 1, 1, [0]);
  new DataView(buffer).setUint32(16, 0xffffff, true);
  assert.throws(() => readMat4(buffer), /not a MATLAB v4 file/);
});

/* -------------------------------------------------------------- lineage */

/** A stand-in for data/dataset.js Frame, carrying only what the store reads. */
function frame(time, cells) {
  return {
    time,
    count: cells.length,
    ids: Float64Array.from(cells, (c) => c.id),
    parentIds: Float64Array.from(cells, (c) => c.parent ?? -1),
    birthTimes: Float64Array.from(cells, (c) => c.birth ?? 0),
  };
}

test('lineage: builds roots, generations and clades from frames', () => {
  const store = new LineageStore();
  store.ingestFrame(frame(0, [{ id: 0, parent: -1, birth: 0 }]));
  store.ingestFrame(frame(10, [
    { id: 0, parent: -1, birth: 0 },
    { id: 1, parent: 0, birth: 10 },
  ]));
  store.ingestFrame(frame(20, [
    { id: 0, parent: -1, birth: 0 },
    { id: 1, parent: 0, birth: 10 },
    { id: 2, parent: 1, birth: 20 },
  ]));

  assert.equal(store.size, 3);
  assert.deepEqual(store.roots(), [0]);
  assert.equal(store.rootOf(2), 0);
  assert.equal(store.generationOf(2), 2);
  assert.equal(store.maxGeneration(), 2);
  assert.deepEqual(store.ancestorsOf(2), [1, 0]);
  assert.deepEqual(store.descendantsOf(0), [1, 2]);
  assert.deepEqual([...store.cladeOf(1)].sort(), [0, 1, 2]);
  assert.equal(store.ancestorAtGeneration(2, 1), 1);
  assert.equal(store.ancestorAtGeneration(2, 0), 0);
  // Asking below a cell's own depth returns the cell itself.
  assert.equal(store.ancestorAtGeneration(0, 3), 0);
});

test('lineage: a late frame loaded first is re-rooted when earlier frames arrive', () => {
  // Scrubbing straight to the end is the normal way to look at a run. Mothers
  // that died before that frame enter the store as placeholder founders; the
  // memoised roots must not survive learning their real parents.
  const store = new LineageStore();
  store.ingestFrame(frame(100, [{ id: 100, parent: 50, birth: 90 }]));

  assert.equal(store.rootOf(100), 50, 'placeholder mother looks like the founder');
  assert.equal(store.generationOf(100), 1);

  store.ingestFrame(frame(50, [
    { id: 20, parent: -1, birth: 0 },
    { id: 50, parent: 20, birth: 40 },
  ]));

  assert.equal(store.rootOf(100), 20, 'root must follow the newly known parent');
  assert.equal(store.generationOf(100), 2);
  assert.deepEqual(store.roots(), [20], 'no phantom founder left behind');
  assert.equal(store.maxGeneration(), 2);
  assert.deepEqual([...store.cladeSlots(0)], [[20, 0]]);

  const layout = store.layout();
  assert.equal(layout.rows, 3, 'each cell gets exactly one row');
  assert.equal(layout.nodes.length, 3);
  assert.equal(new Set(layout.nodes.map((n) => n.id)).size, 3, 'no duplicated subtree');
});

test('lineage: subclone slots are stable and split a single founder', () => {
  const store = new LineageStore();
  const cells = [{ id: 0, parent: -1, birth: 0 }];
  // 0 -> 1, 2 ; 1 -> 3 ; 2 -> 4
  cells.push({ id: 1, parent: 0, birth: 10 }, { id: 2, parent: 0, birth: 12 });
  cells.push({ id: 3, parent: 1, birth: 20 }, { id: 4, parent: 2, birth: 22 });
  store.ingestFrame(frame(30, cells));

  assert.deepEqual(store.roots(), [0]);
  assert.equal(store.ancestorAtGeneration(3, 1), 1);
  assert.equal(store.ancestorAtGeneration(4, 1), 2);
  const slots = store.cladeSlots(1);
  assert.deepEqual([...slots.keys()].sort((a, b) => a - b), [0, 1, 2]);
  // Slots follow ascending cell ID, so a subclone keeps its colour as the
  // population grows.
  assert.equal(slots.get(1), 1);
  assert.equal(slots.get(2), 2);
});

test('lineage: division log fills in cells that never appear in a frame', () => {
  const store = new LineageStore();
  store.ingestFrame(frame(30, [{ id: 3, parent: 1, birth: 25 }]));
  const n = store.ingestDivisionLog('time,parent_ID,daughter_ID\n10,0,1\n12,0,2\n25,1,3\n');
  assert.equal(n, 3);
  assert.ok(store.hasDivisionLog);
  assert.equal(store.rootOf(3), 0);
  assert.equal(store.generationOf(3), 2);
  assert.equal(store.get(2).birth, 12, 'a cell known only from the log still has a birth time');
  assert.equal(store.get(0).birth, 0, 'founders predate the log');
});

test('lineage: layout spans cover divisions and never duplicate a cell', () => {
  const store = new LineageStore();
  store.ingestFrame(frame(0, [{ id: 0, parent: -1, birth: 0 }]));
  store.ingestFrame(frame(40, [
    { id: 0, parent: -1, birth: 0 },
    { id: 1, parent: 0, birth: 10 },
    { id: 2, parent: 0, birth: 30 },
  ]));
  const { nodes, byId, rows } = store.layout();
  assert.equal(rows, 3);
  assert.equal(nodes.length, 3);
  const mother = byId.get(0);
  assert.equal(mother.birth, 0);
  assert.ok(mother.end >= 30, 'a mother must live at least until her last daughter is born');
  assert.deepEqual(mother.children.sort(), [1, 2]);
  // Daughters are laid out in birth order below the mother.
  assert.ok(byId.get(1).row < byId.get(2).row);
});

test('lineage: survives a cyclic parent link without hanging', () => {
  const store = new LineageStore();
  store.ingestFrame(frame(0, [
    { id: 1, parent: 2, birth: 0 },
    { id: 2, parent: 1, birth: 0 },
  ]));
  assert.doesNotThrow(() => store.rootOf(1));
  assert.doesNotThrow(() => store.generationOf(1));
  assert.doesNotThrow(() => store.ancestorAtGeneration(1, 1));
  assert.doesNotThrow(() => store.layout());
});

test('lineage: parseLineageTable reads the end-of-run table', () => {
  const rows = LineageStore.parseLineageTable(
    'ID,parent_ID,x,y,z,neighbor_IDs,branch_length_to_parent\n'
    + '0,-1,15.7,-42.8,36.6,464;215;414,-1\n'
    + '2,0,53.4,-14.8,11.2,,24\n',
  );
  assert.equal(rows.size, 2);
  assert.deepEqual(rows.get(0).neighbors, [464, 215, 414]);
  assert.equal(rows.get(0).branchLength, -1);
  assert.deepEqual(rows.get(2).neighbors, []);
  assert.equal(rows.get(2).branchLength, 24);
});

/* ---------------------------------------------------------------- links */

/** Frame stand-in with the extra fields buildParentLinks needs. */
function linkFrame(cells) {
  const ids = Float64Array.from(cells, (c) => c.id);
  const indexById = new Map(cells.map((c, i) => [c.id, i]));
  return {
    count: cells.length,
    ids,
    parentIds: Float64Array.from(cells, (c) => c.parent ?? -1),
    positions: Float32Array.from(cells.flatMap((c) => c.at ?? [0, 0, 0])),
    indexById,
  };
}

test('links: joins each cell to the parent present in the same frame', () => {
  const frame = linkFrame([
    { id: 0, parent: -1, at: [0, 0, 0] },
    { id: 1, parent: 0, at: [10, 0, 0] },
    { id: 2, parent: 1, at: [20, 0, 0] },
  ]);
  const g = buildParentLinks(frame);
  assert.equal(g.count, 2, 'the founder contributes no link');
  assert.equal(g.unresolved, 0);
  assert.deepEqual([...g.a], [1, 2]);
  assert.deepEqual([...g.b], [0, 1]);
});

test('links: skips hidden cells at either end', () => {
  const frame = linkFrame([
    { id: 0, parent: -1 }, { id: 1, parent: 0 }, { id: 2, parent: 0 },
  ]);
  const HIDDEN = 4;
  // Hide the mother: both of her links go with her.
  assert.equal(buildParentLinks(frame, { flags: Uint8Array.from([HIDDEN, 0, 0]) }).count, 0);
  // Hide one daughter: only her own link goes.
  assert.equal(buildParentLinks(frame, { flags: Uint8Array.from([0, HIDDEN, 0]) }).count, 1);
});

test('links: clade scope keeps only links wholly inside the clade', () => {
  const frame = linkFrame([
    { id: 0, parent: -1 }, { id: 1, parent: 0 }, { id: 2, parent: 0 }, { id: 3, parent: 1 },
  ]);
  const g = buildParentLinks(frame, { restrictTo: new Set([0, 1, 3]) });
  assert.equal(g.count, 2);
  assert.deepEqual([...g.a], [1, 3]);
});

test('links: a departed parent is unresolved unless its last position is allowed', () => {
  const frame = linkFrame([{ id: 5, parent: 4, at: [10, 0, 0] }]);
  const store = new LineageStore();
  store.ingestFrame({
    time: 0,
    count: 1,
    ids: Float64Array.from([4]),
    parentIds: Float64Array.from([-1]),
    birthTimes: Float64Array.from([0]),
    positions: Float32Array.from([1, 2, 3]),
  });

  const without = buildParentLinks(frame, { lineage: store });
  assert.equal(without.count, 0);
  assert.equal(without.unresolved, 1);

  const with_ = buildParentLinks(frame, { lineage: store, includeDeparted: true });
  assert.equal(with_.count, 1);
  assert.equal(with_.departed, 1);
  assert.equal(with_.b[0], -1, 'the far end is an extra position, not a frame index');
  assert.deepEqual([...with_.extra], [1, 2, 3], 'the parent\'s last known position');
});

test('links: a run without parent_ID produces nothing rather than throwing', () => {
  const frame = linkFrame([{ id: 0, parent: -1 }]);
  frame.parentIds = null;
  const g = buildParentLinks(frame);
  assert.equal(g.count, 0);
});
