import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// ----- Projections -----

export function spainProjection(geojson, width, height) {
  const main = d3.geoMercator();
  const can = d3.geoMercator();

  const mainlandFC = {
    type: "FeatureCollection",
    features: geojson.features.filter((f) => d3.geoBounds(f)[0][0] > -10),
  };
  const canariasFC = {
    type: "FeatureCollection",
    features: geojson.features.filter((f) => d3.geoBounds(f)[0][0] <= -10),
  };

  main.fitExtent(
    [
      [10, 70],
      [width - 10, height - 80],
    ],
    mainlandFC
  );

  const insetW = width * 0.22;
  const insetH = height * 0.16;
  can.fitExtent(
    [
      [10, height - insetH - 10],
      [10 + insetW, height - 10],
    ],
    canariasFC
  );

  const project = (lonLat) => {
    if (lonLat[0] < -10) return can(lonLat);
    return main(lonLat);
  };
  return { project };
}

export function europeProjection(geojson, width, height) {
  const proj = d3.geoAzimuthalEqualArea()
    .rotate([-10, -52])
    .precision(0.1);
  proj.fitExtent(
    [
      [10, 60],
      [width - 10, height - 20],
    ],
    geojson
  );
  return { project: (lonLat) => proj(lonLat) };
}

export function cataloniaProjection(geojson, width, height) {
  const proj = d3.geoMercator();
  proj.fitExtent(
    [
      [10, 70],
      [width - 10, height - 20],
    ],
    geojson
  );
  return { project: (lonLat) => proj(lonLat) };
}

// ----- Geometry helpers -----

function pathBoxOf(fc, project) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of fc.features) {
    const visit = (coords) => {
      if (typeof coords[0] === "number") {
        const p = project(coords);
        if (p) {
          x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
        }
      } else for (const c of coords) visit(c);
    };
    visit(f.geometry.coordinates);
  }
  return { x0, y0, x1, y1 };
}

