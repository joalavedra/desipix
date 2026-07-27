import { cataloniaProjection, europeProjection, spainProjection } from "./cartogram.js";
import { CH, CW, drawRanking, drawTrend } from "./chart.js";
import { aggregate, formatCompact, formatValue } from "./format.js";
import { H, W, drawDorling, drawScaled, drawTileMap } from "./map.js";
import { CATEGORICAL, isDark, scaleFor, token } from "./palette.js";

const GEOGRAPHIES = {
  spain: {
    title: "Espanya",
    geojson: "./data/spain-ccaa.geojson",
    datasets: "./data/spain-datasets.json",
    projection: spainProjection,
    tiles: 1000,
  },
  catalonia: {
    title: "Catalunya",
    geojson: "./data/catalonia-comarques.geojson",
    datasets: "./data/catalonia-datasets.json",
    projection: cataloniaProjection,
    tiles: 1500,
  },
  europe: {
    title: "Europa",
    geojson: "./data/europe-nuts2.geojson",
    datasets: "./data/europe-datasets.json",
    projection: europeProjection,
    tiles: 2500,
  },
};

const $ = (id) => document.getElementById(id);

const state = {
  geography: "spain",
  dataset: null,
  weight: null,
  year: null,
  mode: "tiles",
  view: "map",
  trend: "indexed",
  highlight: [],
  geojson: null,
  meta: null,
};

// ---- URL state ------------------------------------------------------------

const URL_KEYS = ["geography", "dataset", "weight", "year", "mode", "view", "trend"];

function readUrl() {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const k of URL_KEYS) {
    const v = params.get(k);
    if (v) state[k] = v;
  }
  const h = params.get("highlight");
  if (h) state.highlight = h.split(",").filter(Boolean);
}

function writeUrl() {
  const params = new URLSearchParams();
  for (const k of URL_KEYS) if (state[k]) params.set(k, state[k]);
  if (state.highlight.length) params.set("highlight", state.highlight.join(","));
  history.replaceState(null, "", `#${params}`);
}

// ---- Loading --------------------------------------------------------------

async function loadGeography(key) {
  const g = GEOGRAPHIES[key];
  const [geojson, meta] = await Promise.all([
    fetch(g.geojson).then((r) => r.json()),
    fetch(g.datasets).then((r) => r.json()),
  ]);
  state.geography = key;
  state.geojson = geojson;
  state.meta = meta;

  const keys = Object.keys(meta.datasets);
  const weights = weightCandidates(meta);
  if (!weights.includes(state.weight)) state.weight = weights[0];
  // Default the fill to something other than the weight, so the map opens
  // showing two variables rather than the same one twice.
  if (!keys.includes(state.dataset)) {
    state.dataset = keys.find((k) => k !== state.weight) || keys[0];
  }

  fillSelect($("dataset"), keys, (k) => meta.datasets[k].label, state.dataset);
  fillSelect($("weight"), weights, (k) => meta.datasets[k].label, state.weight);

  $("tiles").value = g.tiles;
  $("tilesLabel").textContent = g.tiles;

  refreshYears();
  buildHighlightPicker();
  render();
}

/** Only counts can size a mark; sizing tiles by a rate would be meaningless. */
function weightCandidates(meta) {
  const counts = Object.keys(meta.datasets).filter((k) => meta.datasets[k].kind === "count");
  return counts.length ? counts : Object.keys(meta.datasets);
}

function fillSelect(select, values, label, selected) {
  select.innerHTML = "";
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = label(v);
    select.appendChild(opt);
  }
  select.value = selected;
}

/**
 * Offer only years where both the indicator and the weight have data, so the
 * map can never show a fill with nothing sized under it.
 */
function refreshYears() {
  const indicator = state.meta.datasets[state.dataset];
  const weight = state.meta.datasets[state.weight];
  const shared = Object.keys(indicator.values)
    .filter((y) => weight.values[y])
    .sort();
  const years = shared.length ? shared : Object.keys(indicator.values).sort();

  fillSelect($("year"), years, (y) => y, years.includes(state.year) ? state.year : years.at(-1));
  state.year = $("year").value;
  $("year").disabled = years.length <= 1;
}

