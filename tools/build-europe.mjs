// Rebuild data/europe-datasets.json from Eurostat.
//
// The Europe geojson carries NUTS-2 codes as feature ids, so the join is
// direct. Coverage is uneven by design: the UK left the NUTS programme after
// 2020 and some regions were recoded between NUTS vintages, so a region
// missing from a given year is a real gap, not a bug.
//
//   node tools/build-europe.mjs

import { pruneSparseYears, readJson, summarise, writeDatasets } from "./lib.mjs";
import { METRICS, SOURCE_URL, fetchMetric, remap } from "./eurostat.mjs";

const geo = readJson("europe-nuts2.geojson");
const regionIds = geo.features.map((f) => f.properties.id);
const wanted = new Set(regionIds);
console.log(`NUTS-2 regions in the geojson: ${regionIds.length}`);

const identity = Object.fromEntries(regionIds.map((id) => [id, id]));

const datasets = {};
for (const metric of METRICS) {
  process.stdout.write(`  fetching ${metric.dataset} … `);
  const raw = await fetchMetric(metric, (g) => wanted.has(g));
  // A lower coverage floor than Spain: Europe genuinely has patchy years.
  const values = pruneSparseYears(remap(raw, identity, metric.decimals), regionIds, 0.45);
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

writeDatasets("europe-datasets.json", datasets, {
  geography: "europe",
  regionLevel: "NUTS-2",
  source: "Eurostat",
  sourceUrl: SOURCE_URL,
  builtBy: "tools/build-europe.mjs",
});
