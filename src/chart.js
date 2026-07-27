import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
import { CATEGORICAL, isDark, token } from "./palette.js";
import { formatCompact, formatValue } from "./format.js";

// Non-map views over the same datasets.
//
// `drawTrend` is the reason the data rebuild prioritised annual depth: it
// indexes every region to 100 at a common base year so places of very
// different size can share one axis. Emphasis carries the story — every
// region is drawn, a handful are highlighted — which keeps the chart honest
// about the distribution instead of cherry-picking four lines.

const NS = "http://www.w3.org/2000/svg";
export const CW = 900;
export const CH = 560;
const PAD = { top: 76, right: 132, bottom: 54, left: 64 };

const el = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const text = (attrs, content) =>
  Object.assign(el("text", attrs), { textContent: content });

function frame(svg, title, subtitle, source) {
  svg.appendChild(
    text(
      {
        x: PAD.left,
        y: 30,
        "font-size": "19",
        "font-weight": "700",
        fill: token("--ink"),
      },
      title
    )
  );
  svg.appendChild(
    text(
      {
        x: PAD.left,
        y: 50,
        "font-size": "12.5",
        "font-style": "italic",
        fill: token("--ink-secondary"),
      },
      subtitle
    )
  );
  if (source) {
    svg.appendChild(
      text(
        { x: PAD.left, y: CH - 8, "font-size": "10.5", fill: token("--ink-muted") },
        source
      )
    );
  }
}

function axes(svg, x, y, yTicks, formatY) {
  const grid = el("g");
  for (const t of yTicks) {
    grid.appendChild(
      el("line", {
        x1: PAD.left,
        x2: CW - PAD.right,
        y1: y(t).toFixed(1),
        y2: y(t).toFixed(1),
        stroke: token("--grid"),
        "stroke-width": "1",
      })
    );
    grid.appendChild(
      text(
        {
          x: PAD.left - 10,
          y: (y(t) + 4).toFixed(1),
          "text-anchor": "end",
          "font-size": "11",
          fill: token("--ink-muted"),
          style: "font-variant-numeric: tabular-nums",
        },
        formatY(t)
      )
    );
  }
  svg.appendChild(grid);

  const [x0, x1] = x.domain();
  const span = x1 - x0;
  const stepChoices = [1, 2, 5, 10, 20, 25, 50];
  const step = stepChoices.find((s) => span / s <= 9) || 50;
  const ticks = [];
  for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) ticks.push(t);

  const axis = el("g");
  for (const t of ticks) {
    axis.appendChild(
      text(
        {
          x: x(t).toFixed(1),
          y: CH - PAD.bottom + 20,
          "text-anchor": "middle",
          "font-size": "11",
          fill: token("--ink-muted"),
          style: "font-variant-numeric: tabular-nums",
        },
        String(t)
      )
    );
  }
  axis.appendChild(
    el("line", {
      x1: PAD.left,
      x2: CW - PAD.right,
      y1: CH - PAD.bottom,
      y2: CH - PAD.bottom,
      stroke: token("--axis"),
      "stroke-width": "1",
    })
  );
  svg.appendChild(axis);
}

/**
 * Indexed multi-line chart.
 *
 * @param {object} opts
 * @param {SVGElement} opts.svg Cleared target.
 * @param {object} opts.dataset Indicator descriptor.
 * @param {object} opts.labels Region id → name.
 * @param {string[]} opts.highlight Region ids to draw as series.
 * @param {boolean} opts.indexed Index to 100 at the base year.
 * @param {string} opts.title
 */
