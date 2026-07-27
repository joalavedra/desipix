import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// Tile cartogram allocator.
//
// The pipeline is:
//   1. project + rasterize real geography into a square-tile land mask
//   2. fill enclosed holes so interior borders never show through
//   3. resize each connected component to exactly its tile budget by peeling
//      or growing its OUTER boundary
//   4. hand every cell to a region by capacitated region growing from each
//      region's geographic seed
//   5. repair any region left short, then relax for compactness
//
// Step 4 is what makes it a cartogram: a region's tile count is set by its
// data value, not by its area, so a small dense region (Barcelonès holds 29%
// of Catalonia's population in 146 km²) grows to its true share.

// ----- Projections -----

export function spainProjection(
  geojson,
  width,
  height,
  include = () => true,
  shareOf = null
) {
  const main = d3.geoMercator();
  const can = d3.geoMercator();

  const idOf = (f) => f.properties.id ?? f.properties.cod_ccaa;
  const drawn = geojson.features.filter((f) => include(idOf(f)));
  const pool = drawn.length ? drawn : geojson.features;
  const isCanaries = (f) => d3.geoBounds(f)[0][0] <= -10;
  const mainlandFC = { type: "FeatureCollection", features: pool.filter((f) => !isCanaries(f)) };
  const canariasFC = { type: "FeatureCollection", features: pool.filter(isCanaries) };

  // An inset is a fixed viewport but a cartogram needs area in proportion to
  // the data, so the box is sized from the Canaries' share of the weight.
  // With a fixed box, tourism (20% of Spain's nights) could not fit: the
  // islands grew until they blocked each other and 48 tiles were dropped.
  const share = shareOf
    ? canariasFC.features.reduce((sum, f) => sum + (shareOf(idOf(f)) || 0), 0)
    : 0.05;
  const usable = (width - 22) * (height - 96);
  const area = clampRange(share * usable * 1.35, usable * 0.04, usable * 0.26);
  const aspect = 1.7; // the archipelago is much wider than it is tall
  const insetW = clampRange(Math.sqrt(area * aspect), width * 0.2, width * 0.56);
  const insetH = clampRange(area / insetW, height * 0.1, height * 0.3);

  // The box sits in a reserved band at the bottom, clear of the footnote, and
  // the mainland fits above it. Sizing the box without reserving the band let
  // the Canaries overlap Andalusia once tourism made the inset large.
  const box = [
    [12, height - insetH - 34],
    [12 + insetW, height - 34],
  ];
  can.fitExtent(box, canariasFC);
  main.fitExtent([[10, 62], [width - 10, height - insetH - 60]], mainlandFC);

  const project = (lonLat) => (lonLat[0] < -10 ? can(lonLat) : main(lonLat));
  project.insets = [{ box, label: "Canàries" }];
  return { project };
}

const clampRange = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Iceland sits far off the shelf and Cyprus far to the east. Fitting the
// extent over both squeezes the populated core into the middle of the canvas,
// so they get insets and the main projection fits the mainland.
const EUROPE_INSETS = [
  { corner: "topleft", label: "Islàndia", test: (id) => id.startsWith("IS") },
  {
    corner: "bottomright",
    label: "Xipre i Malta",
    test: (id) => id.startsWith("CY") || id.startsWith("MT"),
  },
];