function projectGeometry(geom, project) {
  const result = [];
  const projectRing = (ring) =>
    ring.map((c) => project(c)).filter((p) => p && isFinite(p[0]) && isFinite(p[1]));
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

function pointInPolygon(point, vs) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const [xi, yi] = vs[i];
    const [xj, yj] = vs[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

function projectedLandArea(geojson, project) {
  let total = 0;
  for (const f of geojson.features) {
    const polys = projectGeometry(f.geometry, project);
    for (const poly of polys) {
      total += polygonArea(poly[0]); // outer ring only; holes ignored
      for (let i = 1; i < poly.length; i++) total -= polygonArea(poly[i]);
    }
  }
  return total;
}

// ----- Main builder -----

export function buildCartogram({
  geojson,
  values,
  regionKey,
  totalTiles,
  width,
  height,
  projection,
  cities,
}) {
  const { project } = projection(geojson, width, height);

  // Pre-project city coordinates if provided
  const projectedCities = {};
  if (cities) {
    for (const [r, city] of Object.entries(cities)) {
      const p = project([city.lon, city.lat]);
      if (p && isFinite(p[0])) projectedCities[r] = { x: p[0], y: p[1] };
    }
  }

  const totalValue = Object.values(values).reduce((a, b) => a + b, 0);
  const tileValue = totalValue / totalTiles;

  const targets = {};
  for (const [r, v] of Object.entries(values)) {
    targets[r] = Math.max(0, Math.round(v / tileValue));
  }

  // Pixel tile size: derive from total land area, not bbox area
  const landArea = projectedLandArea(geojson, project);
  const tileSide = Math.sqrt(landArea / totalTiles);

  // Pre-project all features for fast point-in-polygon
  const projectedFeatures = geojson.features.map((f) => ({
    regionId: f.properties[regionKey],
    polys: projectGeometry(f.geometry, project),
  }));

  // Global bbox
  const bbox = pathBoxOf(geojson, project);
  const pad = tileSide * 4;
  const x0 = bbox.x0 - pad, y0 = bbox.y0 - pad;
  const x1 = bbox.x1 + pad, y1 = bbox.y1 + pad;
  const cols = Math.ceil((x1 - x0) / tileSide);
  const rows = Math.ceil((y1 - y0) / tileSide);

  // Rasterize entire map
  const cells = [];
  const grid = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = x0 + (col + 0.5) * tileSide;
      const y = y0 + (row + 0.5) * tileSide;
      const regionId = findRegion(x, y, projectedFeatures);
      if (regionId) {
        const cell = { col, row, x, y, regionId };
        cells.push(cell);
        grid.set(`${col},${row}`, cell);
      }
    }
  }

  ensureFootholds(targets, cells, grid, projectedFeatures, x0, y0, tileSide);

  fillInteriorHoles(cells, grid, x0, y0, tileSide);

  const components = detectComponents(cells, grid);

  // For each region, sum its cells across components so we can split a
  // region's target proportionally when it appears in multiple components
  // (e.g. Balears across Mallorca + Menorca + Ibiza).
  const regionTotalCells = {};
  for (const comp of components) {
    for (const c of comp) {
      regionTotalCells[c.regionId] = (regionTotalCells[c.regionId] || 0) + 1;
    }
  }

  for (const comp of components) {
    const compTargets = {};
    const cellsByRegion = {};
    for (const c of comp) {
      cellsByRegion[c.regionId] = (cellsByRegion[c.regionId] || 0) + 1;
    }
    for (const [r, cells] of Object.entries(cellsByRegion)) {
      const total = regionTotalCells[r];
      const targetR = targets[r] || 0;
      compTargets[r] = total > 0 ? Math.round((targetR * cells) / total) : 0;
    }
    const targetSum = Object.values(compTargets).reduce((a, b) => a + b, 0);

    if (targetSum === 0) continue;

    if (comp.length > targetSum) {
      trimComponent(comp, grid, targetSum, compTargets, projectedCities);
    } else if (comp.length < targetSum) {
      growComponent(comp, grid, projectedFeatures, targetSum, x0, y0, tileSide);
    }

    rebalanceTargets(compTargets, comp.length);

    redistribute(comp, compTargets);
    smoothContiguity(comp);
  }

  const finalCells = [];
  for (const c of grid.values()) finalCells.push(c);

  return { cells: finalCells, tileSide, tileValue, targets };
}

function findRegion(x, y, projectedFeatures) {
  for (const { regionId, polys } of projectedFeatures) {
    for (const poly of polys) {
      if (pointInPolygon([x, y], poly[0])) {
        let inHole = false;
        for (let i = 1; i < poly.length; i++) {
          if (pointInPolygon([x, y], poly[i])) { inHole = true; break; }
        }
        if (!inHole) return regionId;
      }
    }
  }
  return null;
}

function ensureFootholds(targets, cells, grid, projectedFeatures, x0, y0, tileSide) {
  // For each region with target ≥ 1 but no cells, find a cell near its
  // centroid and force-assign.
  const counts = {};
  for (const c of cells) counts[c.regionId] = (counts[c.regionId] || 0) + 1;
  for (const [r, t] of Object.entries(targets)) {
    if (t < 1) continue;
    if (counts[r]) continue;
    const feat = projectedFeatures.find((f) => f.regionId === r);
    if (!feat || feat.polys.length === 0) continue;
    // centroid of first polygon's outer ring
    const ring = feat.polys[0][0];
    if (ring.length === 0) continue;
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    const cx = sx / ring.length, cy = sy / ring.length;
    const col = Math.floor((cx - x0) / tileSide);
    const row = Math.floor((cy - y0) / tileSide);
    const key = `${col},${row}`;
    const x = x0 + (col + 0.5) * tileSide;
    const y = y0 + (row + 0.5) * tileSide;
    if (grid.has(key)) {
      // override existing cell's region (steal one from larger region)
      grid.get(key).regionId = r;
    } else {
      const cell = { col, row, x, y, regionId: r };
      cells.push(cell);
      grid.set(key, cell);
    }
  }
}