export function drawTrend({ svg, dataset, labels, highlight, indexed, title }) {
  const years = Object.keys(dataset.values)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (years.length < 2) {
    svg.appendChild(
      text(
        { x: CW / 2, y: CH / 2, "text-anchor": "middle", fill: token("--ink-muted") },
        "Aquest indicador només té un any de dades."
      )
    );
    return;
  }

  const baseYear = years[0];
  const series = [];
  for (const [id, name] of Object.entries(labels)) {
    const base = dataset.values[baseYear]?.[id];
    if (indexed && !Number.isFinite(base)) continue;
    const points = [];
    for (const year of years) {
      const v = dataset.values[year]?.[id];
      if (!Number.isFinite(v)) continue;
      points.push([year, indexed ? (v / base) * 100 : v]);
    }
    if (points.length > 1) series.push({ id, name, points });
  }
  if (series.length === 0) return;

  const picked = highlight.filter((id) => series.some((s) => s.id === id));
  const mode = isDark() ? "dark" : "light";
  const colours = CATEGORICAL[mode];

  const allY = series.flatMap((s) => s.points.map((p) => p[1]));
  const x = d3.scaleLinear().domain([years[0], years.at(-1)]).range([PAD.left, CW - PAD.right]);
  const y = d3
    .scaleLinear()
    .domain([Math.min(...allY), Math.max(...allY)])
    .nice()
    .range([CH - PAD.bottom, PAD.top]);

  const subtitle = indexed
    ? `Índex: 100 = ${baseYear}. Dades anuals ${years[0]}–${years.at(-1)}.`
    : `${dataset.label} en ${dataset.unit}. Dades anuals ${years[0]}–${years.at(-1)}.`;
  frame(svg, title, subtitle, `Font: ${dataset.source}`);
  axes(svg, x, y, y.ticks(6), (t) => formatCompact(t, indexed ? null : dataset));

  const line = d3
    .line()
    .x((p) => x(p[0]))
    .y((p) => y(p[1]));

  // Every region is drawn. The unhighlighted ones recede to a hairline so the
  // reader still sees the whole distribution behind the story.
  const backdrop = el("g", {
    fill: "none",
    stroke: token("--ink-muted"),
    "stroke-width": "1",
    opacity: "0.24",
  });
  for (const s of series) {
    if (picked.includes(s.id)) continue;
    backdrop.appendChild(el("path", { d: line(s.points) }));
  }
  svg.appendChild(backdrop);

  if (indexed) {
    svg.appendChild(
      el("line", {
        x1: PAD.left,
        x2: CW - PAD.right,
        y1: y(100).toFixed(1),
        y2: y(100).toFixed(1),
        stroke: token("--axis"),
        "stroke-width": "1",
      })
    );
  }

  const ends = [];
  picked.forEach((id, i) => {
    const s = series.find((v) => v.id === id);
    const colour = colours[i % colours.length];
    svg.appendChild(
      el("path", {
        d: line(s.points),
        fill: "none",
        stroke: colour,
        "stroke-width": "2",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      })
    );
    const last = s.points.at(-1);
    svg.appendChild(
      el("circle", {
        cx: x(last[0]).toFixed(1),
        cy: y(last[1]).toFixed(1),
        r: "4",
        fill: colour,
        stroke: token("--surface"),
        "stroke-width": "2",
      })
    );
    ends.push({
      name: s.name,
      value: last[1],
      y: y(last[1]),
      anchorY: y(last[1]),
      colour,
    });
  });

  // Direct end labels are the relief channel for the light-mode contrast
  // warning on slots 3 and 4, so they are not optional. Each label is a name
  // over a value, so it needs the full two-line height to clear its
  // neighbour; a leader line reconnects any label that had to move.
  const LABEL_HEIGHT = 30;
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].y - ends[i - 1].y < LABEL_HEIGHT) {
      ends[i].y = ends[i - 1].y + LABEL_HEIGHT;
    }
  }
  for (const e of ends) {
    if (Math.abs(e.y - e.anchorY) > 3) {
      svg.appendChild(
        el("path", {
          d: `M${CW - PAD.right + 4},${e.anchorY.toFixed(1)}L${CW - PAD.right + 8},${e.y.toFixed(1)}`,
          stroke: e.colour,
          "stroke-width": "1",
          fill: "none",
          opacity: "0.6",
        })
      );
    }
    svg.appendChild(
      text(
        {
          x: CW - PAD.right + 10,
          y: (e.y + 4).toFixed(1),
          "font-size": "11.5",
          "font-weight": "600",
          fill: token("--ink"),
        },
        e.name
      )
    );
    svg.appendChild(
      text(
        {
          x: CW - PAD.right + 10,
          y: (e.y + 18).toFixed(1),
          "font-size": "10.5",
          fill: token("--ink-muted"),
          style: "font-variant-numeric: tabular-nums",
        },
        indexed ? e.value.toFixed(0) : formatCompact(e.value, dataset)
      )
    );
  }

  addCrosshair({ svg, x, y, series, picked, colours, years, dataset, indexed });
  return { x, y, series, picked, colours, baseYear };
}

/**
 * Crosshair over the plot. Snapping to the nearest year gives a hit target the
 * full height of the plot instead of a 2px line, which is what makes a
 * multi-line chart readable at all.
 */
