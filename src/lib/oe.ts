import { OE_BASE } from './config';
import { networkLocalIso, num } from './util';

export interface OeUnit {
    code: string;
    fueltech_id: string | null;
    status_id: string | null;
    capacity_registered: number | null;
    dispatch_type: string | null;
}

export interface OeFacility {
    code: string;
    name: string;
    network_id: string;
    network_region: string;
    lat: number;
    lng: number;
    units: OeUnit[];
    capacity: number;
}

export interface UnitReading {
    mw: number;
    time: string;
}

export interface RegionReading {
    imports: number | null;
    exports: number | null;
    price: number | null;
    demand: number | null;
    time: string | null;
}

/** Market time: the NEM runs on AEST (no daylight saving), the WEM on AWST. */
const NETWORK_OFFSET: Record<string, number> = { NEM: 10, WEM: 8 };
const MAX_CODES_PER_REQUEST = 30;

export class OeError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

async function oeGet(path: string, params: [string, string][], apiKey: string): Promise<any> {
    const qs = new URLSearchParams(params).toString();
    let res: Response;
    try {
        res = await fetch(`${OE_BASE}${path}${qs ? `?${qs}` : ''}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
    } catch (e) {
        throw new OeError(
            'Could not reach Open Electricity from the browser (network or cross-origin block).',
            0,
        );
    }
    if (res.status === 401 || res.status === 403) {
        throw new OeError('Open Electricity rejected the API key.', res.status);
    }
    if (res.status === 429) {
        throw new OeError('Open Electricity rate limit reached; try again later.', 429);
    }
    if (res.status === 404) {
        // The facility endpoint answers 404 when there is simply no data in the window.
        return { data: [] };
    }
    if (!res.ok) {
        throw new OeError(`Open Electricity returned HTTP ${res.status}.`, res.status);
    }
    const json = await res.json();
    if (json && json.success === false) {
        throw new OeError(String(json.error ?? 'Open Electricity error'), res.status);
    }
    return json;
}

export async function fetchFacilities(apiKey: string): Promise<OeFacility[]> {
    const json = await oeGet(
        '/facilities/',
        [
            ['status_id', 'operating'],
            ['status_id', 'commissioning'],
            ['network_id', 'NEM'],
            ['network_id', 'WEM'],
        ],
        apiKey,
    );
    const out: OeFacility[] = [];
    for (const f of json.data ?? []) {
        const loc = f.location ?? {};
        const lat = num(loc.lat ?? loc.latitude);
        const lng = num(loc.lng ?? loc.lon ?? loc.longitude);
        if (lat === null || lng === null || (lat === 0 && lng === 0)) {
            continue;
        }
        const units: OeUnit[] = (f.units ?? []).map((u: any) => ({
            code: String(u.code),
            fueltech_id: u.fueltech_id ?? null,
            status_id: u.status_id ?? null,
            capacity_registered: num(u.capacity_registered),
            dispatch_type: u.dispatch_type ?? null,
        }));
        // Count generating capacity once: a battery is listed as charge, discharge and/or bidirectional units.
        const capacity = units
            .filter(u => u.dispatch_type !== 'LOAD')
            .reduce((sum, u) => sum + (u.capacity_registered ?? 0), 0);
        out.push({
            code: String(f.code),
            name: String(f.name ?? f.code),
            network_id: String(f.network_id ?? 'NEM'),
            network_region: String(f.network_region ?? ''),
            lat,
            lng,
            units,
            capacity,
        });
    }
    return out;
}

/** Last non-null [time, value] pair of a series. */
function latest(data: unknown): { time: string; value: number } | null {
    if (!Array.isArray(data)) {
        return null;
    }
    for (let i = data.length - 1; i >= 0; i--) {
        const point = data[i];
        const time = Array.isArray(point) ? point[0] : point?.time ?? point?.interval;
        const value = num(Array.isArray(point) ? point[1] : point?.value);
        if (value !== null) {
            return { time: String(time), value };
        }
    }
    return null;
}

function windowStart(network: string, minutesBack: number): string {
    const offset = NETWORK_OFFSET[network] ?? 10;
    return networkLocalIso(new Date(Date.now() - minutesBack * 60_000), offset);
}

/**
 * Latest 5-minute output per unit (MW) for the given facilities.
 * The API accepts at most 30 facility codes per request, so this batches.
 */
export async function fetchUnitPower(
    apiKey: string,
    network: string,
    facilityCodes: string[],
): Promise<Map<string, UnitReading>> {
    const readings = new Map<string, UnitReading>();
    for (let i = 0; i < facilityCodes.length; i += MAX_CODES_PER_REQUEST) {
        const batch = facilityCodes.slice(i, i + MAX_CODES_PER_REQUEST);
        const params: [string, string][] = [
            ['metrics', 'power'],
            ['interval', '5m'],
            ['date_start', windowStart(network, 45)],
            ...batch.map(c => ['facility_code', c] as [string, string]),
        ];
        const json = await oeGet(`/data/facilities/${network}`, params, apiKey);
        for (const series of json.data ?? []) {
            if (series.metric && series.metric !== 'power') {
                continue;
            }
            for (const result of series.results ?? []) {
                const cols = result.columns ?? {};
                const unitCode =
                    cols.unit_code ?? cols.unit ?? String(result.name ?? '').replace(/^power_/, '');
                const point = latest(result.data);
                if (unitCode && point) {
                    readings.set(String(unitCode), { mw: point.value, time: point.time });
                }
            }
        }
    }
    return readings;
}

/** Latest regional imports/exports, price and demand for the NEM. One request. */
export async function fetchRegionReadings(apiKey: string): Promise<Map<string, RegionReading>> {
    const json = await oeGet(
        '/market/network/NEM',
        [
            ['metrics', 'flow_imports'],
            ['metrics', 'flow_exports'],
            ['metrics', 'price'],
            ['metrics', 'demand'],
            ['interval', '5m'],
            ['primary_grouping', 'network_region'],
            ['date_start', windowStart('NEM', 45)],
        ],
        apiKey,
    );
    const regions = new Map<string, RegionReading>();
    const get = (id: string): RegionReading => {
        if (!regions.has(id)) {
            regions.set(id, { imports: null, exports: null, price: null, demand: null, time: null });
        }
        return regions.get(id) as RegionReading;
    };
    for (const series of json.data ?? []) {
        const metric = String(series.metric ?? '');
        for (const result of series.results ?? []) {
            const cols = result.columns ?? {};
            const match = /(NSW1|QLD1|VIC1|SA1|TAS1)/.exec(
                String(cols.network_region ?? cols.region ?? result.name ?? ''),
            );
            const point = latest(result.data);
            if (!match || !point) {
                continue;
            }
            const r = get(match[1]);
            if (metric === 'flow_imports') {
                r.imports = Math.abs(point.value);
                r.time = point.time;
            } else if (metric === 'flow_exports') {
                r.exports = Math.abs(point.value);
                r.time = point.time;
            } else if (metric === 'price') {
                r.price = point.value;
            } else if (metric === 'demand') {
                r.demand = point.value;
            }
        }
    }
    return regions;
}

export interface CorridorFlow {
    id: string;
    /** Positive: flowing from the corridor's `from` region to its `to` region. */
    mw: number;
}

/**
 * Corridor flows derived from each region's net export.
 *
 * QLD and TAS each connect to one neighbour, so their figures are exact (before losses).
 * SA is shown as its total exchange. NSW–VIC is what remains of the NSW balance; with
 * Project EnergyConnect in service some of that is really NSW–SA, which regional data
 * alone cannot separate.
 */
export function deriveCorridorFlows(regions: Map<string, RegionReading>): CorridorFlow[] {
    const net = (id: string): number | null => {
        const r = regions.get(id);
        if (!r || r.imports === null || r.exports === null) {
            return null;
        }
        return r.exports - r.imports;
    };
    const qld = net('QLD1');
    const nsw = net('NSW1');
    const sa = net('SA1');
    const tas = net('TAS1');
    const flows: CorridorFlow[] = [];
    if (qld !== null) {
        flows.push({ id: 'QLD-NSW', mw: qld });
    }
    if (nsw !== null && qld !== null) {
        flows.push({ id: 'NSW-VIC', mw: nsw + qld });
    }
    if (sa !== null) {
        flows.push({ id: 'VIC-SA', mw: -sa });
    }
    if (tas !== null) {
        flows.push({ id: 'TAS-VIC', mw: tas });
    }
    return flows;
}
