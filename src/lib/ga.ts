import { GA_SERVICE, SNAPSHOT_URLS } from './config';
import type { Props } from './util';

export interface Feature {
    type: 'Feature';
    id?: string | number;
    geometry: { type: string; coordinates: any } | null;
    properties: Props;
}

export interface GaData {
    lines: Feature[];
    substations: Feature[];
    stations: Feature[];
    warnings: string[];
    /** Date (YYYY-MM-DD) the data was copied from GA, when loaded from the repo snapshot. */
    snapshotDate: string | null;
}

const PAGE_SIZE = 2000;
const MAX_PAGES = 25;

async function getJson(url: string): Promise<any> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Geoscience Australia service returned HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json && json.error) {
        throw new Error(json.error.message || 'Geoscience Australia service error');
    }
    return json;
}

/** Layer ids are looked up by name so a re-ordering of the service does not break the plugin. */
async function discoverLayers(): Promise<{ lines: number; substations: number; stations: number }> {
    const ids = { substations: 0, stations: 1, lines: 2 };
    try {
        const meta = await getJson(`${GA_SERVICE}?f=json`);
        for (const layer of meta.layers ?? []) {
            const name = String(layer.name ?? '');
            if (/line/i.test(name)) {
                ids.lines = layer.id;
            } else if (/sub\s*station/i.test(name)) {
                ids.substations = layer.id;
            } else if (/power\s*station|generat/i.test(name)) {
                ids.stations = layer.id;
            }
        }
    } catch (e) {
        // Fall back to the ids the service had when this plugin was written.
    }
    return ids;
}

function queryUrl(layerId: number, offset: number | null, simplifyDeg: number | null): string {
    const p = new URLSearchParams({
        where: '1=1',
        outFields: '*',
        returnGeometry: 'true',
        outSR: '4326',
        geometryPrecision: '5',
        f: 'geojson',
    });
    if (simplifyDeg) {
        p.set('maxAllowableOffset', String(simplifyDeg));
    }
    if (offset !== null) {
        p.set('resultOffset', String(offset));
        p.set('resultRecordCount', String(PAGE_SIZE));
    }
    return `${GA_SERVICE}/${layerId}/query?${p.toString()}`;
}

function featureKey(f: Feature, index: number): string {
    const p = f.properties ?? {};
    const id = f.id ?? p.OBJECTID ?? p.objectid ?? p.GA_GUID ?? p.ga_guid;
    return id !== undefined && id !== null ? String(id) : `i${index}`;
}

async function fetchLayer(
    layerId: number,
    simplifyDeg: number | null,
    warnings: string[],
    label: string,
): Promise<Feature[]> {
    const seen = new Set<string>();
    const out: Feature[] = [];

    for (let page = 0; page < MAX_PAGES; page++) {
        let json: any;
        try {
            json = await getJson(queryUrl(layerId, page * PAGE_SIZE, simplifyDeg));
        } catch (e) {
            if (page > 0) {
                warnings.push(`${label}: stopped after ${out.length} features (${(e as Error).message}).`);
                break;
            }
            // Paging may be unsupported: take whatever a single un-paged request returns.
            json = await getJson(queryUrl(layerId, null, simplifyDeg));
            const single: Feature[] = json.features ?? [];
            if (single.length >= PAGE_SIZE) {
                warnings.push(`${label}: service returned its maximum of ${PAGE_SIZE}; some may be missing.`);
            }
            return single.filter(f => f && f.geometry);
        }

        const features: Feature[] = json.features ?? [];
        let added = 0;
        features.forEach((f, i) => {
            const key = featureKey(f, out.length + i);
            if (f && f.geometry && !seen.has(key)) {
                seen.add(key);
                out.push(f);
                added++;
            }
        });
        if (features.length < PAGE_SIZE || added === 0) {
            break;
        }
    }
    return out;
}

/** The pre-built copy of the data in this plugin's GitHub repo: one request, served compressed. */
async function loadSnapshot(): Promise<GaData> {
    let lastError: Error = new Error('no snapshot address configured');
    for (const url of SNAPSHOT_URLS) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const json = await res.json();
            if (!Array.isArray(json.lines) || !json.lines.length || !Array.isArray(json.stations)) {
                throw new Error('snapshot is empty');
            }
            return {
                lines: json.lines,
                substations: Array.isArray(json.substations) ? json.substations : [],
                stations: json.stations,
                warnings: [],
                snapshotDate: json.meta?.fetched ?? null,
            };
        } catch (e) {
            lastError = e as Error;
        }
    }
    throw lastError;
}

async function loadFromService(): Promise<GaData> {
    const warnings: string[] = [];
    const ids = await discoverLayers();
    const [lines, substations, stations] = await Promise.all([
        // ~50 m tolerance: invisible at grid scale, much lighter to draw.
        fetchLayer(ids.lines, 0.0005, warnings, 'Lines'),
        fetchLayer(ids.substations, null, warnings, 'Substations'),
        fetchLayer(ids.stations, null, warnings, 'Power stations'),
    ]);
    return { lines, substations, stations, warnings, snapshotDate: null };
}

let cache: Promise<GaData> | null = null;

/** Loads the grid once per page load; reopening the plugin reuses the result. */
export function loadGaData(): Promise<GaData> {
    if (!cache) {
        cache = (async () => {
            try {
                return await loadSnapshot();
            } catch (snapshotError) {
                try {
                    return await loadFromService();
                } catch (serviceError) {
                    throw new Error(
                        `the data snapshot (${(snapshotError as Error).message}) and the ` +
                            `Geoscience Australia service (${(serviceError as Error).message}) ` +
                            `were both unreachable`,
                    );
                }
            }
        })();
        cache.catch(() => {
            cache = null;
        });
    }
    return cache;
}
