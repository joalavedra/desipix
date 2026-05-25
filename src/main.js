import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { buildCartogram, spainProjection, europeProjection, cataloniaProjection } from "./cartogram.js";

const W = 900;
const H = 800;

const GEOGRAPHIES = {
  spain: {
    label: "Espanya",
    geojson: "./data/spain-ccaa.geojson",
    datasets: "./data/spain-datasets.json",
    projection: spainProjection,
    title: "Espanya",
    insetLabel: "Canàries",
    showInsetFrame: true,
    cartogramTiles: 1000,
  },
  europe: {
    label: "Europa",
    geojson: "./data/europe-nuts2.geojson",
    datasets: "./data/europe-datasets.json",
    projection: europeProjection,
    title: "Europa",
    insetLabel: null,
    showInsetFrame: false,
    cartogramTiles: 2500,
  },
  catalonia: {
    label: "Catalunya",
    geojson: "./data/catalonia-comarques.geojson",
    datasets: "./data/catalonia-datasets.json",
    projection: cataloniaProjection,
    title: "Catalunya",
    insetLabel: null,
    showInsetFrame: false,
    cartogramTiles: 1500,
  },
};

const $ = (id) => document.getElementById(id);
const state = { geographyKey: "spain", geojson: null, meta: null, mode: "cartogram" };

async function loadGeography(key) {
  const g = GEOGRAPHIES[key];
  const [geo, meta] = await Promise.all([
    fetch(g.geojson).then((r) => r.json()),
    fetch(g.datasets).then((r) => r.json()),
  ]);
  state.geographyKey = key;
  state.geojson = geo;
  state.meta = meta;

  const dsEl = $("dataset");
  dsEl.innerHTML = "";
  for (const [k, v] of Object.entries(meta.datasets)) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = v.label;
    dsEl.appendChild(opt);
  }

  refreshYearOptions();
  renderLegend();
  render();
}

function refreshYearOptions() {
  const dsKey = $("dataset").value;
  const ds = state.meta.datasets[dsKey];
  const years = Object.keys(ds.values || {}).sort();
  const yearEl = $("year");
  const prev = yearEl.value;
  yearEl.innerHTML = "";
  for (const y of years) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    yearEl.appendChild(opt);
  }
  if (years.includes(prev)) yearEl.value = prev;
  else if (years.length) yearEl.value = years[years.length - 1];
  yearEl.disabled = years.length <= 1;
}

async function init() {
  await loadGeography("spain");

  $("geography").addEventListener("change", (e) => loadGeography(e.target.value));
  $("dataset").addEventListener("change", () => { refreshYearOptions(); render(); });
  $("year").addEventListener("change", render);
  $("showCities").addEventListener("change", render);
  $("download").addEventListener("click", downloadPng);

  document.querySelectorAll(".modeBtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".modeBtn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mode = btn.dataset.mode;
      render();
    });
  });
}

function renderLegend() {
  const wrap = $("legend");
  wrap.innerHTML = "";
  const { labels, colors, countries, countryNames } = state.meta.regions;
  const ids = Object.keys(labels);

  if (countries && ids.length > 50) {
    wrap.style.gridTemplateColumns = "1fr";
    const seen = new Set();
    for (const id of ids) {
      const c = countries[id];
      if (seen.has(c)) continue;
      seen.add(c);
      const row = document.createElement("div");
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = colors[id];
      row.appendChild(sw);
      const t = document.createElement("span");
      t.textContent = (countryNames && countryNames[c]) || c;
      row.appendChild(t);
      wrap.appendChild(row);
    }
    return;
  }

  wrap.style.gridTemplateColumns = "1fr 1fr";
  for (const id of ids) {
    const row = document.createElement("div");
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = colors[id] || "#999";
    row.appendChild(sw);
    const t = document.createElement("span");
    t.textContent = labels[id];
    row.appendChild(t);
    wrap.appendChild(row);
  }
}

