/**
 * Cell-lineage dendrogram on a 2D canvas, drawn against the same store the 3D
 * view colours from. Time runs left to right; each cell is one horizontal span
 * from its birth to the last time it was seen, with a vertical connector down
 * to each daughter at the moment of division.
 *
 * Clicking a branch selects that cell in the 3D view, and vice versa.
 */

import { UI, cloneColor, rgbToHex } from '../render/colors.js';

const PADDING = { left: 12, right: 14, top: 10, bottom: 26 };
// Fitting a thousand-cell lineage into a short panel means sub-pixel rows. That
// still reads as a growth envelope, and shift+wheel zooms back into detail.
const MIN_ROW_HEIGHT = 0.25;

// Above this many tracked cells, coalesce relayouts so stepping frames stays smooth.
const LAYOUT_THROTTLE_ABOVE = 20000;
const LAYOUT_THROTTLE_MS = 400;

export class LineageTree {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../data/lineage.js').LineageStore} lineage
   */
  constructor(canvas, lineage) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.lineage = lineage;
    this.layout = null;
    this.layoutVersion = -1;
    this.selected = null;
    this.clade = null;
    this.currentTime = null;
    this.timeUnits = 'min';
    this.onSelect = null;
    this.restrictToClade = false;

    this.rowHeight = 6;
    this.scrollRow = 0;
    this.tMin = 0;
    this.tMax = 1;
    this.viewT0 = 0;
    this.viewT1 = 1;

