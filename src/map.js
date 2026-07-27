import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { buildCartogram } from "./cartogram.js";
import { inkOn, token } from "./palette.js";

// The three map forms. All of them read the same way: the mark's SIZE carries
// the weight variable (how many people, how many nights) and its FILL carries
// the selected indicator. Region identity comes from labels and the tooltip,
// never from fill colour.

const NS = "http://www.w3.org/2000/svg";
export const W = 900;
export const H = 780;

const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

/**
 * Build the projection once per render, fit to the regions carrying a weight.
 * Every layer shares it, so silhouettes, insets and tiles stay registered.
 */
function projectionFor(ctx) {
  if (!ctx._project) {
    const { project } = ctx.projection(ctx.geojson, W, H, (id) => ctx.weights[id] > 0);
    ctx._project = project;
  }
  return ctx._project;
}

/**
 * @typedef {object} MapContext
 * @property {SVGElement} svg Target, already cleared.
 * @property {object} geojson Geography.
 * @property {object} meta Datasets file.
 * @property {object} dataset Selected indicator descriptor.
 * @property {object} values Region id → indicator value.
 * @property {object} weights Region id → weight (drives mark size).
 * @property {object} scale Colour scale from palette.scaleFor.
 * @property {Function} projection Projection factory.
 * @property {number} tiles Tile budget (tile map only).
 * @property {Function} onHover Called with (regionId|null, event).
 */

export function drawTileMap(ctx) {
  const { svg, geojson, meta, values, weights, scale, projection, tiles } = ctx;

  const result = buildCartogram({
    geojson,
    values: weights,
    regionKey: meta.regions.key,
    totalTiles: tiles,
    width: W,
    height: H,
    projection,
  });

  drawMissingSilhouette(ctx, weights);

  const byRegion = new Map();
  for (const cell of result.cells) {
    if (!byRegion.has(cell.regionId)) byRegion.set(cell.regionId, []);
    byRegion.get(cell.regionId).push(cell);
  }

  // A 2px surface gap does the separating between regions, never a stroke.
  const gap = Math.min(1.6, result.tileSide * 0.14);
  const side = Math.max(0.5, result.tileSide - gap);

  const layer = el("g");
  for (const [regionId, cells] of byRegion) {
    const fill = scale.of(values[regionId]) ?? token("--no-data");
    const group = el("g", { fill });
    group.dataset.region = regionId;
    for (const c of cells) {
      group.appendChild(
        el("rect", {
          x: (c.x - result.tileSide / 2 + gap / 2).toFixed(2),
          y: (c.y - result.tileSide / 2 + gap / 2).toFixed(2),
          width: side.toFixed(2),
          height: side.toFixed(2),
        })
      );
    }
    layer.appendChild(group);
  }
  svg.appendChild(layer);

  const insetNames = new Set(insetLabels(ctx));
  const placed = [];
  for (const [regionId, cells] of byRegion) {
    const anchor = openestCell(cells, result.tileSide);
    placed.push({
      regionId,
      x: anchor.x,
      y: anchor.y,
      size: cells.length,
      fitW: anchor.clearW,
      fitH: anchor.clearH,
      fill: scale.of(values[regionId]) ?? token("--no-data"),
      suppressLabel: insetNames.has(meta.regions.labels[regionId]),
    });
  }
  drawLabels(ctx, placed);
  drawInsetFrames(ctx);

  return { allocationError: result.allocationError, tileValue: result.tileValue };
}

export function drawDorling(ctx) {
  const { svg, geojson, meta, values, weights, scale } = ctx;
  const project = projectionFor(ctx);
  const regionKey = meta.regions.key;

  const total = Object.values(weights).reduce((a, b) => a + (b > 0 ? b : 0), 0);
  const areaPerUnit = ((W - 40) * (H - 120) * 0.42) / (total || 1);

  const nodes = [];
  for (const f of geojson.features) {
    const id = f.properties[regionKey];
    const w = weights[id];
    if (!Number.isFinite(w) || w <= 0) continue;
    const c = centroid(f.geometry, project, id);
    if (!c) continue;
    nodes.push({
      regionId: id,
      cx: c[0],
      cy: c[1],
      x: c[0],
      y: c[1],
      r: Math.max(2.5, Math.sqrt((w * areaPerUnit) / Math.PI)),
      fill: scale.of(values[id]) ?? token("--no-data"),
    });
  }

  d3.forceSimulation(nodes)
    .force("x", d3.forceX((d) => d.cx).strength(0.3))
    .force("y", d3.forceY((d) => d.cy).strength(0.3))
    .force("collide", d3.forceCollide((d) => d.r + 1).strength(1))
    .stop()
    .tick(240);

  drawMissingSilhouette(ctx, weights);

  const layer = el("g");
  for (const n of nodes) {
    const circle = el("circle", {
      cx: n.x.toFixed(2),
      cy: n.y.toFixed(2),
      r: n.r.toFixed(2),
      fill: n.fill,
      stroke: token("--surface"),
      "stroke-width": "1.5",
    });
    circle.dataset.region = n.regionId;
    layer.appendChild(circle);
  }
  svg.appendChild(layer);

  drawLabels(
    ctx,
    nodes.map((n) => ({
      ...n,
      size: n.r * n.r,
      fitW: n.r * 1.7,
      fitH: n.r * 1.7,
    }))
  );
  drawInsetFrames(ctx);
  return {};
}