function render() {
  if (!state.meta) return;
  const dsKey = $("dataset").value;
  const year = $("year").value;
  const ds = state.meta.datasets[dsKey];
  if (!ds) return;
  const values = ds.values[year];
  if (!values) return;
  const geog = GEOGRAPHIES[state.geographyKey];

  // population denom for city share
  const popDs = state.meta.datasets.population;
  let populationByRegion = values;
  if (popDs && popDs.values) {
    const popYears = Object.keys(popDs.values).sort();
    populationByRegion = popDs.values[popYears[popYears.length - 1]] || values;
  }

  const t0 = performance.now();
  const svg = $("stage");
  svg.innerHTML = "";

  if (state.mode === "dorling") {
    drawDorling({ values, ds, year, geog });
  } else if (state.mode === "scaled") {
    drawScaled({ values, ds, year, geog });
  } else {
    drawCartogramMode({ values, ds, year, populationByRegion, geog });
  }

  const elapsed = (performance.now() - t0).toFixed(0);
  const totalValue = Object.values(values).reduce((a, b) => a + b, 0);
  $("status").textContent = `Total: ${formatNum(totalValue)} ${ds.unit}  ·  ${elapsed}ms`;
  $("tileMeta").textContent = ({
    cartogram: `Cartograma · diferències amplificades · ${formatNum(totalValue)} ${ds.unit} totals`,
    dorling: "Dorling (1 cercle per regió, mida = valor)",
    scaled: "Escalat · formes reals, mida ∝ valor",
  })[state.mode] || "";
}

// ---- Mode 1: Choropleth ----

function drawChoropleth({ values, ds, year, geog }) {
  const svg = $("stage");
  const ns = "http://www.w3.org/2000/svg";
  const { colors, labels, cities } = state.meta.regions;
  const regionKey = state.meta.regions.key;
  const { project } = geog.projection(state.geojson, W, H);

  drawTitle(svg, ns, geog, ds, year);

  // Color scale: sqrt of value → opacity multiplier on the region's base color
  const vals = Object.values(values).filter((v) => v > 0);
  const vMax = Math.max(...vals);
  const scale = (v) => Math.sqrt((v || 0) / vMax); // 0..1

  for (const f of state.geojson.features) {
    const id = f.properties[regionKey];
    const base = colors[id] || "#999";
    const t = scale(values[id]);
    const fill = mixColor("#f4f4f1", base, 0.15 + 0.85 * t);
    const d = featureToPath(f.geometry, project);
    if (!d) continue;
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", fill);
    p.setAttribute("stroke", "#fff");
    p.setAttribute("stroke-width", "0.5");
    svg.appendChild(p);
  }

  // City markers + region labels
  const showCities = $("showCities").checked;
  for (const f of state.geojson.features) {
    const id = f.properties[regionKey];
    const c = featureCentroid(f.geometry, project);
    if (!c) continue;
    addLabel(svg, ns, c[0], c[1], 11, labels[id] || id);
    if (showCities && cities && cities[id]) {
      const p = project([cities[id].lon, cities[id].lat]);
      if (p && isFinite(p[0])) {
        const dot = document.createElementNS(ns, "circle");
        dot.setAttribute("cx", p[0]);
        dot.setAttribute("cy", p[1]);
        dot.setAttribute("r", 3);
        dot.setAttribute("fill", "#000");
        svg.appendChild(dot);
      }
    }
  }

  drawInsetFrame(svg, ns, geog);
}

// ---- Mode 2: Cartogram (existing) ----

function drawCartogramMode({ values, ds, year, populationByRegion, geog }) {
  // Exaggerate the spread: large regions get visibly bigger, tiny regions
  // shrink — inequality reads stronger than a linear cartogram. Power chosen
  // empirically so Spain's Madrid + Catalunya still occupy a fair area
  // share but small CCAA like La Rioja/Ceuta become unmistakably small.
  const EXAGGERATE = 1.4;
  const exaggerated = {};
  for (const [k, v] of Object.entries(values)) {
    exaggerated[k] = v > 0 ? Math.pow(v, EXAGGERATE) : 0;
  }

  const result = buildCartogram({
    geojson: state.geojson,
    values: exaggerated,
    regionKey: state.meta.regions.key,
    totalTiles: geog.cartogramTiles,
    width: W,
    height: H,
    projection: geog.projection,
    cities: state.meta.regions.cities,
  });
  drawCartogramSvg(result, ds, year, populationByRegion, geog);
}