function buildHighlightPicker() {
  const picker = $("highlightPicker");
  picker.innerHTML = "";
  const labels = state.meta.regions.labels;
  const ranked = rankRegions();

  state.highlight = state.highlight.filter((id) => labels[id]);
  if (state.highlight.length === 0) state.highlight = ranked.slice(0, 3);

  const colours = CATEGORICAL[isDark() ? "dark" : "light"];
  for (const id of ranked.slice(0, 24)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    const on = state.highlight.includes(id);
    btn.setAttribute("aria-pressed", String(on));
    if (on) btn.style.background = colours[state.highlight.indexOf(id) % colours.length];
    btn.textContent = labels[id];
    btn.addEventListener("click", () => {
      const i = state.highlight.indexOf(id);
      if (i === -1) {
        if (state.highlight.length >= 4) state.highlight.shift();
        state.highlight.push(id);
      } else {
        state.highlight.splice(i, 1);
      }
      buildHighlightPicker();
      render();
    });
    picker.appendChild(btn);
  }
}

/** Regions ordered by weight, so the picker leads with the ones that matter. */
function rankRegions() {
  const weight = state.meta.datasets[state.weight];
  const year = Object.keys(weight.values).sort().at(-1);
  const slice = weight.values[year] || {};
  return Object.keys(state.meta.regions.labels).sort(
    (a, b) => (slice[b] || 0) - (slice[a] || 0)
  );
}

// ---- Render ---------------------------------------------------------------

let renderToken = 0;

function render() {
  if (!state.meta) return;
  writeUrl();
  syncControls();

  const canvas = $("canvas");
  canvas.dataset.busy = "true";
  const ticket = ++renderToken;

  // Yield once so the browser paints the busy state before the allocator
  // blocks the main thread.
  requestAnimationFrame(() => {
    if (ticket !== renderToken) return;
    try {
      if (state.view === "map") renderMap();
      else renderChart();
    } finally {
      canvas.dataset.busy = "false";
    }
  });
}

function currentSlice() {
  const dataset = state.meta.datasets[state.dataset];
  const weightSet = state.meta.datasets[state.weight];
  const values = dataset.values[state.year] || {};
  const weightYear = weightSet.values[state.year]
    ? state.year
    : Object.keys(weightSet.values).sort().at(-1);
  return { dataset, weightSet, values, weights: weightSet.values[weightYear] || {} };
}

function renderMap() {
  const svg = $("stage");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = "<title></title>";

  const { dataset, weightSet, values, weights } = currentSlice();
  const scale = scaleFor(dataset, Object.values(values));

  const ctx = {
    svg,
    geojson: state.geojson,
    meta: state.meta,
    dataset,
    values,
    weights,
    scale,
    projection: GEOGRAPHIES[state.geography].projection,
    tiles: +$("tiles").value,
  };

  const started = performance.now();
  drawHeading(
    svg,
    W,
    `${GEOGRAPHIES[state.geography].title}: ${dataset.label}`,
    `${state.year} · mida = ${weightSet.label.toLowerCase()}`
  );

  let result = {};
  if (state.mode === "dorling") result = drawDorling(ctx);
  else if (state.mode === "scaled") result = drawScaled(ctx);
  else result = drawTileMap(ctx);

  drawFootnote(svg, H, dataset);
  const elapsed = Math.round(performance.now() - started);

  attachHover(svg, values, dataset, weights, weightSet);
  paintLegend(scale, dataset);
  paintReadout(values, dataset, weights, elapsed, result);
  paintTable(values, dataset, weights, weightSet);
  svg.querySelector("title").textContent =
    `${dataset.label}, ${state.year}, per ${GEOGRAPHIES[state.geography].title}`;
}

function renderChart() {
  const svg = $("stage");
  svg.setAttribute("viewBox", `0 0 ${CW} ${CH}`);
  svg.innerHTML = "<title></title>";
  const { dataset, values, weights, weightSet } = currentSlice();
  const title = `${GEOGRAPHIES[state.geography].title}: ${dataset.label}`;

  if (state.view === "trend") {
    drawTrend({
      svg,
      dataset,
      labels: state.meta.regions.labels,
      highlight: state.highlight,
      indexed: state.trend === "indexed",
      title,
    });
    svg.querySelector("title").textContent = `Evolució de ${dataset.label}`;
  } else {
    drawRanking({
      svg,
      dataset,
      labels: state.meta.regions.labels,
      values,
      title: `${title} (${state.year})`,
    });
    attachHover(svg, values, dataset, weights, weightSet);
    svg.querySelector("title").textContent = `Rànquing de ${dataset.label}, ${state.year}`;
  }

  paintLegend(null, dataset);
  paintReadout(values, dataset, weights, null, {});
  paintTable(values, dataset, weights, weightSet);
}

