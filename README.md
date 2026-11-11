# windy-plugin-au-grid

Australian power grid overlay for Windy.com.

- **Power lines** coloured by voltage: 500 kV yellow, 330 kV orange, 275 kV purple,
  220 kV blue, 110–132 kV red, HVDC links green, anything lower grey.
- **Substations** (ringed in their voltage colour) and **power stations** (small dots coloured
  by fuel).
- **Tap or click anything** for its details.
- Lines under 220 kV appear from zoom 6; lines under 110 kV and smaller substations from zoom 8.
- **Name labels** appear as you zoom in: large power stations first, then all stations, then
  220 kV+ substations and lines, then everything. Stations and substations show the name with MW or
  kV beneath; lines show "name · kV" written along the line. Labels that would overlap are left
  out, biggest assets first. Each kind has its own switch. Thresholds are `LABEL_ZOOM` in
  `src/lib/overlay.ts`.
- A **voltage tick box** switches that voltage's lines and its substations together (power
  stations are unaffected). Substations with no recorded voltage count as "Below 110 kV".
- While the plugin is open, taps on the map go to the plugin; a tap that misses the grid is handed
  back to Windy's weather picker.

This repository is Windy's official
[plugin template](https://github.com/windycom/windy-plugin-template) (v5.0.1) with the plugin
in `src/`.

## Publish and install

1. Repository secret `WINDY_API_KEY` (Settings → Secrets and variables → Actions) holds a
   "Windy Plugins API" key from api.windy.com/keys.
2. Actions tab → `publish-plugin` → Run workflow. It builds the plugin and uploads it to Windy.
   The install URL is printed at the end of the "Publish Plugin" step.
3. In Windy: Menu → Install Windy plugin, and paste the URL.

The plugin is marked `private: true` in `src/pluginConfig.ts`, so it installs by link and does
not appear in the public gallery. Bump `version` there before each re-publish.

## Grid data

The network comes from Geoscience Australia's
[Electricity Infrastructure](https://services.ga.gov.au/gis/rest/services/Electricity_Infrastructure/MapServer)
service (power lines, substations, major power stations of 5 MW and above).
© Commonwealth of Australia (Geoscience Australia), CC BY 4.0.

The plugin does not query that service on every load. `scripts/fetch-grid-data.mjs` copies the
three layers into `data/grid.json`, and the plugin downloads that one file from GitHub. If the
file cannot be reached it falls back to the GA service.

The copy refreshes itself every Monday morning (Sydney time) through the `update-grid-data`
workflow, so changes Geoscience Australia makes, such as a line moving from "Under Construction"
to "Operational", reach the plugin within a week. To refresh sooner: Actions tab →
`update-grid-data` → Run workflow. No republish is needed.

The file is only rewritten when the network has changed. GitHub pauses scheduled workflows in
public repos after 60 days without activity, so if nothing has been committed for 45 days the
workflow commits a one-line `data/last-checked.txt` to keep itself running.

HVDC links are identified by name, because the data has no AC/DC field: Basslink
("Basslink-Loy Yang to Basslink-George Town"), Murraylink ("Monash to Red Cliffs Terminal") and
Directlink ("Mullumbimby to Bungalora"). The list is in `src/lib/config.ts`.

## Live generation and flows: written but switched off

The code for live output and regional flows (from the Open Electricity API) is in `src/lib/oe.ts`
but disabled by `LIVE_DATA_ENABLED = false` in `src/lib/config.ts`. Open Electricity rejects
cross-origin requests from windy.com, so a browser plugin cannot call it directly. Enabling live
data needs a relay that fetches server-side, for example a scheduled GitHub Action that writes a
small JSON file next to `data/grid.json`.

Power flow on individual transmission lines is not published by AEMO. What is published is flow
on each interconnector between NEM regions, plus regional price and demand.

## Develop locally (computer with Node.js)

1. `npm install`, then `npm start`. This serves the plugin at `https://localhost:9999/plugin.js`.
   Open that address once in your browser and accept the self-signed certificate.
2. Open `https://www.windy.com/developer-mode` and load that URL.

## Limits

- Locations are indicative; each feature carries GA's own 1–5 location-confidence rating.