export function europeProjection(geojson, width, height, include = () => true) {
  const isInset = (f) =>
    EUROPE_INSETS.findIndex((spec) => spec.test(f.properties.id || ""));

  // Fit to the regions actually being drawn. Fitting to all of NUTS-2 wastes
  // the top third of the canvas on sparsely populated Arctic regions and on
  // the UK, which has had no Eurostat data since 2020.
  const drawn = geojson.features.filter((f) => include(f.properties.id));
  const pool = drawn.length > 8 ? drawn : geojson.features;
  const mainFC = {
    type: "FeatureCollection",
    features: pool.filter((f) => isInset(f) === -1),
  };

  const main = d3.geoAzimuthalEqualArea().rotate([-15, -54]).precision(0.1);
  main.fitExtent([[10, 62], [width - 10, height - 14]], mainFC);

  // Iceland, Cyprus and Malta together hold under 1% of the population on
  // this map. A large inset box would give a handful of tiles the visual
  // weight of a country, so the boxes stay small.
  const insetW = width * 0.06;
  const insetH = height * 0.07;
  const boxes = {
    topleft: [[14, 66], [14 + insetW, 66 + insetH]],
    bottomright: [
      [width - 14 - insetW, height - 30 - insetH],
      [width - 14, height - 30],
    ],
  };

  const insetProjections = EUROPE_INSETS.map((spec) => {
    const features = geojson.features.filter((f) => spec.test(f.properties.id || ""));
    if (features.length === 0) return null;
    const p = d3.geoAzimuthalEqualArea().precision(0.1);
    p.fitExtent(boxes[spec.corner], { type: "FeatureCollection", features });
    return p;
  });

  // Insets are keyed by region id, so callers pass the id alongside the
  // coordinate. Callers that only have a coordinate get the main projection,
  // which is correct for every non-inset region.
  const project = (lonLat, regionId) => {
    if (regionId) {
      const i = EUROPE_INSETS.findIndex((spec) => spec.test(regionId));
      if (i !== -1 && insetProjections[i]) return insetProjections[i](lonLat);
    }
    return main(lonLat);
  };
  project.insets = EUROPE_INSETS.map((spec, i) =>
    insetProjections[i] ? { box: boxes[spec.corner], label: spec.label } : null
  ).filter(Boolean);
  return { project };
}

export function cataloniaProjection(geojson, width, height, include = () => true) {
  const drawn = geojson.features.filter((f) => include(f.properties.id));
  const proj = d3.geoMercator();
  proj.fitExtent(
    [[10, 62], [width - 10, height - 30]],
    { type: "FeatureCollection", features: drawn.length ? drawn : geojson.features }
  );
  return { project: (lonLat) => proj(lonLat) };
}

// ----- Geometry helpers -----

function projectGeometry(geom, project, regionId) {
  const result = [];
  const projectRing = (ring) =>
    ring
      .map((c) => project(c, regionId))
      .filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
  if (geom.type === "Polygon") {
    const projected = geom.coordinates.map(projectRing);
    if (projected[0] && projected[0].length >= 3) result.push(projected);
  } else if (geom.type === "MultiPolygon") {
    for (const poly of geom.coordinates) {
      const projected = poly.map(projectRing);
      if (projected[0] && projected[0].length >= 3) result.push(projected);
    }
  }
  return result;
}

function pointInPolygon([x, y], vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const [xi, yi] = vs[i];
    const [xj, yj] = vs[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

function ringCentroid(ring) {
  let sx = 0;
  let sy = 0;
  for (const p of ring) {
    sx += p[0];
    sy += p[1];
  }
  return { x: sx / ring.length, y: sy / ring.length };
}

// ----- Binary min-heap keyed by numeric cost -----

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(cost, payload) {
    const a = this.items;
    a.push({ cost, payload });
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent].cost <= a[i].cost) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop() {
    const a = this.items;
    if (a.length === 0) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let small = i;
        if (l < a.length && a[l].cost < a[small].cost) small = l;
        if (r < a.length && a[r].cost < a[small].cost) small = r;
        if (small === i) break;
        [a[small], a[i]] = [a[i], a[small]];
        i = small;
      }
    }
    return top.payload;
  }
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const key = (col, row) => `${col},${row}`;

// ----- Main builder -----

/**
 * Build a tile cartogram.
 *
 * @param {object} opts
 * @param {object} opts.geojson FeatureCollection of the geography.
 * @param {object} opts.values Region id → weight driving the tile counts.
 * @param {string} opts.regionKey Feature property holding the region id.
 * @param {number} opts.totalTiles Tile budget for the whole map.
 * @param {number} opts.width Canvas width in px.
 * @param {number} opts.height Canvas height in px.
 * @param {Function} opts.projection Projection factory.
 * @returns {{cells: object[], tileSide: number, tileValue: number,
 *   targets: object, allocationError: object}}
 */