function detectComponents(cells, grid) {
  const visited = new Set();
  const components = [];
  for (const start of cells) {
    const key = `${start.col},${start.row}`;
    if (visited.has(key)) continue;
    const comp = [];
    const stack = [start];
    visited.add(key);
    while (stack.length) {
      const c = stack.pop();
      comp.push(c);
      for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const k = `${c.col+dc},${c.row+dr}`;
        if (visited.has(k)) continue;
        const nb = grid.get(k);
        if (!nb) continue;
        visited.add(k);
        stack.push(nb);
      }
    }
    components.push(comp);
  }
  return components;
}

function trimComponent(comp, grid, target, compTargets, projectedCities) {
  // For each region, pick a weight point: when a region is "dense" (target
  // ≈ geographic count, ratio > 0.7) use the centroid so geography is
  // preserved. When sparse (ratio << 1), blend toward the city to cluster
  // remaining tiles around the main town. This avoids carving holes out of
  // dense regions like Castilla y León.
  const centroids = computeRegionCentroids(comp);
  const cellsByRegion = {};
  for (const c of comp) cellsByRegion[c.regionId] = (cellsByRegion[c.regionId] || 0) + 1;

  const weightPoints = {};
  for (const r of Object.keys(centroids)) {
    const city = projectedCities && projectedCities[r];
    if (!city) { weightPoints[r] = centroids[r]; continue; }
    const t = (compTargets && compTargets[r]) || 0;
    const g = cellsByRegion[r] || 1;
    const utilization = Math.min(1, t / g); // 1 = dense, 0 = very sparse
    const cityWeight = Math.max(0, 1 - utilization); // sparse → use city
    weightPoints[r] = {
      x: centroids[r].x * (1 - cityWeight) + city.x * cityWeight,
      y: centroids[r].y * (1 - cityWeight) + city.y * cityWeight,
    };
  }

  const byRegion = new Map();
  for (const c of comp) {
    if (!byRegion.has(c.regionId)) byRegion.set(c.regionId, []);
    byRegion.get(c.regionId).push(c);
  }
  const protectedCells = new Set();
  for (const [r, regionCells] of byRegion) {
    const t = (compTargets && compTargets[r]) || 0;
    if (t <= 0) continue;
    const wp = weightPoints[r];
    regionCells.sort((a, b) => dist2(a, wp) - dist2(b, wp));
    for (let i = 0; i < Math.min(t, regionCells.length); i++) {
      protectedCells.add(regionCells[i]);
    }
  }

  comp.sort((a, b) => {
    const ap = protectedCells.has(a) ? 0 : 1;
    const bp = protectedCells.has(b) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const da = dist2(a, weightPoints[a.regionId]);
    const db = dist2(b, weightPoints[b.regionId]);
    return da - db;
  });
  while (comp.length > target) {
    const removed = comp.pop();
    grid.delete(`${removed.col},${removed.row}`);
  }
}

// Fill empty grid cells that are interior — 6+ of their 8 neighbors are
// land. Stricter than "3 cardinal" (which fills coastal bays) but catches
// pinholes that strict 4-cardinal misses when the gap is wider than 1 cell.
function fillInteriorHoles(cells, grid, x0, y0, tileSide) {
  for (let pass = 0; pass < 5; pass++) {
    let minCol = Infinity, maxCol = -Infinity, minRow = Infinity, maxRow = -Infinity;
    for (const c of cells) {
      if (c.col < minCol) minCol = c.col;
      if (c.col > maxCol) maxCol = c.col;
      if (c.row < minRow) minRow = c.row;
      if (c.row > maxRow) maxRow = c.row;
    }
    const additions = [];
    for (let row = minRow + 1; row < maxRow; row++) {
      for (let col = minCol + 1; col < maxCol; col++) {
        const key = `${col},${row}`;
        if (grid.has(key)) continue;
        const neighbors = [];
        for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
          const n = grid.get(`${col+dc},${row+dr}`);
          if (n) neighbors.push(n);
        }
        if (neighbors.length < 6) continue;
        const tally = {};
        for (const n of neighbors) tally[n.regionId] = (tally[n.regionId] || 0) + 1;
        const winner = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
        const x = x0 + (col + 0.5) * tileSide;
        const y = y0 + (row + 0.5) * tileSide;
        additions.push({ col, row, x, y, regionId: winner });
      }
    }
    if (additions.length === 0) break;
    for (const a of additions) {
      cells.push(a);
      grid.set(`${a.col},${a.row}`, a);
    }
  }
}

