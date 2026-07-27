# desipix

Tile cartograms in the browser, built from real geography plus real data.

A region's **size** is set by a weight variable (population by default) and its
**colour** by whichever indicator you pick, so one map carries two variables at
once. Region identity comes from labels and the tooltip, never from fill colour.

Three geographies — **Espanya** (comunitats autònomes), **Catalunya**
(comarques i Aran), **Europa** (NUTS-2) — and three views:

- **Mapa** — a tile cartogram, a Dorling circle map, or a non-contiguous
  scaled map of the real polygons.
- **Evolució** — every region indexed to 100 at a common base year on one
  axis, with a few highlighted and direct-labelled.
- **Rànquing** — regions ordered by the current indicator.

Everything is in Catalan. State lives in the URL, so any view is shareable.

## Run

Pure static site, no build step:

```sh
python3 -m http.server 8765 --directory .
# http://localhost:8765
```

## Data

Eight indicators per geography, chosen for annual depth rather than breadth.

| geography | source | span |
|---|---|---|
| Espanya | Eurostat (CCAA map 1:1 onto Spanish NUTS-2) | up to 1990–2025 |
| Catalunya | Idescat Taules v2 | up to 1998–2025 |
| Europa | Eurostat | up to 1991–2025 |

Rebuild any of them; each script keeps the hand-curated `regions` block and
rewrites only `datasets`:

```sh
node tools/build-spain.mjs
node tools/build-catalonia.mjs
node tools/build-europe.mjs
```

Catalunya deliberately does **not** use Idescat's EMEX API. EMEX is the obvious
choice and carries 230 indicators per comarca, but only for the latest year,
which is useless for time series. Taules v2 serves the same statistics as full
annual series.

Each dataset declares a `kind` (`count`, `rate`, `currency`, `index`) that
drives how it is formatted, whether it can size tiles, and whether the headline
figure is a sum or a population-weighted mean. Only counts can size a mark.

Coverage is uneven on the Europe map by design: the UK left the NUTS programme
after 2020 and some regions were recoded between vintages, so around 45 of 291
regions have no recent values. They render as a faint silhouette rather than
vanishing.

## How the cartogram works

`src/cartogram.js`, in order:

1. Project and rasterize the geography into a square-tile land mask.
2. Flood-fill empty space from outside the bounding box. Anything the fill
   cannot reach is enclosed by land, so it is a rasterization pinhole and gets
   filled. This is what stops white gaps opening along interior borders.
3. Resize each connected component to exactly its tile budget by peeling the
   most peninsular cells or filling the deepest concavities — outer boundary
   only, so resizing can never punch a hole.
4. Grow every region outward from its geographic seed, cheapest cell first
   across the whole map, stopping the moment it hits its tile target.
5. Repair any region left short, then relax with Lloyd iterations for
   compactness.

Step 4 is what makes it a cartogram rather than a coloured map: tile counts
come from the data, not from area. Barcelonès holds 29% of Catalonia's
population in 146 km² and gets 29% of the tiles.

Distance in step 4 is deliberately **unweighted**. Scaling cost by
`1/sqrt(target)` also produces correct sizes, but the cells are
multiplicatively-weighted Voronoi regions, which are not convex: measured
compactness on the Catalan map was 2.29x an equal-area disc, against 1.34x
unweighted, at identical allocation error.

Regions do move. A cartogram of a concentrated population has no choice —
Barcelona's metro comarques hold about 60% of Catalonia's people on 5% of its
land, in a coastal corner, so they can only grow inland.

### Checking it

`tools/verify.html` builds all three geographies and reports allocation error,
compactness and geographic drift. Serve the repo and open
`/tools/verify.html`. Current numbers, population, 2024/2025:

| geography | mean alloc. error | compactness | mean drift |
|---|---|---|---|
| Espanya | 0.5% | 1.18 | 4.5% |
| Catalunya | 0.0% | 1.34 | 3.7% |
| Europa | 0.2% | 2.02 | 8.0% |

Compactness is mean radius over that of an equal-area disc (1.0 is a perfect
disc). Drift is the distance from a region's true centroid to its blob
centroid, as a share of the map diagonal.

## Colour

Map fills use a single-hue sequential ramp binned by quantile, or a diverging
blue-red ramp centred on 100 for index-kind datasets. The dark theme re-anchors
the ramp rather than inverting it. Chart series use a categorical palette
validated for colour-vision deficiency in both themes (worst adjacent pair
ΔE 9.1 light / 8.4 dark, OKLab ×100).

Every view has a table twin under "Veure les dades en una taula", so no value
is reachable only through colour.

## Layout

```
index.html          UI shell, design tokens, light/dark themes
src/main.js         state, URL sync, wiring, PNG export
src/cartogram.js    projections + the tile allocator
src/map.js          tile / Dorling / scaled renderers
src/chart.js        indexed line chart, ranked bars
src/palette.js      colour tokens and scales
src/format.js       value formatting and aggregation by dataset kind
data/               geojson + per-geography datasets
tools/              dataset builders + the verification harness
```

## Sources

- Spain CCAA boundaries: [click_that_hood](https://github.com/codeforgermany/click_that_hood)
- Catalonia comarques: [ArnauInes/geometries_cat_bcn_2024](https://github.com/ArnauInes/geometries_cat_bcn_2024) (ICC)
- Europe NUTS-2 boundaries: Eurostat GISCO
- Spain and Europe indicators: [Eurostat](https://ec.europa.eu/eurostat/web/regions/database)
- Catalonia indicators: [Idescat Taules v2](https://www.idescat.cat/dev/api/taules/)