function drawCartogramSvg({ cells, tileSide, tileValue }, ds, year, values, geog) {
  const svg = $("stage");
  const ns = "http://www.w3.org/2000/svg";
  const { colors, labels, countries, cities } = state.meta.regions;
  const { project } = geog.projection(state.geojson, W, H);

  drawTitle(svg, ns, geog, ds, year);

  const showCities = $("showCities").checked;
  const cityCells = (showCities && cities)
    ? pickCityCells(cells, cities, values, project)
    : new Set();

  const byRegion = new Map();
  for (const c of cells) {
    if (!byRegion.has(c.regionId)) byRegion.set(c.regionId, []);
    byRegion.get(c.regionId).push(c);
  }

  const gap = Math.min(0.5, tileSide * 0.06);
  for (const [regionId, regionCells] of byRegion) {
    const base = colors[regionId] || "#999";
    const dark = darkenHex(base);
    const gLight = document.createElementNS(ns, "g");
    gLight.setAttribute("fill", base);
    const gDark = document.createElementNS(ns, "g");
    gDark.setAttribute("fill", dark);
    let dCount = 0;
    for (const c of regionCells) {
      const r = document.createElementNS(ns, "rect");
      r.setAttribute("x", c.x - tileSide / 2 + gap / 2);
      r.setAttribute("y", c.y - tileSide / 2 + gap / 2);
      r.setAttribute("width", tileSide - gap);
      r.setAttribute("height", tileSide - gap);
      if (cityCells.has(c)) { gDark.appendChild(r); dCount++; }
      else gLight.appendChild(r);
    }
    svg.appendChild(gLight);
    if (dCount > 0) svg.appendChild(gDark);
  }

  // Region labels — suppress when a city has same name
  if (countries && byRegion.size > 50) {
    const { countryNames } = state.meta.regions;
    const byCountry = new Map();
    for (const [regionId, regionCells] of byRegion) {
      const c = countries[regionId];
      if (!byCountry.has(c)) byCountry.set(c, []);
      byCountry.get(c).push(...regionCells);
    }
    for (const [country, ccells] of byCountry) {
      if (ccells.length < 3) continue;
      const cx = ccells.reduce((s, c) => s + c.x, 0) / ccells.length;
      const cy = ccells.reduce((s, c) => s + c.y, 0) / ccells.length;
      const fs = Math.max(9, Math.min(18, Math.sqrt(ccells.length) * 1.1));
      addLabel(svg, ns, cx, cy, fs, (countryNames && countryNames[country]) || country);
    }
  } else {
    for (const [regionId, regionCells] of byRegion) {
      if (regionCells.length < 4) continue;
      const label = labels[regionId] || regionId;
      const cityName = cities && cities[regionId] && cities[regionId].name;
      if (cityName && cityName.toLowerCase() === label.toLowerCase()) continue;
      const cx = regionCells.reduce((s, c) => s + c.x, 0) / regionCells.length;
      const cy = regionCells.reduce((s, c) => s + c.y, 0) / regionCells.length;
      const fs = Math.max(9, Math.min(15, Math.sqrt(regionCells.length) * 1.4));
      addLabel(svg, ns, cx, cy, fs, label);
    }
  }

  // City labels
  if (showCities && cities) {
    const cityGroups = new Map();
    for (const cell of cityCells) {
      if (!cityGroups.has(cell.regionId)) cityGroups.set(cell.regionId, []);
      cityGroups.get(cell.regionId).push(cell);
    }
    for (const [regionId, cluster] of cityGroups) {
      if (cluster.length === 0) continue;
      const city = cities[regionId];
      if (!city) continue;
      const cx = cluster.reduce((s, c) => s + c.x, 0) / cluster.length;
      const cy = cluster.reduce((s, c) => s + c.y, 0) / cluster.length;
      const fs = Math.max(8, Math.min(11, Math.sqrt(cluster.length) * 1.4));
      addLabel(svg, ns, cx, cy, fs, city.name, "#fff", "#000");
    }
  }

  drawInsetFrame(svg, ns, geog);
}

// ---- Mode 3: Dorling ----