function addCrosshair({ svg, x, y, series, picked, colours, years, dataset, indexed }) {
  const layer = el("g", { "pointer-events": "none", opacity: "0" });
  const rule = el("line", {
    y1: PAD.top,
    y2: CH - PAD.bottom,
    stroke: token("--axis"),
    "stroke-width": "1",
  });
  layer.appendChild(rule);
  const dots = picked.map(() =>
    el("circle", { r: "4.5", stroke: token("--surface"), "stroke-width": "2" })
  );
  for (const d of dots) layer.appendChild(d);
  svg.appendChild(layer);

  const hit = el("rect", {
    x: PAD.left,
    y: PAD.top,
    width: CW - PAD.right - PAD.left,
    height: CH - PAD.bottom - PAD.top,
    fill: "transparent",
  });
  svg.appendChild(hit);

  const tip = document.getElementById("tooltip");
  hit.addEventListener("pointermove", (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * CW;
    const year = years.reduce((best, yr) =>
      Math.abs(x(yr) - px) < Math.abs(x(best) - px) ? yr : best
    );

    layer.setAttribute("opacity", "1");
    rule.setAttribute("x1", x(year).toFixed(1));
    rule.setAttribute("x2", x(year).toFixed(1));

    const rows = [];
    picked.forEach((id, i) => {
      const s = series.find((v) => v.id === id);
      const point = s?.points.find((p) => p[0] === year);
      if (!point) {
        dots[i].setAttribute("opacity", "0");
        return;
      }
      dots[i].setAttribute("opacity", "1");
      dots[i].setAttribute("cx", x(year).toFixed(1));
      dots[i].setAttribute("cy", y(point[1]).toFixed(1));
      dots[i].setAttribute("fill", colours[i % colours.length]);
      rows.push(
        `<div class="t-row">${s.name}: ` +
          `${indexed ? point[1].toFixed(1) : formatValue(point[1], dataset)}</div>`
      );
    });

    tip.innerHTML = `<div class="t-name">${year}</div>${rows.join("")}`;
    tip.dataset.show = "true";
    const rect = tip.getBoundingClientRect();
    let left = event.clientX + 14;
    if (left + rect.width > innerWidth - 8) left = event.clientX - rect.width - 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.min(event.clientY + 14, innerHeight - rect.height - 8)}px`;
  });

  hit.addEventListener("pointerleave", () => {
    layer.setAttribute("opacity", "0");
    tip.dataset.show = "false";
  });
}

/**
 * Ranked bar chart. Nominal categories, so every bar takes the same hue —
 * colouring bars by their own value would spend the identity channel
 * re-encoding what bar length already shows.
 */
export function drawRanking({ svg, dataset, labels, values, title, limit = 22 }) {
  const rows = Object.entries(values)
    .filter(([, v]) => Number.isFinite(v))
    .map(([id, v]) => ({ id, name: labels[id] || id, value: v }))
    .sort((a, b) => b.value - a.value);

  if (rows.length === 0) return;
  const shown = rows.slice(0, limit);

  const left = 168;
  const right = 92;
  const top = 76;
  const bottom = 34;
  const band = (CH - top - bottom) / shown.length;
  const thickness = Math.min(24, band - 6);

  const subtitle =
    rows.length > limit
      ? `${shown.length} de ${rows.length} regions, ordenades de més a menys.`
      : `Totes les regions, ordenades de més a menys.`;
  frame(svg, title, subtitle, `Font: ${dataset.source}`);

  const max = Math.max(...shown.map((r) => r.value), 0);
  const min = Math.min(0, ...shown.map((r) => r.value));
  const x = d3.scaleLinear().domain([min, max]).nice().range([left, CW - right]);
  const colour = CATEGORICAL[isDark() ? "dark" : "light"][0];

  const zero = x(Math.max(0, min));
  shown.forEach((row, i) => {
    const cy = top + band * i + band / 2;
    const w = Math.abs(x(row.value) - zero);

    // 4px rounded data-end, square at the baseline.
    const bx = row.value >= 0 ? zero : zero - w;
    const r = Math.min(4, w);
    const y0 = cy - thickness / 2;
    const path =
      row.value >= 0
        ? `M${bx},${y0}H${bx + w - r}a${r},${r} 0 0 1 ${r},${r}V${y0 + thickness - r}a${r},${r} 0 0 1 ${-r},${r}H${bx}Z`
        : `M${bx + r},${y0}H${bx + w}V${y0 + thickness}H${bx + r}a${r},${r} 0 0 1 ${-r},${-r}V${y0 + r}a${r},${r} 0 0 1 ${r},${-r}Z`;

    const bar = el("path", { d: path, fill: colour });
    bar.dataset.region = row.id;
    svg.appendChild(bar);

    svg.appendChild(
      text(
        {
          x: left - 12,
          y: (cy + 4).toFixed(1),
          "text-anchor": "end",
          "font-size": "11.5",
          fill: token("--ink-secondary"),
        },
        row.name.length > 24 ? `${row.name.slice(0, 23)}…` : row.name
      )
    );
    svg.appendChild(
      text(
        {
          x: (row.value >= 0 ? bx + w + 8 : bx - 8).toFixed(1),
          y: (cy + 4).toFixed(1),
          "text-anchor": row.value >= 0 ? "start" : "end",
          "font-size": "11",
          fill: token("--ink-muted"),
          style: "font-variant-numeric: tabular-nums",
        },
        formatValue(row.value, dataset)
      )
    );
  });
  return { rows };
}
