# PhysiCell 3D viewer

A browser viewer for PhysiCell output, built on three.js. It reads a run's
`output/` folder directly — the MultiCellDS `output*.xml` snapshots and their
`_cells.mat` companions — and draws every cell as a shaded sphere you can orbit,
cut open, scrub through time, and interrogate.

It is built for the lineage-tracking fork in this repository: alongside the
usual cell type / cycle phase / measurement colouring, it understands the
`parent_ID` and `birth_time` columns and the `cell_lineage.csv` division log,
and links the 3D view to a lineage tree.

No build step, no npm install, no CDN. Open it and it runs.

---

## Running it

```bash
python3 viz/serve.py
```

That serves the repository on <http://localhost:8000/viz/> and opens it. The
viewer loads `../output/` by default, which is where PhysiCell writes unless you
changed `<save><folder>` in your settings XML.

Other ways in:

| You want to | Do this |
|---|---|
| View a run somewhere else on disk | `python3 viz/serve.py -d /path/to/run` |
| View a folder without a server | Click **Open output folder** and pick it, or drag it onto the window |
| Point at any URL | Type it in the address box and press **Load** |
| Preselect a directory | `…/viz/?dir=/some/served/path/` |

A server is needed for the default path only because browsers refuse ES modules
and `fetch()` over `file://`. Files opened through the picker or by drag-and-drop
are read locally and never leave the browser.

## What it reads

| File | Used for |
|---|---|
| `output########.xml` | frame time, mesh bounds, substrate list, cell type names, and the label schema that names the columns of the matrix |
| `output########_cells.mat` | the cells themselves (MATLAB level-4, one column per cell) |
| `output########_microenvironment0.mat` | optional substrate slice |
| `cell_lineage.csv` | optional; the full division log, including cells that died before any snapshot |

Everything except the first two is optional. Runs made before the lineage patch
work fine — the lineage controls just stay empty.

## Controls

**Orbit** with the left mouse button, **pan** with the right button or two
fingers, **zoom** with the wheel. Click a cell to select it.

| Key | |
|---|---|
| `Space` | play / pause |
| `←` `→` | step one frame |
| `Home` `End` | first / last frame |
| `F` | fit the camera to the visible cells |
| `R` | reset the camera to the whole domain |
| `C` | toggle the section plane |
| `L` | collapse the lineage tree |
| `Esc` | clear the selection |

### Colour

Pick what colour means from the **Encode** menu:

- **Identity** — cell type, cycle phase, live/dead. Fixed categorical palette;
  a type keeps its colour as you filter. Click a legend row to hide that group.
- **Lineage** — clone, generation, birth time, age since birth.
- **Measurements** — every numeric column the run wrote, from `pressure` and
  `oxygen` to custom variables, on a perceptual ramp with an explicit range.
  Lock the range to compare frames on the same scale.

**Clone / subclone** deserves a note. At *split at generation 0* it colours by
founder, which is one colour if the run started from a single cell. Raise the
generation and it colours by which ancestor at that depth each cell descends
from — that is what shows you whether early daughters stayed spatially
coherent or intermixed.

### Section plane

Tick **Cut the population open** to slice the spheroid on X, Y, Z, or the
camera-facing plane. With **Show cut faces** on, cells crossing the plane are
capped with a flat face, so you get a real cross-section rather than a hollow
shell. The cut is done in the fragment shader, so it costs nothing.

### Lineage