export function drawScaled(ctx) {
  const { svg, geojson, meta, values, weights, scale } = ctx;
  const project = projectionFor(ctx);
  const regionKey = meta.regions.key;

  const base = el("g", {
    fill: token("--no-data"),
    stroke: token("--surface"),
    "stroke-width": "0.6",
  });
  for (const f of geojson.features) {
    const d = pathFor(f.geometry, project, f.properties[regionKey]);
    if (d) base.appendChild(el("path", { d }));
  }
  svg.appendChild(base);

  const maxWeight = Math.max(...Object.values(weights).filter(Number.isFinite), 0);
  const placed = [];
  const layer = el("g");
  for (const f of geojson.features) {
    const id = f.properties[regionKey];
    const w = weights[id];
    if (!Number.isFinite(w) || w <= 0 || maxWeight <= 0) continue;
    const c = centroid(f.geometry, project, id);
    if (!c) continue;
    const k = Math.sqrt(w / maxWeight);
    const d = pathFor(f.geometry, project, id, c, k);
    if (!d) continue;
    const fill = scale.of(values[id]) ?? token("--no-data");
    const path = el("path", { d, fill });
    path.dataset.region = id;
    layer.appendChild(path);
    const bounds = pathBounds(d);
    placed.push({
      regionId: id,
      x: c[0],
      y: c[1],
      size: k * 400,
      fitW: bounds.width,
      fitH: bounds.height,
      fill,
    });
  }
  svg.appendChild(layer);
  drawLabels(ctx, placed);
  drawInsetFrames(ctx);
  return {};
}

/**
 * Insets are geographically dishonest by construction, so they get a hairline
 * bracket and a name. Without one, the Canaries read as a detached blob south
 * of Andalusia.
 */
export function drawInsetFrames(ctx) {
  const { svg } = ctx;
  const project = projectionFor(ctx);
  if (!project.insets) return;

  for (const inset of project.insets) {
    const [[x0, y0], [x1, y1]] = inset.box;
    svg.appendChild(
      el("path", {
        d: `M${x0 - 6},${y0 - 6}H${x1 + 6}V${y1 + 6}`,
        fill: "none",
        stroke: token("--axis"),
        "stroke-width": "1",
      })
    );
    svg.appendChild(
      Object.assign(
        el("text", {
          x: (x0 - 6).toFixed(1),
          y: (y0 - 12).toFixed(1),
          "font-size": "10.5",
          fill: token("--ink-muted"),
        }),
        { textContent: inset.label }
      )
    );
  }
}

/**
 * Regions with no value for the current slice keep a faint silhouette. Europe
 * loses about forty NUTS-2 regions after 2020 when the UK left the programme;
 * without this the map would silently change shape and read as if those
 * places had ceased to exist.
 */
function drawMissingSilhouette(ctx, weights) {
  const { svg, geojson, meta } = ctx;
  const project = projectionFor(ctx);
  const regionKey = meta.regions.key;

  const group = el("g", {
    fill: "none",
    stroke: token("--no-data"),
    "stroke-width": "0.7",
  });
  let any = false;
  for (const f of geojson.features) {
    const id = f.properties[regionKey];
    if (Number.isFinite(weights[id]) && weights[id] > 0) continue;
    const d = pathFor(f.geometry, project, id);
    if (!d) continue;
    group.appendChild(el("path", { d }));
    any = true;
  }
  if (any) svg.appendChild(group);
}

