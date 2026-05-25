// Fetch population, GDP, unemployment for our NUTS-2 regions from Eurostat.
import fs from "node:fs";

const geo = JSON.parse(
  fs.readFileSync("/Users/joanalavedra/pixelmaps/data/europe-nuts2.geojson", "utf8")
);
const targetIds = new Set(geo.features.map((f) => f.properties.id));
console.log("target NUTS-2 IDs:", targetIds.size);

const BASE = "https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data/";

async function fetchTsv(dataset, query) {
  const url = `${BASE}${dataset}/${query}?format=TSV`;
  console.log("GET", url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${dataset}: HTTP ${r.status}`);
  return await r.text();
}

// TSV format: first column is "key1,key2,...\\geo\\TIME_PERIOD"
// then header row has years, then data rows.
function parseTsv(tsv) {
  const lines = tsv.trim().split("\n");
  const header = lines[0].split("\t");
  // header[0] is the dimension descriptor, header[1..] are time periods
  const periods = header.slice(1).map((p) => p.trim());
  const dataRows = lines.slice(1).map((line) => {
    const [keyStr, ...vals] = line.split("\t");
    return { key: keyStr.split(","), values: vals.map((v) => v.trim()) };
  });
  return { periods, dataRows, dimDesc: header[0] };
}

function pickValue(values, periods, preferOrder) {
  for (const p of preferOrder) {
    const i = periods.indexOf(p);
    if (i === -1) continue;
    const raw = values[i];
    if (!raw || raw === ":" || raw.startsWith(":")) continue;
    const num = parseFloat(raw.replace(/[a-z\s]+$/i, ""));
    if (isFinite(num)) return num;
  }
  return null;
}

// Collect values for every year in WANTED_YEARS where data exists.
// Each row's value list is parallel to `periods`.
function collectYears(values, periods, wantedYears) {
  const out = {};
  for (const y of wantedYears) {
    const i = periods.indexOf(y);
    if (i === -1) continue;
    const raw = values[i];
    if (!raw || raw === ":" || raw.startsWith(":")) continue;
    const num = parseFloat(raw.replace(/[a-z\s]+$/i, ""));
    if (isFinite(num)) out[y] = num;
  }
  return out;
}

const WANTED_YEARS = ["2024","2023","2022","2021","2020","2019","2018","2017","2016","2015","2014"];

async function getPopulation() {
  const tsv = await fetchTsv("demo_r_pjanaggr3", "");
  const { periods, dataRows, dimDesc } = parseTsv(tsv);
  console.log("pop dim:", dimDesc, "periods:", periods.slice(-5));
  const dims = dimDesc.split("\\")[0].split(",");
  const geoIdx = dims.indexOf("geo");
  const sexIdx = dims.indexOf("sex");
  const ageIdx = dims.indexOf("age");
  const unitIdx = dims.indexOf("unit");
  // out[year][geo] = number
  const out = {};
  for (const row of dataRows) {
    if (row.key[sexIdx] !== "T") continue;
    if (row.key[ageIdx] !== "TOTAL") continue;
    if (row.key[unitIdx] !== "NR") continue;
    const geo = row.key[geoIdx];
    if (!targetIds.has(geo)) continue;
    const yearVals = collectYears(row.values, periods, WANTED_YEARS);
    for (const [y, v] of Object.entries(yearVals)) {
      if (!out[y]) out[y] = {};
      out[y][geo] = v;
    }
  }
  carryForward(out, targetIds);
  return out;
}

// For each region, fill missing year values by carrying forward the most
// recent prior value. Then back-fill earliest values from earliest available.
function carryForward(out, targetIds) {
  const allYears = Object.keys(out).sort();
  for (const geo of targetIds) {
    let last = null;
    for (const y of allYears) {
      if (!out[y]) out[y] = {};
      if (out[y][geo] != null) last = out[y][geo];
      else if (last != null) out[y][geo] = last;
    }
    // backfill earliest gaps
    last = null;
    for (let i = allYears.length - 1; i >= 0; i--) {
      const y = allYears[i];
      if (out[y][geo] != null) last = out[y][geo];
      else if (last != null) out[y][geo] = last;
    }
  }
}

async function getGdp() {
  // nama_10r_2gdp — GDP at current market prices, NUTS 2
  const tsv = await fetchTsv("nama_10r_2gdp", "");
  const { periods, dataRows, dimDesc } = parseTsv(tsv);
  console.log("gdp dim:", dimDesc, "periods:", periods.slice(-5));
  const dims = dimDesc.split("\\")[0].split(",");
  const geoIdx = dims.indexOf("geo");
  const unitIdx = dims.indexOf("unit");
  const out = {};
  const tryYears = ["2023","2022","2021","2020","2019","2018","2017"];
  for (const row of dataRows) {
    // unit MIO_EUR (millions of euro, current prices)
    if (row.key[unitIdx] !== "MIO_EUR") continue;
    const geo = row.key[geoIdx];
    if (!targetIds.has(geo)) continue;
    const v = pickValue(row.values, periods, tryYears);
    if (v != null) out[geo] = v;
  }
  return out;
}

async function getUnemployed() {
  const tsv = await fetchTsv("lfst_r_lfu3pers", "");
  const { periods, dataRows, dimDesc } = parseTsv(tsv);
  console.log("unemp dim:", dimDesc, "periods:", periods.slice(-5));
  const dims = dimDesc.split("\\")[0].split(",");
  const geoIdx = dims.indexOf("geo");
  const sexIdx = dims.indexOf("sex");
  const ageIdx = dims.indexOf("age");
  const unitIdx = dims.indexOf("unit");
  const out = {};
  for (const row of dataRows) {
    if (sexIdx !== -1 && row.key[sexIdx] !== "T") continue;
    if (ageIdx !== -1 && row.key[ageIdx] !== "Y15-74") continue;
    if (unitIdx !== -1 && row.key[unitIdx] !== "THS_PER") continue;
    const geo = row.key[geoIdx];
    if (!targetIds.has(geo)) continue;
    const yearVals = collectYears(row.values, periods, WANTED_YEARS);
    for (const [y, v] of Object.entries(yearVals)) {
      if (!out[y]) out[y] = {};
      out[y][geo] = v * 1000;
    }
  }
  carryForward(out, targetIds);
  return out;
}

const [pop, unemp] = await Promise.all([
  getPopulation(),
  getUnemployed(),
]);

console.log("pop years:", Object.keys(pop).sort());
console.log("unemp years:", Object.keys(unemp).sort());
const latestPopYear = Object.keys(pop).sort().slice(-1)[0];
const latestUnempYear = Object.keys(unemp).sort().slice(-1)[0];
console.log("pop coverage @", latestPopYear, ":", Object.keys(pop[latestPopYear] || {}).length, "/", targetIds.size);
console.log("unemp coverage @", latestUnempYear, ":", Object.keys(unemp[latestUnempYear] || {}).length, "/", targetIds.size);

// Build labels (country code + name)
const labels = {};
const countries = {};
for (const f of geo.features) {
  labels[f.properties.id] = f.properties.name;
  countries[f.properties.id] = f.properties.country;
}

// Country-color palette (one color per country, by index)
const palette = [
  "#e6194B","#3cb44b","#ffe119","#4363d8","#f58231","#911eb4","#42d4f4","#f032e6",
  "#bfef45","#fabed4","#469990","#dcbeff","#9A6324","#fffac8","#800000","#aaffc3",
  "#808000","#ffd8b1","#000075","#a9a9a9","#e6beff","#fab8b8","#0e7c7b","#7a4f01",
  "#ff6f61","#5a4e7c","#1f6e8c","#bf3a2b","#d4b483","#264653","#2a9d8f","#e76f51"
];
const countryColors = {};
const countryList = [...new Set(Object.values(countries))].sort();
countryList.forEach((c, i) => { countryColors[c] = palette[i % palette.length]; });

// Per-region color = country color (so each country reads as one zone)
const colors = {};
for (const id of Object.keys(labels)) {
  colors[id] = countryColors[countries[id]];
}

// Catalan country names for ISO codes used in the legend and map labels.
const countryNamesCa = {
  AT: "Àustria", BE: "Bèlgica", BG: "Bulgària", CH: "Suïssa", CY: "Xipre",
  CZ: "Txèquia", DE: "Alemanya", DK: "Dinamarca", EE: "Estònia", EL: "Grècia",
  ES: "Espanya", FI: "Finlàndia", FR: "França", HR: "Croàcia", HU: "Hongria",
  IE: "Irlanda", IS: "Islàndia", IT: "Itàlia", LI: "Liechtenstein", LT: "Lituània",
  LU: "Luxemburg", LV: "Letònia", MT: "Malta", NL: "Països Baixos", NO: "Noruega",
  PL: "Polònia", PT: "Portugal", RO: "Romania", SE: "Suècia", SI: "Eslovènia",
  SK: "Eslovàquia", UK: "Regne Unit",
};

// Curated biggest-city-per-NUTS-2 (only for regions where one dominant city exists)
const cities = {
  "AT13": { name: "Viena", lon: 16.37, lat: 48.20, population: 1982000 },
  "AT22": { name: "Graz", lon: 15.44, lat: 47.07, population: 290000 },
  "AT32": { name: "Salzburg", lon: 13.05, lat: 47.80, population: 155000 },
  "AT33": { name: "Innsbruck", lon: 11.40, lat: 47.27, population: 132000 },
  "BE10": { name: "Brussel·les", lon: 4.35, lat: 50.85, population: 1230000 },
  "BE21": { name: "Anvers", lon: 4.40, lat: 51.22, population: 530000 },
  "BE34": { name: "Lieja", lon: 5.57, lat: 50.63, population: 195000 },
  "BG33": { name: "Varna", lon: 27.92, lat: 43.21, population: 335000 },
  "BG41": { name: "Sofia", lon: 23.32, lat: 42.70, population: 1240000 },
  "BG42": { name: "Plovdiv", lon: 24.74, lat: 42.14, population: 345000 },
  "CH04": { name: "Zuric", lon: 8.55, lat: 47.37, population: 420000 },
  "CH01": { name: "Ginebra", lon: 6.14, lat: 46.20, population: 200000 },
  "CY00": { name: "Nicòsia", lon: 33.36, lat: 35.17, population: 270000 },
  "CZ01": { name: "Praga", lon: 14.43, lat: 50.07, population: 1380000 },
  "CZ06": { name: "Brno", lon: 16.61, lat: 49.20, population: 380000 },
  "DE11": { name: "Stuttgart", lon: 9.18, lat: 48.78, population: 630000 },
  "DE21": { name: "Munic", lon: 11.58, lat: 48.14, population: 1490000 },
  "DE30": { name: "Berlín", lon: 13.40, lat: 52.52, population: 3760000 },
  "DE50": { name: "Bremen", lon: 8.81, lat: 53.08, population: 570000 },
  "DE60": { name: "Hamburg", lon: 10.00, lat: 53.55, population: 1900000 },
  "DE71": { name: "Frankfurt", lon: 8.68, lat: 50.11, population: 770000 },
  "DE92": { name: "Hannover", lon: 9.73, lat: 52.37, population: 540000 },
  "DEA1": { name: "Düsseldorf", lon: 6.78, lat: 51.23, population: 620000 },
  "DEA2": { name: "Colònia", lon: 6.96, lat: 50.94, population: 1080000 },
  "DED5": { name: "Leipzig", lon: 12.37, lat: 51.34, population: 615000 },
  "DED2": { name: "Dresden", lon: 13.74, lat: 51.05, population: 560000 },
  "DK01": { name: "Copenhaguen", lon: 12.57, lat: 55.68, population: 1330000 },
  "DK04": { name: "Aarhus", lon: 10.20, lat: 56.16, population: 285000 },
  "EE00": { name: "Tallinn", lon: 24.75, lat: 59.44, population: 460000 },
  "EL30": { name: "Atenes", lon: 23.73, lat: 37.98, population: 3000000 },
  "EL52": { name: "Tessalònica", lon: 22.94, lat: 40.64, population: 800000 },
  "ES11": { name: "Vigo", lon: -8.72, lat: 42.24, population: 293000 },
  "ES21": { name: "Bilbao", lon: -2.93, lat: 43.26, population: 348000 },
  "ES30": { name: "Madrid", lon: -3.70, lat: 40.42, population: 3400000 },
  "ES51": { name: "Barcelona", lon: 2.17, lat: 41.39, population: 1664000 },
  "ES52": { name: "València", lon: -0.38, lat: 39.47, population: 807000 },
  "ES61": { name: "Sevilla", lon: -5.98, lat: 37.39, population: 684000 },
  "FI1B": { name: "Hèlsinki", lon: 24.94, lat: 60.17, population: 660000 },
  "FR10": { name: "París", lon: 2.35, lat: 48.86, population: 2160000 },
  "FRC1": { name: "Dijon", lon: 5.04, lat: 47.32, population: 158000 },
  "FRE1": { name: "Lilla", lon: 3.06, lat: 50.63, population: 235000 },
  "FRF1": { name: "Estrasburg", lon: 7.75, lat: 48.58, population: 285000 },
  "FRG0": { name: "Nantes", lon: -1.55, lat: 47.22, population: 320000 },
  "FRH0": { name: "Rennes", lon: -1.68, lat: 48.11, population: 220000 },
  "FRI1": { name: "Bordeus", lon: -0.58, lat: 44.84, population: 260000 },
  "FRJ1": { name: "Montpeller", lon: 3.88, lat: 43.61, population: 295000 },
  "FRJ2": { name: "Tolosa", lon: 1.45, lat: 43.60, population: 480000 },
  "FRK2": { name: "Lió", lon: 4.84, lat: 45.76, population: 520000 },
  "FRL0": { name: "Marsella", lon: 5.37, lat: 43.30, population: 870000 },
  "FRM0": { name: "Aiacciu", lon: 8.74, lat: 41.93, population: 71000 },
  "HR05": { name: "Zagreb", lon: 15.98, lat: 45.81, population: 770000 },
  "HU11": { name: "Budapest", lon: 19.04, lat: 47.50, population: 1700000 },
  "IE06": { name: "Dublín", lon: -6.27, lat: 53.35, population: 590000 },
  "IS00": { name: "Reykjavík", lon: -21.94, lat: 64.15, population: 135000 },
  "ITC1": { name: "Torí", lon: 7.69, lat: 45.07, population: 850000 },
  "ITC3": { name: "Gènova", lon: 8.95, lat: 44.41, population: 565000 },
  "ITC4": { name: "Milà", lon: 9.19, lat: 45.46, population: 1370000 },
  "ITF3": { name: "Nàpols", lon: 14.27, lat: 40.85, population: 920000 },
  "ITF4": { name: "Bari", lon: 16.87, lat: 41.13, population: 320000 },
  "ITG1": { name: "Palerm", lon: 13.36, lat: 38.12, population: 640000 },
  "ITG2": { name: "Càller", lon: 9.12, lat: 39.22, population: 150000 },
  "ITH3": { name: "Venècia", lon: 12.34, lat: 45.44, population: 260000 },
  "ITH5": { name: "Bolonya", lon: 11.34, lat: 44.49, population: 390000 },
  "ITI1": { name: "Florència", lon: 11.26, lat: 43.77, population: 365000 },
  "ITI4": { name: "Roma", lon: 12.50, lat: 41.90, population: 2870000 },
  "LT01": { name: "Vílnius", lon: 25.28, lat: 54.69, population: 590000 },
  "LU00": { name: "Luxemburg", lon: 6.13, lat: 49.61, population: 130000 },
  "LV00": { name: "Riga", lon: 24.11, lat: 56.95, population: 605000 },
  "MT00": { name: "La Valletta", lon: 14.51, lat: 35.90, population: 200000 },
  "NL32": { name: "Amsterdam", lon: 4.90, lat: 52.37, population: 870000 },
  "NL33": { name: "Rotterdam", lon: 4.48, lat: 51.92, population: 650000 },
  "NL31": { name: "Utrecht", lon: 5.12, lat: 52.09, population: 360000 },
  "NO08": { name: "Oslo", lon: 10.75, lat: 59.91, population: 700000 },
  "PL21": { name: "Cracòvia", lon: 19.94, lat: 50.06, population: 780000 },
  "PL51": { name: "Wrocław", lon: 17.04, lat: 51.11, population: 670000 },
  "PL63": { name: "Gdańsk", lon: 18.65, lat: 54.35, population: 470000 },
  "PL71": { name: "Łódź", lon: 19.46, lat: 51.75, population: 670000 },
  "PL91": { name: "Varsòvia", lon: 21.01, lat: 52.23, population: 1860000 },
  "PT11": { name: "Porto", lon: -8.61, lat: 41.15, population: 230000 },
  "PT17": { name: "Lisboa", lon: -9.14, lat: 38.72, population: 545000 },
  "RO11": { name: "Cluj-Napoca", lon: 23.60, lat: 46.77, population: 325000 },
  "RO32": { name: "Bucarest", lon: 26.10, lat: 44.43, population: 1880000 },
  "SE11": { name: "Estocolm", lon: 18.07, lat: 59.33, population: 980000 },
  "SE22": { name: "Malmö", lon: 13.00, lat: 55.61, population: 350000 },
  "SE23": { name: "Göteborg", lon: 11.97, lat: 57.71, population: 580000 },
  "SI04": { name: "Ljubljana", lon: 14.51, lat: 46.05, population: 285000 },
  "SK01": { name: "Bratislava", lon: 17.11, lat: 48.15, population: 440000 },
  "UKD3": { name: "Manchester", lon: -2.24, lat: 53.48, population: 555000 },
  "UKD6": { name: "Liverpool", lon: -2.99, lat: 53.41, population: 500000 },
  "UKE3": { name: "Sheffield", lon: -1.47, lat: 53.38, population: 580000 },
  "UKE4": { name: "Leeds", lon: -1.55, lat: 53.80, population: 790000 },
  "UKG3": { name: "Birmingham", lon: -1.90, lat: 52.49, population: 1140000 },
  "UKI3": { name: "Londres", lon: -0.13, lat: 51.51, population: 9000000 },
  "UKK1": { name: "Bristol", lon: -2.59, lat: 51.45, population: 470000 },
  "UKM7": { name: "Edimburg", lon: -3.19, lat: 55.95, population: 540000 },
  "UKM8": { name: "Glasgow", lon: -4.25, lat: 55.86, population: 635000 },
  "UKN0": { name: "Belfast", lon: -5.93, lat: 54.60, population: 345000 },
};

const out = {
  regions: { key: "id", labels, colors, countries, countryNames: countryNamesCa, cities },
  datasets: {
    population: {
      label: "Població",
      unit: "persones",
      values: pop,
    },
    unemployed: {
      label: "Persones a l'atur",
      unit: "persones",
      values: unemp,
    },
  },
};

fs.writeFileSync(
  "/Users/joanalavedra/pixelmaps/data/europe-datasets.json",
  JSON.stringify(out, null, 0)
);
console.log("wrote europe-datasets.json:", fs.statSync("/Users/joanalavedra/pixelmaps/data/europe-datasets.json").size);
