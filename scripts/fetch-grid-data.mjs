// Downloads the Geoscience Australia "National Electricity Infrastructure" layers and writes a
// compact snapshot to data/grid.json. The plugin loads that snapshot (GitHub serves it with
// permissive cross-origin headers; the GA service itself cannot be fetched from windy.com).
//
// Run with: node scripts/fetch-grid-data.mjs        (Node 18+, no dependencies)

import { mkdirSync, writeFileSync } from 'node:fs';

const SERVICE =
    'https://services.ga.gov.au/gis/rest/services/National_Electricity_Infrastructure/MapServer';
const OUT_DIR = process.env.GRID_OUT_DIR || 'data';
const PAGE_SIZE = 2000;
const MAX_PAGES = 30;
const DROP_FIELDS = /^(objectid|fid|shape.*|ga_guid|globalid|featuretype|st_length.*|se_anno.*)$/i;

async function getJson(url, attempt = 1) {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'windy-plugin-au-grid data fetch' } });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        if (json && json.error) {
            throw new Error(json.error.message || 'service error');
        }
        return json;
    } catch (e) {
        if (attempt < 4) {
            await new Promise(r => setTimeout(r, attempt * 3000));
            return getJson(url, attempt + 1);
        }
        throw new Error(`${e.message} for ${url}`);
    }
}

async function discoverLayers() {
    const ids = { substations: 0, stations: 1, lines: 2 };
    const meta = await getJson(`${SERVICE}?f=json`);
    for (const layer of meta.layers ?? []) {
        const name = String(layer.name ?? '');
        console.log(`  layer ${layer.id}: ${name}`);
        if (/line/i.test(name)) ids.lines = layer.id;
        else if (/sub\s*station/i.test(name)) ids.substations = layer.id;
        else if (/power\s*station|generat/i.test(name)) ids.stations = layer.id;
    }
    return ids;
}

function queryUrl(layerId, offset, simplifyDeg) {
    const p = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        returnGeometry: 'true',
        outSR: '4326',
        geometryPrecision: '4',
        f: 'geojson',
        resultOffset: String(offset),
        resultRecordCount: String(PAGE_SIZE),
    });
    if (simplifyDeg) p.set('maxAllowableOffset', String(simplifyDeg));
    return `${SERVICE}/${layerId}/query?${p}`;
}

const round = n => Math.round(n * 1e4) / 1e4;
function roundCoords(c) {
    return typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(roundCoords);
}

function slim(feature) {
    const properties = {};
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
        if (DROP_FIELDS.test(key) || value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        properties[key] = typeof value === 'string' ? value.trim() : value;
    }
    return {
        type: 'Feature',
        geometry: { type: feature.geometry.type, coordinates: roundCoords(feature.geometry.coordinates) },
        properties,
    };
}

async function fetchLayer(layerId, simplifyDeg) {
    const seen = new Set();
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
        const json = await getJson(queryUrl(layerId, page * PAGE_SIZE, simplifyDeg));
        const features = json.features ?? [];
        let added = 0;
        for (const f of features) {
            const p = f.properties ?? {};
            const id = f.id ?? p.OBJECTID ?? p.objectid ?? p.GA_GUID ?? p.ga_guid ?? `i${out.length}`;
            if (!f.geometry || seen.has(String(id))) continue;
            seen.add(String(id));
            out.push(slim(f));
            added++;
        }
        console.log(`  layer ${layerId} page ${page}: ${features.length} returned, ${added} new`);
        if (features.length < PAGE_SIZE || added === 0) break;
    }
    return out;
}

function tally(features, key) {
    const counts = {};
    for (const f of features) {
        const found = Object.keys(f.properties).find(k => k.toLowerCase() === key.toLowerCase());
        const v = found === undefined ? '(missing)' : String(f.properties[found]);
        counts[v] = (counts[v] ?? 0) + 1;
    }
    return Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([v, n]) => `${v}: ${n}`)
        .join(', ');
}

function describe(label, features, tallies) {
    const keys = new Set();
    features.forEach(f => Object.keys(f.properties).forEach(k => keys.add(k)));
    console.log(`\n${label}: ${features.length} features`);
    console.log(`  fields: ${[...keys].join(', ')}`);
    for (const key of tallies) console.log(`  ${key} -> ${tally(features, key)}`);
    if (features[0]) console.log(`  sample: ${JSON.stringify(features[0].properties)}`);
}

console.log('Discovering layers...');
const ids = await discoverLayers();
console.log('Using', JSON.stringify(ids));

// ~50 m tolerance on lines: invisible at grid scale, much smaller to download and draw.
const lines = await fetchLayer(ids.lines, 0.0005);
const substations = await fetchLayer(ids.substations, null);
const stations = await fetchLayer(ids.stations, null);

describe('Lines', lines, ['CAPACITYKV', 'OPERATIONALSTATUS', 'CLASS', 'STATE']);
const dc = lines.filter(f => /basslink|murraylink|directlink|terranora|marinus|hvdc|\bdc (link|cable|line)\b/i.test(JSON.stringify(f.properties)));
console.log(`  HVDC name matches: ${dc.length} -> ${[...new Set(dc.map(f => f.properties.NAME ?? f.properties.name))].join(' | ')}`);
describe('Substations', substations, ['VOLTAGEKV', 'OPERATIONALSTATUS', 'CLASS', 'STATE']);
describe('Power stations', stations, ['PRIMARYFUELTYPE', 'OPERATIONALSTATUS', 'STATE']);

if (lines.length < 100 || stations.length < 50) {
    throw new Error('Suspiciously little data returned; not writing a snapshot.');
}

const snapshot = {
    meta: {
        source: SERVICE,
        attribution: '© Commonwealth of Australia (Geoscience Australia)',
        fetched: new Date().toISOString().slice(0, 10),
        counts: { lines: lines.length, substations: substations.length, stations: stations.length },
    },
    lines,
    substations,
    stations,
};
mkdirSync(OUT_DIR, { recursive: true });
const body = JSON.stringify(snapshot);
writeFileSync(`${OUT_DIR}/grid.json`, body);
console.log(`\nWrote ${OUT_DIR}/grid.json (${(body.length / 1e6).toFixed(2)} MB)`);