function svgText(x, y, size, weight, fill, content, anchor) {
  const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t.setAttribute("x", x);
  t.setAttribute("y", y);
  t.setAttribute("font-size", size);
  t.setAttribute("font-weight", weight);
  t.setAttribute("fill", fill);
  if (anchor) t.setAttribute("text-anchor", anchor);
  t.textContent = content;
  return t;
}

function drawHeading(svg, width, title, subtitle) {
  svg.appendChild(svgText(width / 2, 26, "19", "700", token("--ink"), title, "middle"));
  svg.appendChild(
    svgText(width / 2, 45, "12", "400", token("--ink-secondary"), subtitle, "middle")
  );
}

/** Every export carries its own provenance. */
function drawFootnote(svg, height, dataset) {
  svg.appendChild(
    svgText(10, height - 8, "10.5", "400", token("--ink-muted"),
      `Font: ${dataset.source} · desipix`)
  );
}

// ---- Hover ----------------------------------------------------------------

function attachHover(svg, values, dataset, weights, weightSet) {
  const tip = $("tooltip");
  const labels = state.meta.regions.labels;
  const ranked = Object.entries(values)
    .filter(([, v]) => Number.isFinite(v))
    .sort((a, b) => b[1] - a[1]);
  const rankOf = new Map(ranked.map(([id], i) => [id, i + 1]));

  const show = (id, event) => {
    const rows = [
      `<div class="t-row">${dataset.label}: ${formatValue(values[id], dataset)}</div>`,
    ];
    if (rankOf.has(id)) {
      rows.push(`<div class="t-row">Posició ${rankOf.get(id)} de ${ranked.length}</div>`);
    }
    if (weightSet && state.view === "map") {
      rows.push(
        `<div class="t-row">${weightSet.label}: ${formatValue(weights[id], weightSet)}</div>`
      );
    }
    tip.innerHTML = `<div class="t-name">${labels[id] || id}</div>${rows.join("")}`;
    tip.dataset.show = "true";
    const pad = 14;
    const rect = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + rect.width > innerWidth - 8) x = event.clientX - rect.width - pad;
    if (y + rect.height > innerHeight - 8) y = event.clientY - rect.height - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };

  svg.addEventListener("pointermove", (event) => {
    const owner = event.target.closest("[data-region]");
    if (!owner) {
      tip.dataset.show = "false";
      return;
    }
    show(owner.dataset.region, event);
  });
  svg.addEventListener("pointerleave", () => {
    tip.dataset.show = "false";
  });
}

// ---- Sidebar panels -------------------------------------------------------

function paintLegend(scale, dataset) {
  const field = $("legendField");
  if (!scale || scale.bins.length === 0) {
    field.classList.add("hide");
    return;
  }
  field.classList.remove("hide");
  $("legendTitle").textContent = dataset.label;
  const wrap = $("swatches");
  wrap.innerHTML = "";
  for (const bin of scale.bins) {
    const i = document.createElement("i");
    i.style.background = bin.color;
    i.title = `${formatCompact(bin.from, dataset)} – ${formatCompact(bin.to, dataset)}`;
    wrap.appendChild(i);
  }
  $("scaleLo").textContent = formatCompact(scale.bins[0].from, dataset);
  $("scaleHi").textContent = formatCompact(scale.bins.at(-1).to, dataset);
}

function paintReadout(values, dataset, weights, elapsed, result) {
  const { value, label } = aggregate(values, dataset, weights);
  const covered = Object.values(values).filter(Number.isFinite).length;
  const total = Object.keys(state.meta.regions.labels).length;

  const parts = [
    `${label}: <b>${formatValue(value, dataset)}</b>`,
    `Cobertura: <b>${covered}/${total}</b> regions`,
  ];
  if (result?.tileValue) {
    const weightSet = state.meta.datasets[state.weight];
    parts.push(
      `1 bloc ≈ <b>${formatCompact(result.tileValue, weightSet)} ${weightSet.unit}</b>`
    );
  }
  if (result?.allocationError?.n) {
    parts.push(`Error d'assignació: <b>${result.allocationError.mean.toFixed(1)}%</b>`);
  }
  if (elapsed !== null && elapsed !== undefined) parts.push(`${elapsed} ms`);
  $("readout").innerHTML = parts.map((p) => `<span>${p}</span>`).join("");

  $("sourceNote").innerHTML =
    `Font: ${dataset.source}. ` +
    `<a href="${dataset.sourceUrl}" target="_blank" rel="noopener">Consulta l'origen</a>.`;
}