export function buildCartogram({
  geojson,
  values,
  regionKey,
  totalTiles,
  width,
  height,
  projection,
}) {
  const positive = {};
  for (const [id, v] of Object.entries(values)) {
    if (Number.isFinite(v) && v > 0) positive[id] = v;
  }
  const totalValue = Object.values(positive).reduce((a, b) => a + b, 0);
  if (totalValue <= 0) {
    return { cells: [], tileSide: 1, tileValue: 0, targets: {}, allocationError: {} };
  }

  const targets = largestRemainder(positive, totalTiles);
  const tileValue = totalValue / totalTiles;
  const { project } = projection(
    geojson,
    width,
    height,
    (id) => positive[id] > 0,
    (id) => (positive[id] || 0) / totalValue
  );

  const projected = geojson.features.map((f) => {
    const regionId = f.properties[regionKey];
    return { regionId, polys: projectGeometry(f.geometry, project, regionId) };
  });

  const tileSide = Math.sqrt(landArea(projected) / totalTiles);
  const { grid, x0, y0 } = rasterize(projected, tileSide);

  fillEnclosedHoles(grid, x0, y0, tileSide);

  const seeds = regionSeeds(projected, targets);
  const comps = components(grid);
  const placement = regionPlacement(comps, targets, seeds);

  comps.forEach((component, index) => {
    const budget = componentBudget(index, placement, targets);
    if (budget.total === 0) {
      for (const cell of component) grid.delete(key(cell.col, cell.row));
      return;
    }
    resizeComponent(component, grid, budget.total, x0, y0, tileSide);
    allocate(component, budget.targets, seeds);
    relax(component, budget.targets, seeds);
  });

  const cells = [...grid.values()].filter((c) => c.regionId !== null);
  return {
    cells,
    tileSide,
    tileValue,
    targets,
    allocationError: measureError(cells, targets),
  };
}

/**
 * Apportion `total` tiles across regions proportionally. Largest-remainder
 * keeps the sum exact, so no downstream rebalancing is needed.
 */
function largestRemainder(values, total) {
  const ids = Object.keys(values);
  const sum = Object.values(values).reduce((a, b) => a + b, 0);
  if (sum <= 0 || ids.length === 0) return {};

  const exact = ids.map((id) => (values[id] / sum) * total);
  const floors = exact.map(Math.floor);
  let remaining = total - floors.reduce((a, b) => a + b, 0);

  const order = ids
    .map((_, i) => ({ i, frac: exact[i] - floors[i] }))
    .sort((a, b) => b.frac - a.frac);

  const out = {};
  ids.forEach((id, i) => (out[id] = floors[i]));
  for (let k = 0; k < order.length && remaining > 0; k++, remaining--) {
    out[ids[order[k].i]]++;
  }
  return out;
}

function landArea(projected) {
  let total = 0;
  for (const { polys } of projected) {
    for (const poly of polys) {
      total += ringArea(poly[0]);
      for (let i = 1; i < poly.length; i++) total -= ringArea(poly[i]);
    }
  }
  return total;
}

function rasterize(projected, tileSide) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { polys } of projected) {
    for (const poly of polys) {
      for (const p of poly[0]) {
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
    }
  }
  const pad = tileSide * 2;
  x0 -= pad;
  y0 -= pad;
  const cols = Math.ceil((x1 + pad - x0) / tileSide);
  const rows = Math.ceil((y1 + pad - y0) / tileSide);

  const grid = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = x0 + (col + 0.5) * tileSide;
      const y = y0 + (row + 0.5) * tileSide;
      const regionId = findRegion(x, y, projected);
      if (regionId !== null) {
        grid.set(key(col, row), { col, row, x, y, regionId, seedRegion: regionId });
      }
    }
  }
  return { grid, x0, y0 };
}

function findRegion(x, y, projected) {
  for (const { regionId, polys } of projected) {
    for (const poly of polys) {
      if (!pointInPolygon([x, y], poly[0])) continue;
      let inHole = false;
      for (let i = 1; i < poly.length; i++) {
        if (pointInPolygon([x, y], poly[i])) {
          inHole = true;
          break;
        }
      }
      if (!inHole) return regionId;
    }
  }
  return null;
}

/**
 * Flood-fill empty space inward from outside the bounding box. Anything the
 * fill cannot reach is enclosed by land, so it is a rasterization pinhole
 * rather than sea, and gets filled with its majority neighbour.
 *
 * This is what stops interior borders from opening white gaps between
 * neighbouring regions, and it never bridges open water, because open water
 * is reachable from outside.
 */
