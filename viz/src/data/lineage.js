/**
 * Lineage bookkeeping for the fork of PhysiCell that records parent_ID and
 * birth_time per cell (see core/PhysiCell_cell.cpp, Cell::divide).
 *
 * Two sources feed the same store:
 *  - every frame that is loaded, which carries ID / parent_ID / birth_time for
 *    the cells alive at that time;
 *  - the optional cell_lineage.csv division log, which also covers cells that
 *    died before any snapshot was written.
 *
 * At division the mother keeps its ID and original birth_time while the
 * daughter gets a fresh ID whose parent_ID is the mother's. A cell is therefore
 * one node with one horizontal span in the tree, sprouting a child branch at
 * each division.
 */

const NO_PARENT = -1;

export class LineageStore {
  constructor() {
    /** @type {Map<number, {id:number, parent:number, birth:number, firstSeen:number, lastSeen:number, children:number[]}>} */
    this.cells = new Map();
    this.hasDivisionLog = false;
    this.version = 0; // bumped whenever the store changes, so views can invalidate
    this._rootCache = new Map();
    this._genCache = new Map();
  }

  _node(id) {
    let node = this.cells.get(id);
    if (!node) {
      node = {
        id,
        parent: NO_PARENT,
        birth: NaN,
        firstSeen: Infinity,
        lastSeen: -Infinity,
        children: [],
        /** where this cell was the last time it was seen, for links to dead parents */
        lastPosition: null,
      };
      this.cells.set(id, node);
    }
    return node;
  }

  /**
   * Attaching a brand-new leaf cannot change any answer already memoised, so
   * the common case — a frame introducing daughters — leaves the ancestry
   * caches alone. Giving a parent to a cell the store *already knew about*
   * does move the root of everything beneath it, and that must clear them.
   * The version counter moves on every change either way, so views redraw.
   */
  _invalidate({ structural = false } = {}) {
    if (structural) {
      this._rootCache.clear();
      this._genCache.clear();
      this._ancestorCaches = null;
    }
    this.version++;
  }

  /** @returns {boolean} true if this call actually set or changed the parent */
  _link(childId, parentId) {
    if (parentId === NO_PARENT || parentId === childId) return false;
    const child = this._node(childId);
    if (child.parent === parentId) return false;
    child.parent = parentId;
    const parent = this._node(parentId);
    if (!parent.children.includes(childId)) parent.children.push(childId);
    return true;
  }

  /** Fold one loaded frame into the store. */
  ingestFrame(frame) {
    const ids = frame.ids;
    const parents = frame.parentIds;
    const births = frame.birthTimes;
    const time = frame.time;
    const positions = frame.positions;
    let structural = false;
    for (let i = 0; i < frame.count; i++) {
      const id = ids[i];
      // A cell can already be in the store as the *parent* of something seen
      // earlier — scrub backwards and a mother who died before the first loaded
      // frame is a placeholder founder until her own snapshot arrives. Learning
      // her parent then re-roots her whole subtree.
      const known = this.cells.has(id);
      const node = this._node(id);
      if (births) node.birth = births[i];
      if (parents && this._link(id, parents[i]) && known) structural = true;
      if (time < node.firstSeen) node.firstSeen = time;
      if (time >= node.lastSeen) {
        node.lastSeen = time;
        if (positions) {
          node.lastPosition = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
        }
      }
    }
    this._invalidate({ structural });
  }

