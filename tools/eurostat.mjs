// Eurostat metric definitions, shared by the Europe (NUTS-2) and Spain (CCAA)
// builders. Spanish autonomous communities map 1:1 onto Spanish NUTS-2
// regions, so both geographies are served by the same eight indicators at the
// same time depth.

import { eachJsonStatCell, fetchJson } from "./lib.mjs";

const BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/";

/**
 * Eight indicators, chosen for annual time depth rather than breadth. `filter`
 * pins every dimension except geo and time so the response stays small.
 */
export const METRICS = [
  {
    key: "population",
    dataset: "demo_r_pjanaggr3",
    filter: { sex: "T", age: "TOTAL", unit: "NR" },
    label: "Població",
    unit: "persones",
    kind: "count",
    decimals: 0,
    source: "Eurostat, demo_r_pjanaggr3",
  },
  {
    key: "gdp_per_capita",
    dataset: "nama_10r_2gdp",
    filter: { unit: "EUR_HAB" },
    label: "PIB per habitant",
    unit: "€",
    kind: "currency",
    decimals: 0,
    source: "Eurostat, nama_10r_2gdp",
  },
  {
    key: "household_income",
    dataset: "nama_10r_2hhinc",
    filter: { unit: "PPS_EU27_2020_HAB", direct: "BAL", na_item: "B6N" },
    label: "Renda disponible de les llars per habitant",
    unit: "EPA",
    kind: "currency",
    decimals: 0,
    source: "Eurostat, nama_10r_2hhinc",
  },
  {
    key: "unemployment",
    dataset: "lfst_r_lfu3rt",
    filter: { sex: "T", age: "Y20-64", isced11: "TOTAL", unit: "PC" },
    label: "Taxa d'atur",
    unit: "%",
    kind: "rate",
    decimals: 1,
    source: "Eurostat, lfst_r_lfu3rt",
  },
  {
    key: "life_expectancy",
    dataset: "demo_r_mlifexp",
    filter: { sex: "T", age: "Y_LT1", unit: "YR" },
    label: "Esperança de vida en néixer",
    unit: "anys",
    kind: "rate",
    decimals: 1,
    source: "Eurostat, demo_r_mlifexp",
  },
  {
    key: "tertiary_education",
    dataset: "edat_lfse_04",
    filter: { sex: "T", age: "Y25-64", isced11: "ED5-8", unit: "PC" },
    label: "Població amb estudis superiors",
    unit: "%",
    kind: "rate",
    decimals: 1,
    source: "Eurostat, edat_lfse_04",
  },
  {
    key: "tourist_nights",
    dataset: "tour_occ_nin2",
    filter: { unit: "NR", c_resid: "TOTAL", nace_r2: "I551-I553" },
    label: "Pernoctacions turístiques",
    unit: "nits",
    kind: "count",
    decimals: 0,
    source: "Eurostat, tour_occ_nin2",
  },
  {
    key: "birth_rate",
    dataset: "demo_r_gind3",
    filter: { indic_de: "GBIRTHRT" },
    label: "Taxa bruta de natalitat",
    unit: "‰",
    kind: "rate",
    decimals: 1,
    source: "Eurostat, demo_r_gind3",
  },
];

export const SOURCE_URL = "https://ec.europa.eu/eurostat/web/regions/database";

/**
 * Fetch one metric and return `{ year: { geoCode: value } }` keyed by raw
 * Eurostat geo codes. `keep` decides which geo codes survive.
 */
export async function fetchMetric(metric, keep) {
  const params = new URLSearchParams({ format: "JSON", lang: "en", ...metric.filter });
  const js = await fetchJson(`${BASE}${metric.dataset}?${params}`);

  const byYear = {};
  eachJsonStatCell(js, (key, value) => {
    const geo = key.geo;
    if (!keep(geo)) return;
    const year = key.time;
    (byYear[year] ||= {})[geo] = value;
  });
  return byYear;
}

/**
 * Remap `{year: {geo: v}}` onto app region ids via a geo→id lookup, rounding
 * to the metric's declared precision. Eurostat returns full float noise
 * (78.19999999999999); storing it would be both larger and falsely precise.
 */
export function remap(byYear, geoToId, decimals = 0) {
  const factor = 10 ** decimals;
  const out = {};
  for (const [year, byGeo] of Object.entries(byYear)) {
    const row = {};
    for (const [geo, v] of Object.entries(byGeo)) {
      const id = geoToId[geo];
      if (id !== undefined) row[id] = Math.round(v * factor) / factor;
    }
    if (Object.keys(row).length) out[year] = row;
  }
  return out;
}