function fillEnclosedHoles(grid, x0, y0, tileSide) {
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const c of grid.values()) {
    if (c.col < minCol) minCol = c.col;
    if (c.col > maxCol) maxCol = c.col;
    if (c.row < minRow) minRow = c.row;
    if (c.row > maxRow) maxRow = c.row;
  }
  if (minCol === Infinity) return;

  const lo = { col: minCol - 1, row: minRow - 1 };
  const hi = { col: maxCol + 1, row: maxRow + 1 };
  const sea = new Set([key(lo.col, lo.row)]);
  const stack = [lo];

  while (stack.length) {
    const { col, row } = stack.pop();
    for (const [dc, dr] of NEIGHBOURS) {
      const c = col + dc;
      const r = row + dr;
      if (c < lo.col || c > hi.col || r < lo.row || r > hi.row) continue;
      const k = key(c, r);
      if (sea.has(k) || grid.has(k)) continue;
      sea.add(k);
      stack.push({ col: c, row: r });
    }
  }

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const k = key(col, row);
      if (grid.has(k) || sea.has(k)) continue;
      const tally = {};
      for (const [dc, dr] of NEIGHBOURS) {
        const n = grid.get(key(col + dc, row + dr));
        if (n) tally[n.regionId] = (tally[n.regionId] || 0) + 1;
      }
      const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      if (!winner) continue;
      grid.set(k, {
        col,
        row,
        x: x0 + (col + 0.5) * tileSide,
        y: y0 + (row + 0.5) * tileSide,
        regionId: winner[0],
        seedRegion: winner[0],
      });
    }
  }
}