  /** Parse cell_lineage.csv: `time,parent_ID,daughter_ID`. */
  ingestDivisionLog(csvText) {
    const lines = csvText.split('\n');
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('time')) continue;
      const parts = line.split(',');
      if (parts.length < 3) continue;
      const time = parseFloat(parts[0]);
      const parentId = parseInt(parts[1], 10);
      const daughterId = parseInt(parts[2], 10);
      if (!Number.isFinite(time) || !Number.isFinite(daughterId)) continue;
      const daughter = this._node(daughterId);
      if (!Number.isFinite(daughter.birth)) daughter.birth = time;
      this._link(daughterId, parentId);
      n++;
    }
    if (n) {
      this.hasDivisionLog = true;
      // Founders predate the log; anything still unstamped was alive at t=0.
      for (const node of this.cells.values()) {
        if (!Number.isFinite(node.birth) && node.parent === NO_PARENT) node.birth = 0;
      }
      // The log can attach parents to cells already seen as founders, so the
      // ancestry caches must go.
      this._invalidate({ structural: true });
    }
    return n;
  }

  /**
   * Parse lineage_table.csv, the end-of-run per-cell table.
   * @returns {Map<number, {parent:number, x:number, y:number, z:number, neighbors:number[], branchLength:number}>}
   */
  static parseLineageTable(csvText) {
    const out = new Map();
    const lines = csvText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('ID,')) continue;
      const p = line.split(',');
      if (p.length < 7) continue;
      const id = parseInt(p[0], 10);
      if (!Number.isFinite(id)) continue;
      out.set(id, {
        parent: parseInt(p[1], 10),
        x: parseFloat(p[2]),
        y: parseFloat(p[3]),
        z: parseFloat(p[4]),
        neighbors: p[5] ? p[5].split(';').map(Number).filter(Number.isFinite) : [],
        branchLength: parseFloat(p[6]),
      });
    }
    return out;
  }

  has(id) { return this.cells.has(id); }
  get(id) { return this.cells.get(id); }
  get size() { return this.cells.size; }

  parentOf(id) {
    const node = this.cells.get(id);
    return node ? node.parent : NO_PARENT;
  }

  childrenOf(id) {
    const node = this.cells.get(id);
    return node ? node.children : [];
  }

  /** The founder this cell descends from; the cell itself if it is a founder. */
  rootOf(id) {
    const cached = this._rootCache.get(id);
    if (cached !== undefined) return cached;
    const path = [];
    let cur = id;
    while (true) {
      const memo = this._rootCache.get(cur);
      if (memo !== undefined) { cur = memo; break; }
      const node = this.cells.get(cur);
      // Never memoise an answer for a cell the store has not seen: it may yet
      // arrive with a parent, and the cached "it is its own root" would stick.
      if (!node) return cur;
      path.push(cur);
      if (node.parent === NO_PARENT || !this.cells.has(node.parent)) break;
      cur = node.parent;
      if (path.length > this.cells.size) break; // corrupt data: cycle
    }
    for (const p of path) this._rootCache.set(p, cur);
    return cur;
  }

  /** Number of divisions between the founder and this cell. */
  generationOf(id) {
    const cached = this._genCache.get(id);
    if (cached !== undefined) return cached;
    const path = [];
    let cur = id;
    let depth = 0;
    while (true) {
      const memo = this._genCache.get(cur);
      if (memo !== undefined) { depth = memo; break; }
      const node = this.cells.get(cur);
      if (!node) break; // unknown cell: answer now, but do not memoise it
      if (node.parent === NO_PARENT || !this.cells.has(node.parent)) {
        this._genCache.set(cur, 0);
        break;
      }
      path.push(cur);
      cur = node.parent;
      if (path.length > this.cells.size) break; // corrupt data: cycle
    }
    // path runs from `id` up to (but excluding) the first cell of known depth.
    for (let i = path.length - 1; i >= 0; i--) this._genCache.set(path[i], ++depth);
    return this._genCache.get(id) ?? 0;
  }

  /** Ancestors from the immediate parent up to the founder. */
  ancestorsOf(id) {
    const out = [];
    let cur = this.parentOf(id);
    const guard = new Set([id]);
    while (cur !== NO_PARENT && this.cells.has(cur) && !guard.has(cur)) {
      out.push(cur);
      guard.add(cur);
      cur = this.parentOf(cur);
    }
    return out;
  }

  /** Every cell below this one, breadth-first. */
  descendantsOf(id) {
    const out = [];
    const queue = [...this.childrenOf(id)];
    const seen = new Set(queue);
    while (queue.length) {
      const cur = queue.shift();
      out.push(cur);
      for (const child of this.childrenOf(cur)) {
        if (!seen.has(child)) { seen.add(child); queue.push(child); }
      }
    }
    return out;
  }

  /** The cell, its ancestors and all their descendants — one whole clone. */
  cladeOf(id) {
    return new Set([id, ...this.ancestorsOf(id), ...this.descendantsOf(id)]);
  }

  /** Distinct founders, in ascending ID order — the stable order for clone colors. */
  roots() {
    if (this._roots && this._rootsVersion === this.version) return this._roots;
    const set = new Set();
    for (const id of this.cells.keys()) set.add(this.rootOf(id));
    this._roots = [...set].sort((a, b) => a - b);
    this._rootsVersion = this.version;
    return this._roots;
  }

  /** Map of founder ID to a dense 0..n-1 slot, for indexing a categorical palette. */
  rootSlots() {
    return this.cladeSlots(0);
  }

  /**
   * The ancestor this cell descends from at a given generation — generation 0
   * is the founder, 1 the first two branches of the tree, and so on. Cells that
   * have not yet reached that depth report themselves.
   *
   * Memoised per depth with path compression: colouring a 200k-cell frame by
   * subclone walks each chain once, not once per cell.
   */
  ancestorAtGeneration(id, depth) {
    if (depth <= 0) return this.rootOf(id);
    if (!this._ancestorCaches) this._ancestorCaches = new Map();
    let memo = this._ancestorCaches.get(depth);
    if (!memo) { memo = new Map(); this._ancestorCaches.set(depth, memo); }

    const cached = memo.get(id);
    if (cached !== undefined) return cached;

    const path = [];
    let cur = id;
    let answer;
    while (true) {
      const hit = memo.get(cur);
      if (hit !== undefined) { answer = hit; break; }
      if (this.generationOf(cur) <= depth) { answer = cur; break; }
      const parent = this.parentOf(cur);
      if (parent === NO_PARENT || !this.cells.has(parent)) { answer = cur; break; }
      path.push(cur);
      cur = parent;
      if (path.length > this.cells.size) { answer = cur; break; } // corrupt data: cycle
    }
    memo.set(cur, answer);
    for (const step of path) memo.set(step, answer);
    return answer;
  }

  /**
   * Stable palette slots for the subclones rooted at a given generation. Keyed
   * by ancestor ID in ascending order so a subclone keeps its colour as the
   * population grows.
   * @returns {Map<number, number>}
   */
  cladeSlots(depth = 0) {
    if (!this._cladeSlots) this._cladeSlots = new Map();
    const cached = this._cladeSlots.get(depth);
    if (cached && cached.version === this.version) return cached.slots;
    const ancestors = new Set();
    for (const id of this.cells.keys()) ancestors.add(this.ancestorAtGeneration(id, depth));
    const slots = new Map([...ancestors].sort((a, b) => a - b).map((id, i) => [id, i]));
    this._cladeSlots.set(depth, { version: this.version, slots });
    return slots;
  }

  maxGeneration() {
    let max = 0;
    for (const id of this.cells.keys()) max = Math.max(max, this.generationOf(id));
    return max;
  }

  /**
   * Lay the tree out for the dendrogram panel.
   *
   * Each cell is a horizontal span [birth, end]; children hang off it at their
   * own birth times. A cell's own row is allocated first so its span stays a
   * straight line, then each child's subtree gets the rows below it.
   *
   * @param {object} [options]
   * @param {Set<number>|null} [options.restrictTo] only lay out these cells and their ancestors
   * @param {number} [options.endTime] time to extend still-living cells to
   * @returns {{nodes: Array, rows: number, tMin: number, tMax: number}}
   */
  layout({ restrictTo = null, endTime = null } = {}) {
    let keep = null;
    if (restrictTo) {
      keep = new Set();
      for (const id of restrictTo) {
        keep.add(id);
        for (const a of this.ancestorsOf(id)) keep.add(a);
      }
    }

    const roots = this.roots().filter((id) => !keep || keep.has(id));
    const nodes = [];
    const byId = new Map();
    // Every cell gets exactly one row. This also stops a corrupt parent cycle
    // from walking forever.
    const placed = new Set();
    let row = 0;
    let tMin = Infinity;
    let tMax = -Infinity;

    // Iterative DFS; deep lineages would blow a recursive stack.
    for (const rootId of roots) {
      const stack = [{ id: rootId, phase: 0, depth: 0 }];
      while (stack.length) {
        const item = stack[stack.length - 1];
        const cell = this.cells.get(item.id);
        if (!cell || (item.phase === 0 && placed.has(item.id))) { stack.pop(); continue; }
        if (item.phase === 0) {
          placed.add(item.id);
          const birth = Number.isFinite(cell.birth) ? cell.birth : 0;
          // Cells known only from the division log have never been "seen"; their
          // span starts as a point and is stretched below to cover their children.
          const last = cell.lastSeen > -Infinity ? cell.lastSeen : birth;
          const node = {
            id: cell.id,
            parent: cell.parent,
            depth: item.depth,
            birth,
            end: Math.max(birth, last),
            row: row++,
            rowMin: 0,
            rowMax: 0,
            children: [],
          };
          node.rowMin = node.row;
          node.rowMax = node.row;
          nodes.push(node);
          byId.set(cell.id, node);
          tMin = Math.min(tMin, node.birth);
          tMax = Math.max(tMax, node.end);
          item.node = node;
          item.queue = cell.children
            .filter((c) => (!keep || keep.has(c)) && this.cells.has(c) && !placed.has(c))
            .sort((a, b) => {
              const ca = this.cells.get(a);
              const cb = this.cells.get(b);
              return (ca.birth || 0) - (cb.birth || 0) || a - b;
            });
          item.phase = 1;
        } else if (item.queue.length) {
          const childId = item.queue.shift();
          stack.push({ id: childId, phase: 0, depth: item.depth + 1 });
        } else {
          const node = item.node;
          for (const childId of this.cells.get(item.id).children) {
            const childNode = byId.get(childId);
            if (!childNode) continue;
            node.children.push(childId);
            node.rowMin = Math.min(node.rowMin, childNode.rowMin);
            node.rowMax = Math.max(node.rowMax, childNode.rowMax);
            // A parent that divides must live at least until its daughter is born.
            node.end = Math.max(node.end, childNode.birth);
          }
          stack.pop();
        }
      }
    }

    if (!nodes.length) return { nodes, byId, rows: 0, tMin: 0, tMax: 1 };
    if (endTime !== null) tMax = Math.max(tMax, endTime);
    return { nodes, byId, rows: row, tMin, tMax: tMax > tMin ? tMax : tMin + 1 };
  }
}