Select a cell and the sidebar reports its ID, parent, birth time, branch length
(the interval between its own birth and its parent's), generation, founder,
daughter count and clade size. In the 3D view its clade lights up and everything
else dims; tick **Hide everything else** to isolate it completely.

**Draw lines to parents** overlays the lineage as a graph in space: one segment
from each cell to its parent, coloured by whichever encoding is active, so a
clone's internal connectivity is visible directly. Because PhysiCell keeps the
mother's ID through a division, nearly every link resolves within a single
frame. Two settings matter:

- *Show* — every cell, or only the selected clade. On a packed spheroid the
  full graph is a hairball; scoping to a clade is usually what you want.
- *Draw over the cells* — on by default, because inside a dense population the
  depth-correct lines are entirely hidden behind the spheres. Untick it for
  true occlusion, and drop **Size** to around 0.3× to see the graph threaded
  through the population.

*Reach parents that have died* extends links to a parent's last known position.
That position is only known for frames the viewer has actually loaded, so play
through the run once before relying on it.

The panel at the bottom is the lineage tree: time runs left to right, each cell
is one horizontal span from birth to the last frame it appears in, and a
vertical connector drops to each daughter at the moment of division. Because
PhysiCell keeps the mother's ID through a division, a cell is one continuous
line that sprouts branches rather than a node that disappears at each split.
Drag to pan, wheel to zoom time, shift+wheel to zoom rows, double-click to fit.
Clicking a branch selects that cell in 3D, and vice versa.

### Screenshots

Two buttons in the top bar save the current view, on its white background:

- **Screenshot** — a PNG of the 3D canvas at its on-screen resolution.
- **SVG** — a vector rebuild of the same view: every visible cell as a
  depth-sorted shaded circle, plus the domain box and the parent-link graph
  when they are shown. Colours, depth cueing, dimming and the selection
  outline match the canvas. Being vector, it scales to any print size and
  opens in Illustrator/Inkscape with each cell as an editable element.

The SVG is a reconstruction, not a pixel capture, so a few things differ from
the canvas: the section plane keeps or drops whole cells by their centre
rather than slicing them (no cut faces), overlapping cells resolve by centre
depth rather than per pixel, and the substrate slice, floor grid and axis
gizmo are not included.

## Scripting

The viewer exposes itself on `window.pc`:

```js
pc.setFrame(20);                       // jump to a frame
pc.state.colorMode = 'scalar:oxygen';  // change the encoding
pc.refreshColors();
pc.selectCell(413);                    // select by cell ID
pc.frame.column('pressure');           // Float32Array over the current frame
pc.lineage.cladeOf(413);               // Set of IDs
pc.lineage.layout();                   // the tree, as data
```

## Tests

```bash
cd viz && npm test        # or: node --test
```

Covers the DOM-free half — the MATLAB reader, the lineage store (including
the out-of-order frame loading that scrubbing straight to the last frame
produces) and the SVG exporter's projection, ordering and colour handling.
The WebGL renderer and UI are not covered; there is no npm install step and
no dependency to fetch.

## How it is put together

```
viz/
  index.html            markup and the import map
  serve.py              static file server (stdlib only)
  package.json          no dependencies; just "type": "module" and the test script
  test/data.test.mjs    node --test coverage of the DOM-free data code
  test/svg.test.mjs     node --test coverage of the SVG exporter
  vendor/three/         three.js r185, ES modules, vendored
  src/
    main.js             application shell: state, events, wiring
    data/
      mat4.js           MATLAB level-4 reader
      multicellds.js    MultiCellDS XML → mesh, substrates, cell types, label schema
      source.js         HTTP directory or local folder, behind one interface
      dataset.js        frame discovery, lazy loading, byte-budgeted LRU cache
      lineage.js        parent/child store, generations, clades, tree layout
    render/
      viewer.js         renderer, camera, orbit controls, helpers, axis gizmo
      cellSpheres.js    instanced impostor spheres — the main renderer
      coloring.js       colour modes and the legend they produce
      colors.js         palettes and ramps
      picking.js        analytic ray-sphere hit testing
      links.js          parent-link line graph
      substrate.js      microenvironment slice plane
      svgExport.js      vector (SVG) screenshot of the current view
    ui/
      lineageTree.js    the dendrogram panel
      style.css
```

Cells are drawn as **impostor spheres**: one instanced quad each, with the
sphere solved analytically in the fragment shader and written to the depth
buffer. The whole population is a single draw call with no triangle budget, so
spheres stay perfectly round at any zoom and the cost scales with pixels rather
than cell count. Picking mirrors the same intersection on the CPU so clicks land
on what you see, section plane included.

Measured in headless Chrome on an M-series Mac, with a synthetic 200,000-cell
dataset in the real file format:

| | |
|---|---|
| Sustained render, 200k cells | 120 fps |
| Load and display one 142 MB frame | ~370 ms |
| Recolour 200k cells by a measurement | ~15 ms |
| Recolour 200k cells by subclone | ~105 ms |

## Limits

- The frame cache holds 512 MB of cell matrices; beyond that the oldest frames
  are dropped and reloaded on demand. Change `cacheBudget` in `dataset.js`.
- Folders opened locally are flattened to base names, so two subdirectories
  containing identically named files will collide.
- Sphere silhouettes are hard-edged. On a non-retina display, **Supersample**
  under *View* trades frame rate for cleaner edges.
- The lineage tree lays out every tracked cell. Above ~20,000 it coalesces
  relayouts to keep playback smooth; **Tree shows clade only** is the way to
  read detail in a large run.
