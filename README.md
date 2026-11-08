# BigMoves – Accra trotro route finder (prototype)

A mobile web app that shows which trotros to take between two places in Greater Accra, where to change, and a likely journey time **range**. Prototype for the 25 October 2026 review; see `BigMoves_PRD.docx`.

## Run it

```bash
python pipeline/build_network.py     # raw data -> web/data/*.json   (only needed when data changes)
npm run serve                        # http://localhost:8080  (same as: python -m http.server 8080 --directory web)
npm test                             # 12 sample trips through the real router
node tests/validate_time_model.mjs   # time model v0 vs measured 2021 trips
```

No build step. `web/` is a static site. Deploy it as is to GitHub Pages, Netlify, Vercel or any static host. It needs HTTPS for offline mode.

## How it works

| Stage (PRD §9) | Where |
|---|---|
| 1. Source data | `recftfc_contactusformjosephghana/` (GUMAP 2021, from TfC), `data_external/` (Accra GTFS 2015, OSM places) |
| 2. Clean + build graph | `pipeline/build_network.py` → `web/data/network.json` (about 400 KB gzipped). Audit counts go to `docs/data_audit.json` |
| 3. Routing | `web/js/router.js`, frequency-based RAPTOR, up to 2 changes, walking transfers ≤ 400 m |
| 4. Travel-time estimate | `web/js/timeModel.js` + `web/data/time_model_v0.json` (replaceable module) |
| 5. Mobile web map | `web/index.html`, `web/js/app.js`, `web/js/search.js`, Leaflet + OSM tiles |

**Pipeline clean-up steps:**
- Shared-taxi routes are dropped.
- Stop IDs are made stable and prefixed by source: `tfc:` (2021) and `am15:` (2015).
- Route shapes are oriented to match the stop order.
- Stops lying more than 400 m off their own route's GPS trace are removed. These are survey mis-tags.
- Unserved stops are removed.
- Placeholder 2015 route names (single letters, "NULL") are repaired from the terminal stop names.
- Survey numbers are stripped from 2015 stop names.
- Walking links are created between stops within 400 m.
- Each stop is tagged with its district.
- Stops named after a town but lying more than 3 km from it are demoted in search.

**Time model v0:**
- The estimate is ride time between stops (by time band) + 15 s dwell per stop + waiting time (+ walking).
- Ride times are scaled by factors from 590 measured 2021 onboard trips.
- Waiting at a starting terminal uses measured loading times. At roadside stops, waiting is based on the route's headway.
- The range covers the 10th to 90th percentile of measured variation.
- Leg ranges combine as independent errors.
- Results are in `docs/time_model_validation.md`. On a hold-out test (calibrated on June, tested on July–August), the actual time fell inside the range 77% of the time. The mid-estimate's error was 20 min, against 25.6 min for the raw schedule.

## Data sources and licences

| Source | Coverage | Collected | Licence |
|---|---|---|---|
| GUMAP Accra trotro GTFS and surveys ([TfC data portal](https://data.transportforcairo.com/catalogue/#/document/189)). Attribution: *Transport for Cairo and Transitec Consulting Engineers, for the Ministry of Local Government, Decentralization, and Rural Development (Ghana). Financed by the Swiss Confederation.* | 98 trotro routes, outer GAMA | Jun–Aug 2021 | CC BY 4.0 |
| [Accra GTFS](https://datacatalog.worldbank.org/search/dataset/0038230/accra-ghana-general-transit-feed-specification-gtfs), Accra Mobility / World Bank Data Catalog | 651 trotro routes, central Accra | May–Jun 2015 | CC BY 4.0 |
| OpenStreetMap (Overpass extract of named places) and map tiles | Greater Accra | Oct 2026 | ODbL 1.0 |

Credits appear in the app's About panel and in the map attribution.

## Known limits

- Route data is from 2015 and 2021 surveys, so some routes and stops will have changed.
- Central-Accra (2015) routes have no frequency data, so a typical headway is assumed. Their ride-time spread is borrowed from the 2021 routes.
- The 2021 schedule was built from the same surveys used for calibration. Independent field checks are still needed.
- Coverage gaps remain. Some known corridors (e.g. Dodowa–Madina direct) are missing from the data.

## Folder map

```
pipeline/        data build script
web/             the app (static site)          web/data/  built data the phone downloads
tests/           sample trips + time-model validation
docs/            sample_trips.md, time_model_validation.md, data_audit.json
data_external/   downloaded open data (Accra GTFS 2015, OSM places)
```