function growComponent(comp, grid, projectedFeatures, target, x0, y0, tileSide) {
  const centroids = computeRegionCentroids(comp);
  let safety = 0;
  while (comp.length < target && safety++ < 50000) {
    const candidates = new Map();
    for (const c of comp) {
      for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const k = `${c.col+dc},${c.row+dr}`;
        if (grid.has(k)) continue;
        const e = candidates.get(k) || { col: c.col+dc, row: c.row+dr, adj: 0 };
        e.adj++;
        candidates.set(k, e);
      }
    }
    if (candidates.size === 0) break;
    const sorted = [...candidates.values()].sort((a, b) => b.adj - a.adj);
    const toAdd = Math.min(sorted.length, target - comp.length);
    for (let i = 0; i < toAdd; i++) {
      const cand = sorted[i];
      const x = x0 + (cand.col + 0.5) * tileSide;
      const y = y0 + (cand.row + 0.5) * tileSide;
      let bestR = null, bestD = Infinity;
      for (const [r, cc] of Object.entries(centroids)) {
        const d = (x - cc.x) ** 2 + (y - cc.y) ** 2;
        if (d < bestD) { bestD = d; bestR = r; }
      }
      const cell = { col: cand.col, row: cand.row, x, y, regionId: bestR };
      comp.push(cell);
      grid.set(`${cand.col},${cand.row}`, cell);
    }
  }
}

function rebalanceTargets(targets, totalCells) {
  let sum = Object.values(targets).reduce((a, b) => a + b, 0);
  if (sum === totalCells) return;
  const ids = Object.keys(targets);
  if (ids.length === 0) return;
  const sortedByTarget = [...ids].sort((a, b) => (targets[b] || 0) - (targets[a] || 0));
  let diff = totalCells - sum;
  let i = 0;
  while (diff !== 0 && i < 100000) {
    const id = sortedByTarget[i % sortedByTarget.length];
    if (diff > 0) { targets[id]++; diff--; }
    else if ((targets[id] || 0) > 0) { targets[id]--; diff++; }
    i++;
  }
}