function drawDorling({ values, ds, year, geog }) {
  const svg = $("stage");
  const ns = "http://www.w3.org/2000/svg";
  const { colors, labels, countries, cities } = state.meta.regions;
  const regionKey = state.meta.regions.key;
  const { project } = geog.projection(state.geojson, W, H);

  drawTitle(svg, ns, geog, ds, year);

  // Build nodes: one per region with value > 0
  const totalValue = Object.values(values).reduce((a, b) => a + b, 0);
  // Target: circles fill ~38% of canvas area
  const canvasArea = (W - 20) * (H - 80);
  const areaScale = (canvasArea * 0.38) / totalValue;

  const nodes = [];
  for (const f of state.geojson.features) {
    const id = f.properties[regionKey];
    const v = values[id] || 0;
    if (v <= 0) continue;
    const c = featureCentroid(f.geometry, project);
    if (!c) continue;
    const r = Math.sqrt((v * areaScale) / Math.PI);
    nodes.push({
      id,
      label: labels[id] || id,
      cx: c[0],
      cy: c[1],
      x: c[0],
      y: c[1],
      r: Math.max(3, r),
      color: colors[id] || "#999",
      value: v,
    });
  }

  // Force layout to push circles apart while keeping near their geographic location
  const sim = d3.forceSimulation(nodes)
    .force("x", d3.forceX((d) => d.cx).strength(0.25))
    .force("y", d3.forceY((d) => d.cy).strength(0.25))
    .force("collide", d3.forceCollide((d) => d.r + 1).strength(1))
    .stop();
  for (let i = 0; i < 220; i++) sim.tick();

  // Draw circles + labels
  for (const n of nodes) {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", n.x);
    c.setAttribute("cy", n.y);
    c.setAttribute("r", n.r);
    c.setAttribute("fill", n.color);
    c.setAttribute("stroke", "rgba(0,0,0,0.25)");
    c.setAttribute("stroke-width", "0.5");
    svg.appendChild(c);
  }
  // Labels only for big enough circles
  const { countryNames } = state.meta.regions;
  const manyRegions = nodes.length > 50;
  for (const n of nodes) {
    if (n.r < 9) continue;
    const fs = Math.min(14, Math.max(8, n.r * 0.45));
    let label = n.label;
    if (manyRegions && countries && countries[n.id]) {
      const code = countries[n.id];
      label = (countryNames && countryNames[code]) || code;
    }
    addLabel(svg, ns, n.x, n.y, fs, label);
  }
}

// ---- Mode 4: Hex tilegram ----

function drawHex({ values, ds, year, geog }) {
  const svg = $("stage");
  const ns = "http://www.w3.org/2000/svg";
  const { colors, labels, countries, countryNames } = state.meta.regions;
  const regionKey = state.meta.regions.key;
  const { project } = geog.projection(state.geojson, W, H);

  drawTitle(svg, ns, geog, ds, year);

  // Hex radius scales with region count so they fit. Target ~50% coverage.
  const regionCount = state.geojson.features.filter((f) => (values[f.properties[regionKey]] || 0) > 0).length;
  const usableArea = (W - 40) * (H - 100);
  const hexArea = usableArea * 0.55 / Math.max(1, regionCount);
  const R = Math.sqrt(hexArea / ((3 * Math.sqrt(3)) / 2));

  // Color scale: sqrt of value → opacity of base color
  const vals = Object.values(values).filter((v) => v > 0);
  const vMax = Math.max(...vals);

  const nodes = [];
  for (const f of state.geojson.features) {
    const id = f.properties[regionKey];
    const v = values[id] || 0;
    if (v <= 0) continue;
    const c = featureCentroid(f.geometry, project);
    if (!c) continue;
    nodes.push({
      id,
      label: labels[id] || id,
      cx: c[0], cy: c[1], x: c[0], y: c[1],
      r: R,
      baseColor: colors[id] || "#999",
      value: v,
      intensity: Math.sqrt(v / vMax),
    });
  }

  // Force layout: collide on circumradius (R), pull toward geographic centroid
  const sim = d3.forceSimulation(nodes)
    .force("x", d3.forceX((d) => d.cx).strength(0.35))
    .force("y", d3.forceY((d) => d.cy).strength(0.35))
    .force("collide", d3.forceCollide(R * 1.05).strength(1))
    .stop();
  for (let i = 0; i < 220; i++) sim.tick();

  // Draw hexagons (flat-top)
  for (const n of nodes) {
    const fill = mixColor("#f4f4f1", n.baseColor, 0.2 + 0.8 * n.intensity);
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      pts.push(`${(n.x + R * Math.cos(a)).toFixed(1)},${(n.y + R * Math.sin(a)).toFixed(1)}`);
    }
    const p = document.createElementNS(ns, "polygon");
    p.setAttribute("points", pts.join(" "));
    p.setAttribute("fill", fill);
    p.setAttribute("stroke", "white");
    p.setAttribute("stroke-width", "1");
    svg.appendChild(p);
  }

  // Labels — country code/name for many-region maps, full label otherwise
  const manyRegions = nodes.length > 50;
  for (const n of nodes) {
    if (R < 8) continue;
    const fs = Math.min(13, Math.max(8, R * 0.4));
    let label = n.label;
    if (manyRegions && countries && countries[n.id]) {
      const code = countries[n.id];
      label = (countryNames && countryNames[code]) || code;
    }
    addLabel(svg, ns, n.x, n.y, fs, label);
  }
}