function components(grid) {
  const seen = new Set();
  const out = [];
  for (const start of grid.values()) {
    const k0 = key(start.col, start.row);
    if (seen.has(k0)) continue;
    const comp = [];
    const stack = [start];
    seen.add(k0);
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      for (const [dc, dr] of NEIGHBOURS) {
        const k = key(c.col + dc, c.row + dr);
        if (seen.has(k)) continue;
        const nb = grid.get(k);
        if (!nb) continue;
        seen.add(k);
        stack.push(nb);
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Work out how much of each region's tile target belongs to each connected
 * component, as a share of where its geography actually falls. Keeps
 * archipelagos such as the Balearics sized correctly per island.
 *
 * Regions smaller than one tile rasterize to nothing — Brussels, Berlin and
 * Praha are all NUTS-2 enclaves under 900 km². They still own a real share of
 * the data, so each is pinned to the component nearest its seed rather than
 * being silently dropped.
 *
 * @returns {Map<string, Map<number, number>>} region → component index → weight
 */
function regionPlacement(comps, targets, seeds) {
  const placement = new Map();
  comps.forEach((component, index) => {
    for (const cell of component) {
      if (!cell.seedRegion) continue;
      const byComponent = placement.get(cell.seedRegion) || new Map();
      byComponent.set(index, (byComponent.get(index) || 0) + 1);
      placement.set(cell.seedRegion, byComponent);
    }
  });

  for (const region of Object.keys(targets)) {
    if (targets[region] <= 0 || placement.has(region)) continue;
    const seed = seeds[region];
    if (!seed) continue;
    let bestIndex = -1;
    let bestD = Infinity;
    comps.forEach((component, index) => {
      const near = nearestCell(component, seed);
      if (!near) return;
      const d = (near.x - seed.x) ** 2 + (near.y - seed.y) ** 2;
      if (d < bestD) {
        bestD = d;
        bestIndex = index;
      }
    });
    if (bestIndex !== -1) placement.set(region, new Map([[bestIndex, 1]]));
  }
  return placement;
}

function componentBudget(index, placement, targets) {
  const share = {};
  for (const [region, byComponent] of placement) {
    const here = byComponent.get(index);
    if (!here) continue;
    const target = targets[region] || 0;
    if (target === 0) continue;
    let everywhere = 0;
    for (const n of byComponent.values()) everywhere += n;
    share[region] = (target * here) / everywhere;
  }
  const total = Math.round(Object.values(share).reduce((a, b) => a + b, 0));
  if (total === 0) return { targets: {}, total: 0 };
  return { targets: largestRemainder(share, total), total };
}

/**
 * Bring a component to exactly `target` cells by working its outer boundary:
 * peel the most peninsular cells when it is too big, fill the deepest
 * concavities when it is too small. Interior cells are never touched, so
 * resizing cannot punch holes.
 */
function resizeComponent(component, grid, target, x0, y0, tileSide) {
  const exposure = (col, row) =>
    NEIGHBOURS.reduce((n, [dc, dr]) => n + (grid.has(key(col + dc, row + dr)) ? 1 : 0), 0);

  while (component.length > target) {
    let worst = null;
    let worstIndex = -1;
    let worstScore = Infinity;
    for (let i = 0; i < component.length; i++) {
      const c = component[i];
      const score = exposure(c.col, c.row);
      if (score >= 4) continue; // interior — never peel
      if (score < worstScore) {
        worstScore = score;
        worst = c;
        worstIndex = i;
      }
    }
    if (!worst) break;
    grid.delete(key(worst.col, worst.row));
    component.splice(worstIndex, 1);
  }

  while (component.length < target) {
    const candidates = new Map();
    for (const c of component) {
      for (const [dc, dr] of NEIGHBOURS) {
        const col = c.col + dc;
        const row = c.row + dr;
        const k = key(col, row);
        if (grid.has(k) || candidates.has(k)) continue;
        candidates.set(k, { col, row, fill: exposure(col, row) });
      }
    }
    if (candidates.size === 0) break;
    const ranked = [...candidates.values()].sort((a, b) => b.fill - a.fill);
    const room = Math.min(ranked.length, target - component.length);
    for (let i = 0; i < room; i++) {
      const { col, row } = ranked[i];
      const cell = {
        col,
        row,
        x: x0 + (col + 0.5) * tileSide,
        y: y0 + (row + 0.5) * tileSide,
        regionId: null,
        seedRegion: null,
      };
      grid.set(key(col, row), cell);
      component.push(cell);
    }
  }
}

/** Anchor each region at the centroid of its largest projected polygon. */
function regionSeeds(projected, targets) {
  const seeds = {};
  for (const { regionId, polys } of projected) {
    if (!targets[regionId]) continue;
    let best = null;
    let bestArea = -1;
    for (const poly of polys) {
      const area = ringArea(poly[0]);
      if (area > bestArea) {
        bestArea = area;
        best = poly[0];
      }
    }
    if (best) seeds[regionId] = ringCentroid(best);
  }
  return seeds;
}

/**
 * Capacitated region growing.
 *
 * Every region expands outward from its seed, cheapest cell first across the
 * whole map, and stops the moment it reaches its tile target. The capacity
 * stop is what makes counts exact, and it is also what lets a small dense
 * region reach its share: its neighbours fill up and drop out of the race,
 * freeing the space it needs.
 *
 * Distance is deliberately unweighted. Scaling cost by 1/sqrt(target) also
 * hits the right sizes, but produces multiplicatively-weighted Voronoi cells,
 * which are not convex — measured compactness on the Catalan map was 2.29x a
 * disc of equal area, against 1.34x here.
 */
function allocate(component, targets, seeds) {
  const cellAt = new Map();
  for (const c of component) {
    cellAt.set(key(c.col, c.row), c);
    c.regionId = null;
  }

  const counts = {};
  const heap = new MinHeap();

  // Every region needs its own start cell. Two seeds can round to the same
  // cell on a coarse grid — common around Barcelona, where several comarques
  // sit within one tile of each other. Sharing a start would leave the loser
  // with no queue entry at all, so it would never grow and would be rebuilt
  // from wherever the repair pass happened to look first.
  const taken = new Set();
  const bySize = Object.entries(targets)
    .filter(([, target]) => target > 0)
    .sort((a, b) => b[1] - a[1]);

  for (const [region] of bySize) {
    counts[region] = 0;
    const seed = seeds[region];
    const start = seed ? nearestFreeCell(component, seed, taken) : null;
    if (!start) continue;
    taken.add(start);
    heap.push(0, { cell: start, region });
  }

  while (heap.size > 0) {
    const { cell, region } = heap.pop();
    if (cell.regionId !== null) continue;
    if (counts[region] >= targets[region]) continue;

    cell.regionId = region;
    counts[region]++;
    if (counts[region] >= targets[region]) continue;

    const seed = seeds[region] || cell;
    for (const [dc, dr] of NEIGHBOURS) {
      const nb = cellAt.get(key(cell.col + dc, cell.row + dr));
      if (!nb || nb.regionId !== null) continue;
      heap.push(Math.hypot(nb.x - seed.x, nb.y - seed.y), { cell: nb, region });
    }
  }

  claimLeftovers(component, cellAt, counts, targets);
  repairShortfalls(component, cellAt, counts, targets, seeds);
  defragment(component, cellAt);
}

/** Group a region's cells into 4-connected blobs. */
function blobsOf(cells, cellAt, region) {
  const owned = new Set();
  for (const c of cells) if (c.regionId === region) owned.add(key(c.col, c.row));

  const seen = new Set();
  const blobs = [];
  for (const c of cells) {
    if (c.regionId !== region) continue;
    const k0 = key(c.col, c.row);
    if (seen.has(k0)) continue;
    const blob = [];
    const stack = [c];
    seen.add(k0);
    while (stack.length) {
      const q = stack.pop();
      blob.push(q);
      for (const [dc, dr] of NEIGHBOURS) {
        const k = key(q.col + dc, q.row + dr);
        if (!owned.has(k) || seen.has(k)) continue;
        seen.add(k);
        stack.push(cellAt.get(k));
      }
    }
    blobs.push(blob);
  }
  return blobs;
}

/**
 * Trade small detached fragments back into whichever region surrounds them,
 * taking an equivalent cell next to the region's main blob in exchange.
 *
 * Swapping in pairs keeps every count exact, so this cannot undo the
 * balancing above. It runs because handing a cell across a border during
 * repair can nip off a piece of the donor: without this, 19 of 240 Europe
 * regions ended up in more than one blob, including landlocked ones like
 * Köln and Stuttgart where a stray fragment reads as a rendering error.
 * Genuine archipelagos are left alone — they sit in separate components and
 * never meet here.
 */
const MAX_FRAGMENT = 8;

function defragment(component, cellAt) {
  for (let pass = 0; pass < 3; pass++) {
    let swaps = 0;
    const regions = new Set(component.map((c) => c.regionId).filter(Boolean));

    for (const region of regions) {
      const blobs = blobsOf(component, cellAt, region);
      if (blobs.length < 2) continue;
      blobs.sort((a, b) => b.length - a.length);
      const main = new Set(blobs[0].map((c) => key(c.col, c.row)));

      for (const fragment of blobs.slice(1)) {
        if (fragment.length > MAX_FRAGMENT) continue;
        for (const cell of fragment) {
          const host = dominantNeighbour(cell, cellAt, region);
          if (!host) break;
          const swap = cellTouching(component, cellAt, host, main);
          if (!swap) break;

          // Taking a cell out of the host can split the host in turn, which
          // would just move the problem. Only keep the swap if the two
          // regions end up in fewer pieces between them than they started.
          const before =
            blobsOf(component, cellAt, region).length +
            blobsOf(component, cellAt, host).length;
          cell.regionId = host;
          swap.regionId = region;
          const after =
            blobsOf(component, cellAt, region).length +
            blobsOf(component, cellAt, host).length;

          if (after > before) {
            cell.regionId = region;
            swap.regionId = host;
            continue;
          }
          main.add(key(swap.col, swap.row));
          swaps++;
        }
      }
    }
    if (swaps === 0) break;
  }
}

function dominantNeighbour(cell, cellAt, region) {
  const tally = {};
  for (const [dc, dr] of NEIGHBOURS) {
    const nb = cellAt.get(key(cell.col + dc, cell.row + dr));
    if (nb && nb.regionId && nb.regionId !== region) {
      tally[nb.regionId] = (tally[nb.regionId] || 0) + 1;
    }
  }
  const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

/** A cell of `region` touching the given blob, least embedded in its own. */
function cellTouching(component, cellAt, region, blob) {
  let best = null;
  let bestAttachment = Infinity;
  for (const c of component) {
    if (c.regionId !== region) continue;
    let touches = false;
    let attachment = 0;
    for (const [dc, dr] of NEIGHBOURS) {
      const k = key(c.col + dc, c.row + dr);
      if (blob.has(k)) touches = true;
      const nb = cellAt.get(k);
      if (nb && nb.regionId === region) attachment++;
    }
    if (!touches) continue;
    if (attachment < bestAttachment) {
      bestAttachment = attachment;
      best = c;
    }
  }
  return best;
}

function nearestCell(cells, point) {
  let best = null;
  let bestD = Infinity;
  for (const c of cells) {
    const d = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function nearestFreeCell(cells, point, taken) {
  let best = null;
  let bestD = Infinity;
  for (const c of cells) {
    if (taken.has(c)) continue;
    const d = (c.x - point.x) ** 2 + (c.y - point.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Pockets sealed off before their owner arrived go to an adjacent region. */
function claimLeftovers(component, cellAt, counts, targets) {
  let pending = component.filter((c) => c.regionId === null);
  let guard = 0;
  while (pending.length && guard++ < 500) {
    const next = [];
    for (const cell of pending) {
      const options = [];
      for (const [dc, dr] of NEIGHBOURS) {
        const nb = cellAt.get(key(cell.col + dc, cell.row + dr));
        if (nb && nb.regionId !== null) options.push(nb.regionId);
      }
      if (options.length === 0) {
        next.push(cell);
        continue;
      }
      options.sort(
        (a, b) =>
          (counts[a] || 0) - (targets[a] || 0) - ((counts[b] || 0) - (targets[b] || 0))
      );
      cell.regionId = options[0];
      counts[options[0]] = (counts[options[0]] || 0) + 1;
    }
    if (next.length === pending.length) break;
    pending = next;
  }
}

/**
 * Any region still short is owed cells by a region that is over. Take the
 * surplus cell closest to the short region's blob and flip it. A surplus
 * always exists while a shortfall does, because the targets sum to the cell
 * count, so this terminates.
 */
/**
 * Balance the counts by shifting cells along an augmenting path.
 *
 * A short region is rarely adjacent to a region that has spare cells, so a
 * single hop is not enough. Instead, walk the region adjacency graph out from
 * the short region until a region with a surplus turns up, then move one cell
 * across each border along that path. Total shortfall falls by exactly one
 * per path, so this converges.
 *
 * Both weaker versions were measured and rejected. Taking the nearest surplus
 * cell anywhere on the map balances the counts but strands disconnected
 * islands of one region inside another (86 of 240 Europe regions fragmented).
 * Taking from any adjacent neighbour and letting the donor go short in turn
 * keeps regions whole but oscillates between two neighbours instead of
 * converging (allocation error rose to 56% on Europe).
 */
function repairShortfalls(component, cellAt, counts, targets, seeds) {
  const guardLimit = component.length * 4;
  let guard = 0;

  for (;;) {
    const region = Object.keys(targets).find(
      (r) => targets[r] > 0 && (counts[r] || 0) < targets[r]
    );
    if (!region || guard++ > guardLimit) break;

    // A region holding nothing has no border to cross, so it restarts at the
    // surplus cell nearest its seed. Measuring from the seed rather than the
    // first cell in raster order is what stops a starved region reappearing
    // in the top-left corner of the map.
    if (!(counts[region] > 0)) {
      const donor = seedDonor(component, counts, targets, seeds?.[region]);
      if (!donor) break;
      counts[donor.regionId]--;
      donor.regionId = region;
      counts[region] = (counts[region] || 0) + 1;
      continue;
    }

    const path = pathToSurplus(component, cellAt, counts, targets, region);
    if (!path) break;

    let moved = false;
    for (let i = path.length - 1; i >= 1; i--) {
      const cell = borderCell(component, cellAt, path[i - 1], path[i]);
      if (!cell) break;
      counts[cell.regionId]--;
      cell.regionId = path[i - 1];
      counts[path[i - 1]]++;
      moved = true;
    }
    if (!moved) break;
  }
}

/** Region ids adjacent to `region`, walking its border cells. */
function neighbourRegions(component, cellAt, region) {
  const found = new Set();
  for (const c of component) {
    if (c.regionId !== region) continue;
    for (const [dc, dr] of NEIGHBOURS) {
      const nb = cellAt.get(key(c.col + dc, c.row + dr));
      if (nb && nb.regionId !== null && nb.regionId !== region) found.add(nb.regionId);
    }
  }
  return found;
}

/** Shortest chain of touching regions from `start` to one holding a surplus. */
function pathToSurplus(component, cellAt, counts, targets, start) {
  const cameFrom = new Map([[start, null]]);
  const queue = [start];

  while (queue.length) {
    const region = queue.shift();
    if (region !== start && (counts[region] || 0) > (targets[region] || 0)) {
      const path = [];
      for (let r = region; r !== null; r = cameFrom.get(r)) path.unshift(r);
      return path;
    }
    for (const next of neighbourRegions(component, cellAt, region)) {
      if (cameFrom.has(next)) continue;
      cameFrom.set(next, region);
      queue.push(next);
    }
  }
  return null;
}

/**
 * A cell of `from` touching `to`, picking the one least embedded in `from` so
 * that handing it over does not cut the donor in two.
 */
function borderCell(component, cellAt, to, from) {
  let best = null;
  let bestAttachment = Infinity;

  for (const c of component) {
    if (c.regionId !== from) continue;
    let touchesTo = false;
    let attachment = 0;
    for (const [dc, dr] of NEIGHBOURS) {
      const nb = cellAt.get(key(c.col + dc, c.row + dr));
      if (!nb) continue;
      if (nb.regionId === to) touchesTo = true;
      if (nb.regionId === from) attachment++;
    }
    if (!touchesTo) continue;
    if (attachment < bestAttachment) {
      bestAttachment = attachment;
      best = c;
    }
  }
  return best;
}

function seedDonor(component, counts, targets, seed) {
  if (!seed) return null;
  let best = null;
  let bestD = Infinity;
  for (const c of component) {
    if (c.regionId === null) continue;
    if ((counts[c.regionId] || 0) <= (targets[c.regionId] || 0)) continue;
    const d = (c.x - seed.x) ** 2 + (c.y - seed.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Lloyd relaxation.
 *
 * The first allocation is seeded on geography, which fixes where each region
 * belongs but leaves shapes ragged: a region owed 30x its own area has to
 * sprawl, and which direction it sprawls in is arbitrary. Re-seeding on the
 * centroid of the blob a region actually received, and re-growing, pulls each
 * one into a compact mass. Relative positions survive because every region
 * relaxes at once.
 *
 * The seed is dragged back toward the geographic anchor by ANCHOR_PULL.
 * Raising it does not buy geographic fidelity: measured over all three
 * geographies, going from 0.25 to 0.65 left mean drift flat (3.7% to 4.4% of
 * the map diagonal on Catalonia) while compactness got clearly worse (1.34 to
 * 1.67 there, 2.02 to 2.82 on Europe). A light pull wins on both axes.
 *
 * Residual drift is inherent, not a defect. Barcelona's metro comarques hold
 * about 60% of Catalonia's population on 5% of its land, in a coastal corner,
 * so they can only grow inland and their centroids necessarily move with
 * them. Any contiguous cartogram of a concentrated population does this.
 */
const ANCHOR_PULL = 0.25;
const RELAX_ROUNDS = 4;

function relax(component, targets, seeds) {
  for (let round = 0; round < RELAX_ROUNDS; round++) {
    const sums = {};
    for (const c of component) {
      if (c.regionId === null) continue;
      const s = (sums[c.regionId] ||= { x: 0, y: 0, n: 0 });
      s.x += c.x;
      s.y += c.y;
      s.n++;
    }
    const nextSeeds = {};
    for (const [region, s] of Object.entries(sums)) {
      const cx = s.x / s.n;
      const cy = s.y / s.n;
      const anchor = seeds[region];
      nextSeeds[region] = anchor
        ? {
            x: cx + (anchor.x - cx) * ANCHOR_PULL,
            y: cy + (anchor.y - cy) * ANCHOR_PULL,
          }
        : { x: cx, y: cy };
    }
    allocate(component, targets, nextSeeds);
  }
}

function measureError(cells, targets) {
  const got = {};
  for (const c of cells) got[c.regionId] = (got[c.regionId] || 0) + 1;
  const errors = [];
  for (const [region, target] of Object.entries(targets)) {
    if (target < 3) continue;
    errors.push((Math.abs((got[region] || 0) - target) / target) * 100);
  }
  if (errors.length === 0) return { mean: 0, median: 0, max: 0, n: 0 };
  errors.sort((a, b) => a - b);
  return {
    mean: errors.reduce((a, b) => a + b, 0) / errors.length,
    median: errors[Math.floor(errors.length / 2)],
    max: errors.at(-1),
    n: errors.length,
  };
}
