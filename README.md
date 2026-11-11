# windy-plugin-au-grid

Australian power grid overlay for Windy.com.

- **Transmission lines** coloured by voltage: 500 kV yellow, 330 kV orange, 275 kV purple,
  220 kV blue, 110–132 kV red, HVDC links green, anything lower grey.
- **Substations** and **generators** (coloured by fuel, sized by capacity).
- **Tap or click anything** for its details.
- **Live generation** per unit and **live flows between NEM regions** (needs a free
  Open Electricity API key).

## Status: not yet run inside Windy

The data and map logic in `src/lib` is type-checked and passes a test with a mocked map and
mocked API responses, and every map call it makes exists in Windy's LeafletGL type
definitions. It has **not** yet been built or run inside Windy, and the two live data services
were not reachable from where it was written. Expect a round of fixes on first run; the things
most likely to need adjusting are listed under "Unverified" below.

This repository is Windy's official
[plugin template](https://github.com/windycom/windy-plugin-template) (v5.0.1) with the plugin
in `src/`.

## Publish and install (no computer needed)

1. In this repository on GitHub: Settings → Secrets and variables → Actions → New repository
   secret. Name it `WINDY_API_KEY` and paste your Windy API key as the value.
2. Actions tab → `publish-plugin` → Run workflow. It builds the plugin and uploads it to Windy.
3. Install the plugin in Windy (Menu → Install Windy plugin) using the URL from the workflow
   run's "Publish Plugin" step.

The plugin is marked `private: true` in `src/pluginConfig.ts`, so it installs by link and does
not appear in the public gallery. Bump `version` there before each re-publish.

## Develop locally (computer with Node.js)

1. `npm install`, then `npm start`. This serves the plugin at `https://localhost:9999/plugin.js`.
   Open that address once in your browser and accept the self-signed certificate.
2. Open `https://www.windy.com/developer-mode` and load that URL.

## Live data

Paste an Open Electricity API key (from platform.openelectricity.org.au) into the panel and
press Connect. The key is stored only in your browser's local storage.

- Generators then come from Open Electricity (NEM and WEM), with unit-level output.
  Geoscience Australia stations with no Open Electricity match within 3 km (NT, off-grid WA)
  stay on the map without live data.
- "Refresh live data" loads regional flows (1 request) and the 90 largest generators in
  view (up to 3 requests). Tapping a generator loads just that one.
- Open Electricity data is licensed CC BY-NC 4.0 (non-commercial).

## About flows on lines

Power flow on individual transmission lines is not published by AEMO, so it cannot be shown.
What is available is each NEM region's imports and exports every 5 minutes. The plugin turns
those into four corridor flows:

| Corridor | How it is worked out | Accuracy |
|---|---|---|
| QLD ↔ NSW | QLD net export | Exact before losses (QLD has one neighbour) |
| TAS ↔ VIC | TAS net export | Exact before losses (Basslink only) |
| SA ↔ VIC | SA net export | Total SA exchange; includes Project EnergyConnect |
| NSW ↔ VIC | NSW net export plus QLD net export | Approximate once EnergyConnect carries NSW–SA flow |

AEMO does publish the flow on each named interconnector, but only as zipped CSV files that a
browser plugin cannot read directly. A small proxy server would unlock that.

## Unverified

- **Windy map API.** Windy 49+ uses "LeafletGL" (a Leaflet-style API over MapLibre). The plugin
  uses `L.GeoJSON`, `L.CircleMarker`, `L.Marker` + div icon, `L.FeatureGroup`, `L.Popup` and
  layer `click` events. All are listed in the LeafletGL docs, but option support
  (`dashArray`, `onEachFeature`) was not confirmed.
- **Open Electricity response shapes.** Parsed defensively from the documented types
  (`data[].results[].columns` and `data[].results[].data` as `[time, value]` pairs).
  Whether the 5-minute interval is accepted for `flow_imports` / `flow_exports` was not confirmed.
- **Browser access (CORS)** to `api.openelectricity.org.au` and `services.ga.gov.au` from
  windy.com was not confirmed. If the browser blocks either one, the panel says so.
- **HVDC detection** is by line name (Basslink, Murraylink, Directlink/Terranora), because the
  source data has no AC/DC field.
- **Drawing speed** with every line visible on a phone. Lines under 220 kV only appear from
  zoom 6, lines under 110 kV and substations from zoom 8; these thresholds are in
  `src/lib/config.ts`.

## Data sources

- Geoscience Australia, National Electricity Infrastructure (lines, substations, power stations).
  © Commonwealth of Australia (Geoscience Australia).
- Open Electricity API v4 (facilities, 5-minute power, regional flows), from AEMO data.