// ---- Mode 5: Non-contiguous scaled ----

function drawScaled({ values, ds, year, geog }) {
  const svg = $("stage");
  const ns = "http://www.w3.org/2000/svg";
  const { colors, labels, countries, countryNames } = state.meta.regions;
  const regionKey = state.meta.regions.key;
  const { project } = geog.projection(state.geojson, W, H);

  drawTitle(svg, ns, geog, ds, year);

  // Faded base map
  for (const f of state.geojson.features) {
    const d = featureToPath(f.geometry, project);
    if (!d) continue;
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", "#ececea");
    p.setAttribute("stroke", "#d4d4d0");
    p.setAttribute("stroke-width", "0.4");
    svg.appendChild(p);
  }

  // Scale = sqrt(value / max). Largest region renders at 100% of its real shape.
  const vMax = Math.max(...Object.values(values).filter((v) => v > 0));

  // Draw each region scaled around its centroid
  for (const f of state.geojson.features) {
    const id = f.properties[regionKey];
    const v = values[id] || 0;
    if (v <= 0) continue;
    const c = featureCentroid(f.geometry, project);
    if (!c) continue;
    const scale = Math.sqrt(v / vMax);
    const d = scaledFeatureToPath(f.geometry, project, c, scale);
    if (!d) continue;
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    p.setAttribute("fill", colors[id] || "#999");
    p.setAttribute("stroke", "white");
    p.setAttribute("stroke-width", "0.5");
    p.setAttribute("opacity", "0.85");
    svg.appendChild(p);
  }

  // Labels — only the biggest regions
  const manyRegions = state.geojson.features.length > 50;
  for (const f of state.geojson.features) {
    const id = f.properties[regionKey];
    const v = values[id] || 0;
    if (v <= 0) continue;
    const scale = Math.sqrt(v / vMax);
    if (scale < 0.25) continue;
    const c = featureCentroid(f.geometry, project);
    if (!c) continue;
    let label = labels[id] || id;
    if (manyRegions && countries && countries[id]) {
      const code = countries[id];
      label = (countryNames && countryNames[code]) || code;
    }
    const fs = Math.max(9, Math.min(15, scale * 14));
    addLabel(svg, ns, c[0], c[1], fs, label);
  }
}

function scaledFeatureToPath(geom, project, [cx, cy], scale) {
  const ringToPath = (ring) => {
    const pts = ring.map((c) => {
      const p = project(c);
      if (!p || !isFinite(p[0])) return null;
      return [cx + (p[0] - cx) * scale, cy + (p[1] - cy) * scale];
    }).filter(Boolean);
    if (pts.length < 3) return "";
    return "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L") + "Z";
  };
  if (geom.type === "Polygon") return geom.coordinates.map(ringToPath).join(" ");
  if (geom.type === "MultiPolygon") return geom.coordinates.map((poly) => poly.map(ringToPath).join(" ")).join(" ");
  return "";
}

// ---- City picker (cartogram only) ----

function pickCityCells(cells, cities, values, project) {
  const cityCells = new Set();
  const byRegion = new Map();
  for (const c of cells) {
    if (!byRegion.has(c.regionId)) byRegion.set(c.regionId, []);
    byRegion.get(c.regionId).push(c);
  }
  for (const [regionId, regionCells] of byRegion) {
    const city = cities[regionId];
    if (!city) continue;
    const regionPop = values[regionId] || 0;
    if (regionPop === 0) continue;
    const rawShare = city.population / regionPop;
    const share = Math.min(0.4, rawShare * 0.65);
    const n = Math.max(1, Math.round(share * regionCells.length));
    const proj = project([city.lon, city.lat]);
    if (!proj || !isFinite(proj[0])) continue;
    regionCells.sort((a, b) => {
      const da = (a.x - proj[0]) ** 2 + (a.y - proj[1]) ** 2;
      const db = (b.x - proj[0]) ** 2 + (b.y - proj[1]) ** 2;
      return da - db;
    });
    for (let i = 0; i < Math.min(n, regionCells.length); i++) {
      cityCells.add(regionCells[i]);
    }
  }
  return cityCells;
}

// ---- Helpers ----

function featureToPath(geom, project) {
  const ringToPath = (ring) => {
    const pts = ring.map((c) => project(c)).filter((p) => p && isFinite(p[0]));
    if (pts.length < 3) return "";
    return "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L") + "Z";
  };
  if (geom.type === "Polygon") {
    return geom.coordinates.map(ringToPath).join(" ");
  }
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.map((poly) => poly.map(ringToPath).join(" ")).join(" ");
  }
  return "";
}