// Text measurement, so a label is only drawn when it genuinely fits. Guessing
// width from character count over-labels wide names and under-labels narrow
// ones, which is what turns a dense map into label soup.
const ruler = document.createElement("canvas").getContext("2d");
function textWidth(str, fontSize) {
  ruler.font = `600 ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  return ruler.measureText(str).width;
}

/**
 * Label big marks first, and only where the name actually fits inside the
 * region's own shape with padding. A label that does not fit is dropped, never
 * clipped and never spilled onto a neighbour — the tooltip and the table view
 * carry every value regardless.
 */
function drawLabels(ctx, placed) {
  const { svg, meta } = ctx;
  const labels = meta.regions.labels;
  const layer = el("g", { "pointer-events": "none" });
  const taken = [];

  const ranked = [...placed].sort((a, b) => b.size - a.size);
  for (const p of ranked) {
    const name = labels[p.regionId] || p.regionId;
    if (p.suppressLabel) continue;

    // Largest size that fits the mark's own box; give up below 9px.
    let fontSize = 0;
    for (const candidate of [17, 15, 13, 11.5, 10, 9]) {
      const w = textWidth(name, candidate);
      if (w + 6 <= p.fitW && candidate * 1.25 <= p.fitH) {
        fontSize = candidate;
        break;
      }
    }
    if (!fontSize) continue;

    const halfW = textWidth(name, fontSize) / 2;
    const halfH = fontSize * 0.62;
    const box = { x0: p.x - halfW, x1: p.x + halfW, y0: p.y - halfH, y1: p.y + halfH };
    if (box.x0 < 4 || box.x1 > W - 4 || box.y0 < 56 || box.y1 > H - 22) continue;
    if (taken.some((t) => overlaps(t, box))) continue;
    taken.push(box);

    layer.appendChild(
      Object.assign(
        el("text", {
          x: p.x.toFixed(1),
          y: p.y.toFixed(1),
          "text-anchor": "middle",
          "dominant-baseline": "middle",
          "font-size": fontSize,
          "font-weight": "600",
          fill: inkOn(p.fill),
        }),
        { textContent: name }
      )
    );
  }
  svg.appendChild(layer);
}

/**
 * Find the most open spot inside a region's own tiles, and how much room it
 * has there. The centroid of a scattered or crescent-shaped blob often lands
 * on a neighbour, which put labels on the wrong region and picked ink for the
 * wrong fill. Scanning for the cell with the largest clear run in each
 * direction keeps the label on its own colour.
 */
function openestCell(cells, tileSide) {
  const owned = new Set(cells.map((c) => `${c.col},${c.row}`));
  const runLength = (cell, dc, dr) => {
    let n = 0;
    let { col, row } = cell;
    while (owned.has(`${col + dc},${row + dr}`) && n < 40) {
      col += dc;
      row += dr;
      n++;
    }
    return n;
  };

  let best = cells[0];
  let bestScore = -1;
  let bestDims = { clearW: tileSide, clearH: tileSide };
  for (const cell of cells) {
    const leftRun = runLength(cell, -1, 0);
    const rightRun = runLength(cell, 1, 0);
    const upRun = runLength(cell, 0, -1);
    const downRun = runLength(cell, 0, 1);
    const width = (Math.min(leftRun, rightRun) * 2 + 1) * tileSide;
    const height = (Math.min(upRun, downRun) * 2 + 1) * tileSide;
    // Favour horizontal room: labels are far wider than they are tall.
    const score = Math.min(width, height * 3.2);
    if (score > bestScore) {
      bestScore = score;
      best = cell;
      bestDims = { clearW: width, clearH: height };
    }
  }
  return { x: best.x, y: best.y, ...bestDims };
}

/** Names already shown as an inset bracket, so the region skips its own. */
function insetLabels(ctx) {
  return (projectionFor(ctx).insets || []).map((i) => i.label);
}

/** Bounding box of an already-built SVG path string. */
function pathBounds(d) {
  const nums = d.match(/-?\d+(?:\.\d+)?/g);
  if (!nums) return { width: 0, height: 0 };
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = +nums[i];
    const y = +nums[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { width: x1 - x0, height: y1 - y0 };
}

function overlaps(a, b) {
  return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);
}

function pathFor(geom, project, regionId, origin, k) {
  const ring = (coords) => {
    const pts = [];
    for (const c of coords) {
      const p = project(c, regionId);
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      pts.push(
        origin ? [origin[0] + (p[0] - origin[0]) * k, origin[1] + (p[1] - origin[1]) * k] : p
      );
    }
    if (pts.length < 3) return "";
    return `M${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L")}Z`;
  };
  if (geom.type === "Polygon") return geom.coordinates.map(ring).join(" ");
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.map((poly) => poly.map(ring).join(" ")).join(" ");
  }
  return "";
}

/** Area-weighted centroid so multi-part regions anchor on their mainland. */
function centroid(geom, project, regionId) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best = null;
  let bestSpan = -1;
  for (const poly of polys) {
    const pts = [];
    for (const c of poly[0]) {
      const p = project(c, regionId);
      if (p && isFinite(p[0]) && isFinite(p[1])) pts.push(p);
    }
    if (pts.length < 3) continue;
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const span = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    if (span > bestSpan) {
      bestSpan = span;
      best = [
        pts.reduce((s, p) => s + p[0], 0) / pts.length,
        pts.reduce((s, p) => s + p[1], 0) / pts.length,
      ];
    }
  }
  return best;
}
