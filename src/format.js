// Value formatting driven by each dataset's declared `kind`.
//
// The old build summed every dataset for its footer readout, which is only
// meaningful for counts. Summing a set of unemployment rates or per-capita
// incomes produces a number with no referent, so `aggregate` picks a
// population-weighted mean for rates and indices instead.

const CA = "ca-ES";

export function formatValue(value, dataset) {
  if (!Number.isFinite(value)) return "—";
  const decimals = dataset.decimals ?? 0;
  const n = value.toLocaleString(CA, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return dataset.unit ? `${n} ${dataset.unit}` : n;
}

/** Short form for axis ticks and legends, where space is tight. */
export function formatCompact(value, dataset) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} M`;
  if (abs >= 10_000) return `${Math.round(value / 1000)} k`;
  const decimals = dataset?.decimals ?? 0;
  return value.toLocaleString(CA, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Collapse a slice to one headline number.
 *
 * Counts sum. Rates, currencies-per-head and indices are averaged, weighted
 * by the weight variable when one is available, because an unweighted mean of
 * regional rates over-counts small regions.
 *
 * @returns {{value: number, label: string}}
 */
export function aggregate(values, dataset, weights) {
  const entries = Object.entries(values).filter(([, v]) => Number.isFinite(v));
  if (entries.length === 0) return { value: NaN, label: "Sense dades" };

  if (dataset.kind === "count") {
    return {
      value: entries.reduce((sum, [, v]) => sum + v, 0),
      label: "Total",
    };
  }

  let num = 0;
  let den = 0;
  for (const [id, v] of entries) {
    const w = weights && Number.isFinite(weights[id]) ? weights[id] : 1;
    num += v * w;
    den += w;
  }
  return {
    value: den > 0 ? num / den : NaN,
    label: weights ? "Mitjana ponderada" : "Mitjana",
  };
}

export function formatYear(year) {
  return year === "—" || year === undefined ? "" : String(year);
}
