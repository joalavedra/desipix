import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// Colour tokens and scales.
//
// The map spends colour on the *indicator*, not on region identity: tile
// count carries the weight variable, tile fill carries the value. That means
// every map scale here is sequential or diverging, never categorical.
// Categorical slots exist only for the trend chart, where a handful of
// highlighted regions are separate series.

const SEQUENTIAL = {
  // One hue, light to dark. Dark mode flips the anchor so low values sit
  // nearest the surface in both themes.
  light: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  dark: ["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"],
};

const DIVERGING_POLES = { low: "#e34948", high: "#2a78d6" };
const NEUTRAL = { light: "#f0efec", dark: "#383835" };

// Line-chart series. Validated adjacent in both modes: worst CVD dE 9.1
// light / 8.4 dark, worst normal-vision dE 22.9 / 19.8. The light steps sit
// below 3:1 on the surface, so highlighted lines always carry a direct end
// label and a legend entry.
export const CATEGORICAL = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500"],
};

export const BIN_COUNT = 7;

export function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

/**
 * Build a colour scale for one dataset.
 *
 * `index` datasets are centred on 100 and get the diverging pair, because the
 * story is which side of the national average a region sits on. Everything
 * else is magnitude, so it gets the single-hue sequential ramp binned by
 * quantile — regional data is heavily skewed and equal-width bins would leave
 * six of seven classes empty.
 *
 * @param {object} dataset The dataset descriptor (needs `kind`).
 * @param {number[]} values Every value in the current slice.
 * @returns {{of: Function, bins: object[], type: string}}
 */
export function scaleFor(dataset, values) {
  const mode = isDark() ? "dark" : "light";
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length === 0) {
    return { of: () => NEUTRAL[mode], bins: [], type: "empty" };
  }

  if (dataset.kind === "index") return divergingScale(clean, mode);
  return sequentialScale(clean, mode);
}

function sequentialScale(sorted, mode) {
  const ramp = SEQUENTIAL[mode];
  const cuts = [];
  for (let i = 1; i < BIN_COUNT; i++) {
    cuts.push(d3.quantileSorted(sorted, i / BIN_COUNT));
  }

  const of = (v) => {
    if (!Number.isFinite(v)) return null;
    let i = 0;
    while (i < cuts.length && v > cuts[i]) i++;
    return ramp[i];
  };

  const bins = ramp.map((color, i) => ({
    color,
    from: i === 0 ? sorted[0] : cuts[i - 1],
    to: i === ramp.length - 1 ? sorted.at(-1) : cuts[i],
  }));
  return { of, bins, type: "sequential" };
}

function divergingScale(sorted, mode) {
  const centre = 100;
  const spread = Math.max(
    Math.abs(sorted[0] - centre),
    Math.abs(sorted.at(-1) - centre),
    1
  );
  const arm = (BIN_COUNT - 1) / 2;
  const low = d3.interpolateLab(NEUTRAL[mode], DIVERGING_POLES.low);
  const high = d3.interpolateLab(NEUTRAL[mode], DIVERGING_POLES.high);

  const step = spread / arm;
  const bins = [];
  for (let i = arm; i >= 1; i--) {
    bins.push({
      color: low(i / arm),
      from: centre - i * step,
      to: centre - (i - 1) * step,
    });
  }
  bins.push({ color: NEUTRAL[mode], from: centre - step / 2, to: centre + step / 2 });
  for (let i = 1; i <= arm; i++) {
    bins.push({
      color: high(i / arm),
      from: centre + (i - 1) * step,
      to: centre + i * step,
    });
  }

  const of = (v) => {
    if (!Number.isFinite(v)) return null;
    const offset = (v - centre) / step;
    if (Math.abs(offset) < 0.5) return NEUTRAL[mode];
    const level = Math.min(arm, Math.ceil(Math.abs(offset)));
    return offset < 0 ? low(level / arm) : high(level / arm);
  };
  return { of, bins, type: "diverging" };
}

/** Ink for a label sitting on top of a filled mark. */
export function inkOn(fill) {
  const { r, g, b } = d3.rgb(fill);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? "#0b0b0b" : "#ffffff";
}

export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
