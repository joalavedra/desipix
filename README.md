# desipix

Tile cartograms in the browser, built from real geography + a data weight.

Three geographies: **Espanya** (CCAA), **Catalunya** (comarques), **Europa** (NUTS-2 across EU-27 + UK + EFTA). Three modes per geography:

- **Equilibrat** — tile cartogram with amplified inequalities. Each region's tile count is proportional to its data value (with a power transform that exaggerates the spread), then tiles are arranged to roughly preserve geographic position. Cities are drawn as a darker shade of the region colour.
- **Diferències** — Dorling cartogram. Each region is one circle, area ∝ value, placed at the geographic centroid with force-collide so they don't overlap.
- **Escalat** — non-contiguous cartogram. Faded base map shows true geography; each region's real polygon is scaled around its centroid by `sqrt(value / max)`.

Multi-year datasets where available (Eurostat 2014–2024 for Europe; INE/IDESCAT for Spain/Catalonia). All labels in Catalan.

## Run

It's a pure static site — open `index.html` over any local web server:

```sh
python3 -m http.server 8765 --directory .
# then open http://localhost:8765
```

## Data sources

- **Spain CCAA boundaries**: [click_that_hood](https://github.com/codeforgermany/click_that_hood)
- **Catalonia comarques**: [ArnauInes/geometries_cat_bcn_2024](https://github.com/ArnauInes/geometries_cat_bcn_2024) (ICC)
- **Europe NUTS-2 boundaries**: Eurostat GISCO
- **Europe demographics**: Eurostat `demo_r_pjanaggr3` (population) and `lfst_r_lfu3pers` (unemployment), fetched via `tools/fetch-eurostat.mjs`
- **Spain demographics**: INE (curated)
- **Catalonia demographics**: IDESCAT (curated)

## Layout

```
index.html               UI shell
src/main.js              render dispatchers + mode logic
src/cartogram.js         tile-cartogram algorithm (projection → rasterize → redistribute → smooth)
data/                    geojson + per-geography datasets json
```