    this._bindEvents();
    this._resizeObserver = new ResizeObserver(() => this.draw());
    this._resizeObserver.observe(canvas);
  }

  get width() { return this.canvas.clientWidth || 1; }
  get height() { return this.canvas.clientHeight || 1; }
  get plotWidth() { return Math.max(this.width - PADDING.left - PADDING.right, 1); }
  get plotHeight() { return Math.max(this.height - PADDING.top - PADDING.bottom, 1); }

  invalidate() { this.layoutVersion = -1; this.draw(); }

  setTime(time, units) {
    this.currentTime = time;
    this.timeUnits = units ?? this.timeUnits;
    this.draw();
  }

  setSelected(id) {
    this.selected = id ?? null;
    this._refreshClade();
    if (this.restrictToClade) this.layoutVersion = -1;
    this.scrollToSelected();
    this.draw();
  }

  /**
   * The clade grows as later frames are ingested, so the greyed-out mask has to
   * be recomputed rather than snapshotted at selection time.
   */
  _refreshClade() {
    if (this.selected === null) {
      this.clade = null;
      this._cladeVersion = -1;
      return;
    }
    if (this._cladeVersion === this.lineage.version) return;
    this.clade = this.lineage.cladeOf(this.selected);
    this._cladeVersion = this.lineage.version;
    if (this.restrictToClade) this.layoutVersion = -1;
  }

  setRestrictToClade(on) {
    this.restrictToClade = on;
    this.layoutVersion = -1;
    this.draw();
  }

  scrollToSelected() {
    if (this.selected === null || !this.layout) return;
    const node = this.layout.byId.get(this.selected);
    if (!node) return;
    const visibleRows = this.plotHeight / this.rowHeight;
    if (node.row < this.scrollRow || node.row > this.scrollRow + visibleRows) {
      this.scrollRow = Math.max(0, node.row - visibleRows / 2);
    }
  }

  /**
   * Rebuild the layout if the store moved on. Laying out a very large tree
   * costs ~100 ms, which would stutter playback, so a stale layout is kept and
   * refreshed on a timer instead of on every frame step.
   */
  _ensureLayout() {
    this._refreshClade();
    const wanted = this.lineage.version + (this.restrictToClade ? 0.5 : 0);
    if (this.layout && this.layoutVersion === wanted) return;
    if (this.layout && this.lineage.size > LAYOUT_THROTTLE_ABOVE) {
      const now = performance.now();
      if (now - (this._lastLayoutAt ?? 0) < LAYOUT_THROTTLE_MS) {
        if (!this._layoutTimer) {
          this._layoutTimer = setTimeout(() => {
            this._layoutTimer = null;
            this.draw();
          }, LAYOUT_THROTTLE_MS);
        }
        return;
      }
    }
    this._lastLayoutAt = performance.now();
    const restrictTo = this.restrictToClade && this.clade ? this.clade : null;
    this.layout = this.lineage.layout({ restrictTo });
    this.layoutVersion = wanted;
    if (this.tMax <= this.tMin || this.viewT1 <= this.viewT0) {
      this.tMin = this.layout.tMin;
      this.tMax = this.layout.tMax;
      this.viewT0 = this.tMin;
      this.viewT1 = this.tMax;
    } else {
      this.tMin = Math.min(this.tMin, this.layout.tMin);
      this.tMax = Math.max(this.tMax, this.layout.tMax);
      // Follow the growing time axis while the user has not zoomed in.
      if (Math.abs(this.viewT1 - this.tMax) > 1e-9 && this.viewT0 <= this.tMin + 1e-9) this.viewT1 = this.tMax;
    }
    this.scrollRow = Math.min(this.scrollRow, Math.max(0, this.layout.rows - this.plotHeight / this.rowHeight));
  }

  /** Fit the whole tree in the panel. */
  fit() {
    this._ensureLayout();
    if (!this.layout) return;
    this.viewT0 = this.layout.tMin;
    this.viewT1 = this.layout.tMax;
    this.rowHeight = Math.max(MIN_ROW_HEIGHT, Math.min(14, this.plotHeight / Math.max(this.layout.rows, 1)));
    this.scrollRow = 0;
    this.draw();
  }

  xOf(t) {
    return PADDING.left + ((t - this.viewT0) / (this.viewT1 - this.viewT0 || 1)) * this.plotWidth;
  }

  tOf(x) {
    return this.viewT0 + ((x - PADDING.left) / this.plotWidth) * (this.viewT1 - this.viewT0);
  }

  yOf(row) {
    return PADDING.top + (row - this.scrollRow) * this.rowHeight + this.rowHeight / 2;
  }

  rowOf(y) {
    return (y - PADDING.top - this.rowHeight / 2) / this.rowHeight + this.scrollRow;
  }

  draw() {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = this.width;
    const h = this.height;
    if (w <= 1 || h <= 1) return; // panel collapsed — nothing to lay out or paint
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = UI.surfaceSunken;
    ctx.fillRect(0, 0, w, h);

    this._ensureLayout();
    const layout = this.layout;
    if (!layout || !layout.nodes.length) {
      ctx.fillStyle = UI.textMuted;
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('No lineage recorded yet — load frames or a cell_lineage.csv.', PADDING.left, PADDING.top + 16);
      return;
    }

    this._drawTimeAxis(ctx, w, h);

    const slots = this.lineage.rootSlots();
    const firstRow = Math.floor(this.scrollRow) - 1;
    const lastRow = Math.ceil(this.scrollRow + this.plotHeight / this.rowHeight) + 1;
    const lineWidth = Math.max(1, Math.min(2, this.rowHeight * 0.4));

    ctx.save();
    ctx.beginPath();
    ctx.rect(PADDING.left - 2, PADDING.top, this.plotWidth + 4, this.plotHeight);
    ctx.clip();
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'butt';

    const hasClade = this.clade !== null;
    for (const node of layout.nodes) {
      const inRow = node.row >= firstRow && node.row <= lastRow;
      const spansRows = node.rowMin <= lastRow && node.rowMax >= firstRow;
      if (!inRow && !spansRows) continue;

      const inClade = !hasClade || this.clade.has(node.id);
      const colour = rgbToHex(cloneColor(slots.get(this.lineage.rootOf(node.id)) ?? 0));
      ctx.strokeStyle = inClade ? colour : 'rgba(120,120,124,0.28)';

      const y = this.yOf(node.row);
      if (inRow) {
        const x0 = this.xOf(node.birth);
        const x1 = this.xOf(node.end);
        if (x1 >= 0 && x0 <= w) {
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(Math.max(x1, x0 + 0.6), y);
          ctx.stroke();
        }
      }

      for (const childId of node.children) {
        const child = layout.byId.get(childId);
        if (!child) continue;
        const cy = this.yOf(child.row);
        if ((y < PADDING.top && cy < PADDING.top) || (y > h - PADDING.bottom && cy > h - PADDING.bottom)) continue;
        const cx = this.xOf(child.birth);
        if (cx < -2 || cx > w + 2) continue;
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.lineTo(cx, cy);
        ctx.stroke();
      }
    }

    if (this.selected !== null) {
      const node = layout.byId.get(this.selected);
      if (node) {
        const y = this.yOf(node.row);
        ctx.strokeStyle = UI.selection;
        ctx.lineWidth = Math.max(2, lineWidth + 1.5);
        ctx.beginPath();
        ctx.moveTo(this.xOf(node.birth), y);
        ctx.lineTo(Math.max(this.xOf(node.end), this.xOf(node.birth) + 1), y);
        ctx.stroke();
        ctx.fillStyle = UI.selection;
        ctx.beginPath();
        ctx.arc(this.xOf(node.birth), y, Math.max(2.2, lineWidth), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    if (this.currentTime !== null) {
      const x = this.xOf(this.currentTime);
      if (x >= PADDING.left - 1 && x <= w - PADDING.right + 1) {
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, PADDING.top - 4);
        ctx.lineTo(x, h - PADDING.bottom + 2);
        ctx.stroke();
      }
    }

    ctx.fillStyle = UI.textMuted;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    const shown = this.restrictToClade && this.clade ? `${layout.rows} in clade` : `${layout.rows} cells`;
    ctx.fillText(shown, PADDING.left, h - 8);
  }

  _drawTimeAxis(ctx, w, h) {
    const y = h - PADDING.bottom;
    ctx.strokeStyle = UI.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PADDING.left, y + 0.5);
    ctx.lineTo(w - PADDING.right, y + 0.5);
    ctx.stroke();

    const span = this.viewT1 - this.viewT0;
    const target = Math.max(2, Math.floor(this.plotWidth / 90));
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
    const start = Math.ceil(this.viewT0 / step) * step;

    ctx.fillStyle = UI.textMuted;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    for (let t = start; t <= this.viewT1 + 1e-9; t += step) {
      const x = this.xOf(t);
      if (x < PADDING.left - 1 || x > w - PADDING.right + 1) continue;
      ctx.strokeStyle = 'rgba(0,0,0,0.05)';
      ctx.beginPath();
      ctx.moveTo(x, PADDING.top);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.strokeStyle = UI.border;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 4);
      ctx.stroke();
      ctx.fillText(formatTick(t, step), x, y + 15);
    }
    ctx.textAlign = 'right';
    ctx.fillText(this.timeUnits, w - PADDING.right, h - 8);
    ctx.textAlign = 'left';
  }

  /** @returns {number|null} cell ID under the pointer */
  hitTest(px, py) {
    if (!this.layout) return null;
    const row = Math.round(this.rowOf(py));
    const t = this.tOf(px);
    const tolerance = (this.viewT1 - this.viewT0) * (6 / this.plotWidth);
    let best = null;
    for (const node of this.layout.nodes) {
      if (node.row !== row) continue;
      if (t >= node.birth - tolerance && t <= node.end + tolerance) return node.id;
      best = best ?? node.id;
    }
    return best;
  }

  _bindEvents() {
    const canvas = this.canvas;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = 0;
      lastX = e.offsetX;
      lastY = e.offsetY;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.offsetX - lastX;
      const dy = e.offsetY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      const span = this.viewT1 - this.viewT0;
      const dt = (dx / this.plotWidth) * span;
      this.viewT0 -= dt;
      this.viewT1 -= dt;
      this.scrollRow = Math.max(0, Math.min(
        this.scrollRow - dy / this.rowHeight,
        Math.max(0, (this.layout?.rows ?? 0) - this.plotHeight / this.rowHeight),
      ));
      lastX = e.offsetX;
      lastY = e.offsetY;
      this.draw();
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      canvas.releasePointerCapture?.(e.pointerId);
      if (moved < 4) {
        const id = this.hitTest(e.offsetX, e.offsetY);
        if (id !== null) this.onSelect?.(id);
      }
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      if (e.shiftKey) {
        const before = this.rowOf(e.offsetY);
        this.rowHeight = Math.max(MIN_ROW_HEIGHT, Math.min(28, this.rowHeight * factor));
        // Inverting rowOf, which offsets by half a row.
        this.scrollRow = Math.max(0, before - (e.offsetY - PADDING.top) / this.rowHeight + 0.5);
      } else {
        const anchor = this.tOf(e.offsetX);
        this.viewT0 = anchor - (anchor - this.viewT0) / factor;
        this.viewT1 = anchor + (this.viewT1 - anchor) / factor;
      }
      this.draw();
    }, { passive: false });

    canvas.addEventListener('dblclick', () => this.fit());
  }

  /** Drop the layout so a newly loaded dataset cannot redraw the old tree. */
  reset() {
    this.layout = null;
    this.layoutVersion = -1;
    this._cladeVersion = -1;
    this.clade = null;
    this.selected = null;
    this.scrollRow = 0;
    this.tMin = 0;
    this.tMax = 1;
    this.viewT0 = 0;
    this.viewT1 = 1;
  }

  dispose() {
    this._resizeObserver.disconnect();
    clearTimeout(this._layoutTimer);
    this._layoutTimer = null;
  }
}

function formatTick(value, step) {
  const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  return value.toFixed(decimals);
}
