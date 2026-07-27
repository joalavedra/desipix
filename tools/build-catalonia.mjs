// Rebuild data/catalonia-datasets.json from the Idescat Taules v2 API.
//
// EMEX (api.idescat.cat/emex) is the obvious source but publishes only the
// latest year per indicator, which is useless for time series. Taules v2
// serves the same statistics as full annual series broken down by comarca,
// so every metric here carries real history.
//
//   node tools/build-catalonia.mjs

import { fetchJson, pruneSparseYears, readJson, summarise, writeDatasets } from "./lib.mjs";

const BASE = "https://api.idescat.cat/taules/v2";
const SOURCE_URL = "https://www.idescat.cat/dev/api/taules/";

/**
 * Each entry pins one table plus the dimension slice that isolates a single
 * series. `pick` selects the CONCEPT/INDICATOR category holding the metric;
 * `filter` pins the remaining dimensions so exactly one value survives per
 * (year, comarca).
 */
const METRICS = [
  {
    key: "population",
    table: "pmh/446/477",
    filter: { SEX: "TOTAL" },
    label: "Població",
    unit: "persones",
    kind: "count",
    decimals: 0,
    source: "Idescat, Padró municipal d'habitants",
  },
  {
    key: "gdp_per_capita",
    table: "pibc/21925/26069",
    pick: { dim: "CONCEPT", match: /PIB per habitant \(€\)/ },
    label: "PIB per habitant",
    unit: "€",
    kind: "currency",
    decimals: 0,
    source: "Idescat, Producte interior brut territorial",
  },
  {
    key: "household_income",
    table: "rfdbc/21181/25017",
    pick: { dim: "INDICATOR", match: /per habitant \(€\)/ },
    label: "Renda familiar disponible per habitant",
    unit: "€",
    kind: "currency",
    decimals: 0,
    source: "Idescat, Renda disponible bruta de les llars",
  },
  {
    key: "taxable_income",
    table: "irpf/4070/3893",
    pick: { dim: "CONCEPT", match: /base imposable general/i },
    label: "Base imposable de l'IRPF per declarant",
    unit: "€",
    kind: "currency",
    decimals: 0,
    source: "Idescat, Impost sobre la renda de les persones físiques",
  },
  {
    key: "employment",
    table: "ist/14074/15022",
    pick: { dim: "CONCEPT", match: /població ocupada/i },
    label: "Població ocupada",
    unit: "%",
    kind: "rate",
    decimals: 1,
    source: "Idescat, Índex socioeconòmic territorial",
  },
  {
    key: "low_education",
    table: "ist/14074/15022",
    pick: { dim: "CONCEPT", match: /població amb estudis baixos/i },
    label: "Població amb estudis baixos",
    unit: "%",
    kind: "rate",
    decimals: 1,
    source: "Idescat, Índex socioeconòmic territorial",
  },
  {
    key: "mean_income",
    table: "ist/14074/15022",
    pick: { dim: "CONCEPT", match: /renda mitjana per persona/i },
    label: "Renda mitjana per persona",
    unit: "€",
    kind: "currency",
    decimals: 0,
    source: "Idescat, Índex socioeconòmic territorial",
  },
  {
    key: "socioeconomic_index",
    table: "ist/14034/14994",
    label: "Índex socioeconòmic territorial",
    unit: "Catalunya=100",
    kind: "index",
    decimals: 1,
    source: "Idescat, Índex socioeconòmic territorial",
  },
];

const existing = readJson("catalonia-datasets.json");
const regionIds = Object.keys(existing.regions.labels);

/** Category codes for a JSON-stat dimension, in positional order. */
function codes(dimension) {
  const index = dimension.category.index;
  return Array.isArray(index)
    ? index
    : Object.keys(index).sort((a, b) => index[a] - index[b]);
}

/** Resolve `pick` to the category code whose label matches. */
function resolvePick(js, pick) {
  if (!pick) return null;
  const dim = js.dimension[pick.dim];
  if (!dim) throw new Error(`dimension ${pick.dim} not in response`);
  const labels = dim.category.label || {};
  const hit = Object.entries(labels).find(([, label]) => pick.match.test(label));
  if (!hit) {
    throw new Error(
      `no ${pick.dim} category matches ${pick.match} — have: ${Object.values(labels).join(" | ")}`
    );
  }
  return hit[0];
}

/**
 * Idescat returns a dense value array. Walk it with explicit strides so we can
 * pin every dimension except YEAR and COM without a second request.
 */
function extract(js, metric) {
  const dimIds = js.id;
  const sizes = js.size;
  const cats = dimIds.map((d) => codes(js.dimension[d]));

  const pinned = { ...(metric.filter || {}) };
  const pickCode = resolvePick(js, metric.pick);
  if (pickCode !== null) pinned[metric.pick.dim] = pickCode;

  const yearLabels = js.dimension.YEAR.category.label || {};
  const factor = 10 ** metric.decimals;
  const out = {};

  for (let flat = 0; flat < js.value.length; flat++) {
    const value = js.value[flat];
    if (value === null || value === undefined) continue;

    const key = {};
    let rest = flat;
    for (let d = sizes.length - 1; d >= 0; d--) {
      key[dimIds[d]] = cats[d][rest % sizes[d]];
      rest = Math.floor(rest / sizes[d]);
    }

    let skip = false;
    for (const [dim, code] of Object.entries(pinned)) {
      if (key[dim] !== code) { skip = true; break; }
    }
    if (skip) continue;

    const com = key.COM;
    if (com === "TOTAL" || !regionIds.includes(com)) continue;

    const year = yearLabels[key.YEAR] || key.YEAR;
    (out[year] ||= {})[com] = Math.round(value * factor) / factor;
  }
  return out;
}

const cache = new Map();
async function loadTable(table) {
  if (!cache.has(table)) {
    cache.set(table, await fetchJson(`${BASE}/${table}/com/data?lang=ca`));
  }
  return cache.get(table);
}

const datasets = {};
for (const metric of METRICS) {
  process.stdout.write(`  ${metric.key.padEnd(20)} ${metric.table} … `);
  const js = await loadTable(metric.table);
  const values = pruneSparseYears(extract(js, metric), regionIds, 0.8);
  datasets[metric.key] = {
    label: metric.label,
    unit: metric.unit,
    kind: metric.kind,
    decimals: metric.decimals,
    source: metric.source,
    sourceUrl: SOURCE_URL,
    values,
  };
  console.log("ok");
}

console.log("");
for (const [key, ds] of Object.entries(datasets)) summarise(key, ds, regionIds);

writeDatasets("catalonia-datasets.json", datasets, {
  geography: "catalonia",
  regionLevel: "Comarques i Aran",
  source: "Idescat",
  sourceUrl: SOURCE_URL,
  builtBy: "tools/build-catalonia.mjs",
});
