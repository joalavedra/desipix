// Shared helpers for the dataset builders.
//
// Every builder reads the existing `<geo>-datasets.json`, keeps its `regions`
// block (labels, colours, cities — curated by hand), and rewrites `datasets`
// and `meta` from the upstream API. Paths resolve against the repo root, so
// the scripts run from anywhere.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA = path.join(ROOT, "data");

export function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
}

/**
 * Write a datasets file, preserving the hand-curated `regions` block.
 *
 * @param {string} file Filename under data/, e.g. "spain-datasets.json".
 * @param {object} datasets The rebuilt `datasets` map.
 * @param {object} meta Provenance for the whole file.
 */
export function writeDatasets(file, datasets, meta) {
  const target = path.join(DATA, file);
  const existing = JSON.parse(fs.readFileSync(target, "utf8"));
  const out = { regions: existing.regions, meta, datasets };
  fs.writeFileSync(target, JSON.stringify(out));
  const kb = (fs.statSync(target).size / 1024).toFixed(0);
  console.log(`\nwrote ${file} — ${Object.keys(datasets).length} datasets, ${kb} KB`);
}

export async function fetchJson(url, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "desipix-datasets/2" } });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
      return await r.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(600 * attempt);
    }
  }
  throw new Error(`fetch failed after ${retries} tries: ${url}\n  ${lastErr.message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Walk a JSON-stat 2.0 response and call `emit(keyObject, value)` per cell.
 * Works for both Eurostat (sparse object `value`) and Idescat (dense array).
 */
export function eachJsonStatCell(js, emit) {
  const dimIds = js.id || js.dimension.id;
  const sizes = js.size || js.dimension.size;
  const categories = dimIds.map((d) => {
    const index = js.dimension[d].category.index;
    return Array.isArray(index)
      ? index
      : Object.keys(index).sort((a, b) => index[a] - index[b]);
  });

  const total = sizes.reduce((a, b) => a * b, 1);
  const dense = Array.isArray(js.value);

  for (let flat = 0; flat < total; flat++) {
    const value = dense ? js.value[flat] : js.value[flat];
    if (value === null || value === undefined) continue;
    const key = {};
    let rest = flat;
    for (let d = sizes.length - 1; d >= 0; d--) {
      key[dimIds[d]] = categories[d][rest % sizes[d]];
      rest = Math.floor(rest / sizes[d]);
    }
    emit(key, value);
  }
}

/** Drop years where fewer than `minCoverage` of the regions have a value. */
export function pruneSparseYears(values, regionIds, minCoverage = 0.6) {
  const need = Math.ceil(regionIds.length * minCoverage);
  const kept = {};
  for (const [year, byRegion] of Object.entries(values)) {
    if (Object.keys(byRegion).length >= need) kept[year] = byRegion;
  }
  return kept;
}

export function summarise(name, ds, regionIds) {
  const years = Object.keys(ds.values).sort();
  if (years.length === 0) {
    console.log(`  ${name.padEnd(18)} EMPTY`);
    return;
  }
  const last = ds.values[years.at(-1)];
  const cov = `${Object.keys(last).length}/${regionIds.length}`;
  console.log(
    `  ${name.padEnd(18)} ${years[0]}–${years.at(-1)} (${String(years.length).padStart(2)}y)  ` +
      `coverage ${cov.padEnd(8)} ${ds.kind}`
  );
}
