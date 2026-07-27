// Rebuild data/spain-datasets.json from Eurostat.
//
// Spain's 17 autonomous communities plus Ceuta and Melilla map 1:1 onto
// Spanish NUTS-2 regions, so the CCAA map gets exactly the same eight
// indicators and the same time depth as the Europe map.
//
//   node tools/build-spain.mjs

import { pruneSparseYears, readJson, summarise, writeDatasets } from "./lib.mjs";
import { METRICS, SOURCE_URL, fetchMetric, remap } from "./eurostat.mjs";

const CCAA_TO_NUTS = {
  "01": "ES61", // Andalusia
  "02": "ES24", // Aragó
  "03": "ES12", // Astúries
  "04": "ES53", // Illes Balears
  "05": "ES70", // Canàries
  "06": "ES13", // Cantàbria
  "07": "ES41", // Castella i Lleó
  "08": "ES42", // Castella - la Manxa
  "09": "ES51", // Catalunya
  10: "ES52", // País Valencià
  11: "ES43", // Extremadura
  12: "ES11", // Galícia
  13: "ES30", // Madrid
  14: "ES62", // Múrcia
  15: "ES22", // Navarra
  16: "ES21", // Euskadi
  17: "ES23", // La Rioja
  18: "ES63", // Ceuta
  19: "ES64", // Melilla
};

const NUTS_TO_CCAA = Object.fromEntries(
  Object.entries(CCAA_TO_NUTS).map(([ccaa, nuts]) => [nuts, String(ccaa)])
);

const regionIds = Object.keys(CCAA_TO_NUTS).map(String);
const wanted = new Set(Object.values(CCAA_TO_NUTS));

const existing = readJson("spain-datasets.json");
const labels = existing.regions.labels;
if (regionIds.some((id) => !labels[id])) {
  throw new Error("CCAA_TO_NUTS has ids missing from the geojson region labels");
}

const datasets = {};
for (const metric of METRICS) {
  process.stdout.write(`  fetching ${metric.dataset} … `);
  const raw = await fetchMetric(metric, (geo) => wanted.has(geo));
  const values = pruneSparseYears(remap(raw, NUTS_TO_CCAA, metric.decimals), regionIds);
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

writeDatasets("spain-datasets.json", datasets, {
  geography: "spain",
  regionLevel: "Comunitats autònomes (NUTS-2)",
  source: "Eurostat",
  sourceUrl: SOURCE_URL,
  builtBy: "tools/build-spain.mjs",
});