function computeRegionCentroids(cells) {
  const sums = {};
  for (const c of cells) {
    if (!sums[c.regionId]) sums[c.regionId] = { x: 0, y: 0, n: 0 };
    const s = sums[c.regionId];
    s.x += c.x; s.y += c.y; s.n++;
  }
  const result = {};
  for (const [r, s] of Object.entries(sums)) {
    result[r] = { x: s.x / s.n, y: s.y / s.n };
  }
  return result;
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function redistribute(cells, targets) {
  const grid = new Map();
  for (const c of cells) grid.set(`${c.col},${c.row}`, c);
  const counts = {};
  for (const c of cells) counts[c.regionId] = (counts[c.regionId] || 0) + 1;
  for (const r of Object.keys(targets)) if (!(r in counts)) counts[r] = 0;

  const centroids = computeRegionCentroids(cells);
  for (const r of Object.keys(targets)) {
    if (!centroids[r]) centroids[r] = { x: 0, y: 0 };
  }

  // Compute a per-region radius cap so propagation can't drag cells from
  // the other side of the country. Cap = 1.8 × max distance from centroid
  // to existing region cells. Phase 1 (strict) doesn't apply this cap.
  const radiusCap = {};
  for (const r of Object.keys(targets)) {
    const cD = centroids[r];
    let maxD2 = 0;
    for (const c of cells) {
      if (c.regionId !== r) continue;
      const d2 = (c.x - cD.x) ** 2 + (c.y - cD.y) ** 2;
      if (d2 > maxD2) maxD2 = d2;
    }
    radiusCap[r] = Math.sqrt(maxD2) * 1.8;
  }

  const stealPass = (allowFromNonSurplus) => {
    const deficits = Object.keys(targets)
      .map((r) => [r, targets[r] - counts[r]])
      .filter(([, d]) => d > 0)
      .sort((a, b) => b[1] - a[1]);
    if (deficits.length === 0) return false;
    let anyMove = false;
    for (const [D] of deficits) {
      if (targets[D] - counts[D] <= 0) continue;
      const seen = new Set();
      const candidates = [];
      const cD = centroids[D];
      const capD = allowFromNonSurplus ? radiusCap[D] || Infinity : Infinity;
      const capD2 = capD * capD;
      for (const c of cells) {
        if (c.regionId !== D) continue;
        for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const k = `${c.col+dc},${c.row+dr}`;
          if (seen.has(k)) continue;
          const nb = grid.get(k);
          if (!nb || nb.regionId === D) continue;
          const nbSurplus = counts[nb.regionId] - (targets[nb.regionId] || 0);
          if (!allowFromNonSurplus && nbSurplus <= 0) continue;
          if (allowFromNonSurplus && -nbSurplus >= targets[D] - counts[D]) continue;
          // Distance cap: don't propagate beyond D's natural radius
          if (allowFromNonSurplus) {
            const d2 = (nb.x - cD.x) ** 2 + (nb.y - cD.y) ** 2;
            if (d2 > capD2) continue;
          }
          seen.add(k);
          candidates.push({ cell: nb, surplus: nbSurplus });
        }
      }
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => {
        if ((a.surplus > 0) !== (b.surplus > 0)) return b.surplus - a.surplus;
        const da = (a.cell.x - cD.x) ** 2 + (a.cell.y - cD.y) ** 2;
        const db = (b.cell.x - cD.x) ** 2 + (b.cell.y - cD.y) ** 2;
        return da - db;
      });
      const pick = candidates[0].cell;
      counts[pick.regionId]--;
      pick.regionId = D;
      counts[D]++;
      anyMove = true;
    }
    return anyMove;
  };

  for (let pass = 0; pass < 200; pass++) {
    if (!stealPass(false)) break;
  }
  for (let pass = 0; pass < 200; pass++) {
    if (!stealPass(true)) break;
  }
}

function smoothContiguity(cells, { maxPasses = 6 } = {}) {
  const grid = new Map();
  for (const c of cells) grid.set(`${c.col},${c.row}`, c);
  const nb = (c) => [
    grid.get(`${c.col+1},${c.row}`),
    grid.get(`${c.col-1},${c.row}`),
    grid.get(`${c.col},${c.row+1}`),
    grid.get(`${c.col},${c.row-1}`),
  ].filter(Boolean);

  for (let pass = 0; pass < maxPasses; pass++) {
    let swaps = 0;
    for (const c of cells) {
      const neighbors = nb(c);
      const sameCount = neighbors.filter((n) => n.regionId === c.regionId).length;
      if (sameCount >= 2) continue;
      const tally = {};
      for (const n of neighbors) {
        if (n.regionId !== c.regionId) tally[n.regionId] = (tally[n.regionId] || 0) + 1;
      }
      const sEntries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
      if (sEntries.length === 0) continue;
      const S = sEntries[0][0];
      let best = null, bestScore = -1;
      for (const candidate of cells) {
        if (candidate.regionId !== S) continue;
        const cnb = nb(candidate);
        const sameInS = cnb.filter((n) => n.regionId === S).length;
        const adjToR = cnb.filter((n) => n.regionId === c.regionId).length;
        if (adjToR === 0) continue;
        const score = adjToR - sameInS;
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      if (!best) continue;
      const tmp = c.regionId;
      c.regionId = best.regionId;
      best.regionId = tmp;
      swaps++;
    }
    if (swaps === 0) break;
  }
}