/** The table view is the colour-free twin: every value readable without hue. */
function paintTable(values, dataset, weights, weightSet) {
  const labels = state.meta.regions.labels;
  const rank = (v) => (Number.isFinite(v) ? v : -Infinity);
  const rows = Object.keys(labels)
    .map((id) => ({ id, name: labels[id], v: values[id], w: weights[id] }))
    .sort((a, b) => rank(b.v) - rank(a.v));

  const head =
    `<thead><tr><th>Regió</th><th class="num">${dataset.label}</th>` +
    `<th class="num">${weightSet.label}</th></tr></thead>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td>${r.name}</td><td class="num">${formatValue(r.v, dataset)}</td>` +
        `<td class="num">${formatValue(r.w, weightSet)}</td></tr>`
    )
    .join("");
  $("dataTable").innerHTML = `${head}<tbody>${body}</tbody>`;
}

function syncControls() {
  const isMap = state.view === "map";
  $("modeField").classList.toggle("hide", !isMap);
  $("tilesField").classList.toggle("hide", !isMap || state.mode !== "tiles");
  $("weightField").classList.toggle("hide", !isMap);
  $("trendField").classList.toggle("hide", state.view !== "trend");
  $("highlightField").classList.toggle("hide", state.view !== "trend");
  $("year").closest(".field").classList.toggle("hide", state.view === "trend");

  for (const b of document.querySelectorAll("[data-view]")) {
    b.setAttribute("aria-pressed", String(b.dataset.view === state.view));
  }
  for (const b of document.querySelectorAll("[data-mode]")) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === state.mode));
  }
  for (const b of document.querySelectorAll("[data-trend]")) {
    b.setAttribute("aria-pressed", String(b.dataset.trend === state.trend));
  }
}

// ---- Export ---------------------------------------------------------------

function downloadPng() {
  const svg = $("stage");
  const clone = svg.cloneNode(true);
  const [, , vw, vh] = svg.getAttribute("viewBox").split(" ").map(Number);
  clone.setAttribute("width", vw);
  clone.setAttribute("height", vh);

  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}`;
  clone.insertBefore(style, clone.firstChild);

  const xml = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = vw * scale;
    canvas.height = vh * scale;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = token("--surface");
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `desipix-${state.geography}-${state.view}-${state.dataset}-${state.year}.png`;
      a.click();
      URL.revokeObjectURL(a.href);
    }, "image/png");
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    $("readout").innerHTML = "<span>No s'ha pogut exportar la imatge.</span>";
  };
  img.src = url;
}

// ---- Wiring ---------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("desipix-theme", theme);
}

function init() {
  const stored = localStorage.getItem("desipix-theme");
  const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(stored || (prefersDark ? "dark" : "light"));

  readUrl();
  $("geography").value = state.geography;

  $("geography").addEventListener("change", (e) => {
    state.highlight = [];
    loadGeography(e.target.value);
  });
  $("dataset").addEventListener("change", (e) => {
    state.dataset = e.target.value;
    refreshYears();
    render();
  });
  $("weight").addEventListener("change", (e) => {
    state.weight = e.target.value;
    refreshYears();
    buildHighlightPicker();
    render();
  });
  $("year").addEventListener("change", (e) => {
    state.year = e.target.value;
    render();
  });
  $("tiles").addEventListener("input", (e) => {
    $("tilesLabel").textContent = e.target.value;
  });
  $("tiles").addEventListener("change", render);
  $("download").addEventListener("click", downloadPng);
  $("theme").addEventListener("click", () => {
    applyTheme(isDark() ? "light" : "dark");
    buildHighlightPicker();
    render();
  });

  for (const btn of document.querySelectorAll("[data-view]")) {
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      render();
    });
  }
  for (const btn of document.querySelectorAll("[data-mode]")) {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      render();
    });
  }
  for (const btn of document.querySelectorAll("[data-trend]")) {
    btn.addEventListener("click", () => {
      state.trend = btn.dataset.trend;
      render();
    });
  }

  loadGeography(state.geography);
}

init();