function featureCentroid(geom, project) {
  let sx = 0, sy = 0, n = 0;
  const visit = (coords) => {
    if (typeof coords[0] === "number") {
      const p = project(coords);
      if (p && isFinite(p[0])) { sx += p[0]; sy += p[1]; n++; }
    } else for (const c of coords) visit(c);
  };
  visit(geom.coordinates);
  if (n === 0) return null;
  return [sx / n, sy / n];
}

function mixColor(a, b, t) {
  const parse = (h) => {
    const x = h.replace("#", "");
    return [parseInt(x.substring(0,2),16), parseInt(x.substring(2,4),16), parseInt(x.substring(4,6),16)];
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${r.toString(16).padStart(2,"0")}${g.toString(16).padStart(2,"0")}${bl.toString(16).padStart(2,"0")}`;
}

function darkenHex(hex, factor = 0.55) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `#${Math.round(r*factor).toString(16).padStart(2,"0")}${Math.round(g*factor).toString(16).padStart(2,"0")}${Math.round(b*factor).toString(16).padStart(2,"0")}`;
}

function drawTitle(svg, ns, geog, ds, year) {
  const title = document.createElementNS(ns, "text");
  title.setAttribute("x", W / 2);
  title.setAttribute("y", 32);
  title.setAttribute("text-anchor", "middle");
  title.setAttribute("font-size", "22");
  title.setAttribute("font-weight", "700");
  title.setAttribute("font-family", "Georgia, serif");
  title.textContent = `${geog.title}: ${ds.label}${year && year !== "—" ? " (" + year + ")" : ""}`;
  svg.appendChild(title);

  const sub = document.createElementNS(ns, "text");
  sub.setAttribute("x", W / 2);
  sub.setAttribute("y", 52);
  sub.setAttribute("text-anchor", "middle");
  sub.setAttribute("font-size", "11");
  sub.setAttribute("fill", "#666");
  sub.textContent = ({
    cartogram: "Mode equilibrat · diferències amplificades",
    dorling: "Mode diferències · cada cercle = una regió, mida = valor",
    scaled: "Mode escalat · forma real, escalada pel valor",
  })[state.mode] || "";
  svg.appendChild(sub);
}

function drawInsetFrame(svg, ns, geog) {
  if (!geog.showInsetFrame) return;
  const insetTopY = H - H * 0.16 - 10;
  const insetRightX = 10 + W * 0.22;
  const line = (x1, y1, x2, y2) => {
    const l = document.createElementNS(ns, "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", "#ccc"); l.setAttribute("stroke-width", "1");
    svg.appendChild(l);
  };
  line(10, insetTopY, insetRightX, insetTopY);
  line(insetRightX, insetTopY, insetRightX, H - 10);
  const lbl = document.createElementNS(ns, "text");
  lbl.setAttribute("x", 14);
  lbl.setAttribute("y", insetTopY - 4);
  lbl.setAttribute("font-size", "10");
  lbl.setAttribute("fill", "#666");
  lbl.textContent = geog.insetLabel;
  svg.appendChild(lbl);
}

function addLabel(svg, ns, cx, cy, fontSize, text, stroke = "white", fill = "#1a1a1a") {
  const t = document.createElementNS(ns, "text");
  t.setAttribute("x", cx);
  t.setAttribute("y", cy);
  t.setAttribute("text-anchor", "middle");
  t.setAttribute("dominant-baseline", "middle");
  t.setAttribute("font-size", fontSize);
  t.setAttribute("font-weight", "700");
  t.setAttribute("font-family", "Georgia, serif");
  t.setAttribute("stroke", stroke);
  t.setAttribute("stroke-width", "3");
  t.setAttribute("stroke-linejoin", "round");
  t.setAttribute("paint-order", "stroke");
  t.setAttribute("fill", fill);
  t.textContent = text;
  svg.appendChild(t);
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return Math.round(n).toString();
}

async function downloadPng() {
  const svg = $("stage");
  const xml = new XMLSerializer().serializeToString(svg);
  const blob = new Blob([xml], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((b) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `pixelmap-${state.geographyKey}-${state.mode}-${$("dataset").value}-${$("year").value}.png`;
      a.click();
    }, "image/png");
  };
  img.src = url;
}

init();
