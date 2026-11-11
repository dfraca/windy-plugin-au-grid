/** Geoscience Australia: Electricity Infrastructure (power lines, substations, power stations). */
export const GA_SERVICE =
    'https://services.ga.gov.au/gis/rest/services/Electricity_Infrastructure/MapServer';

/**
 * Snapshot of the GA layers kept in this plugin's GitHub repo (see scripts/fetch-grid-data.mjs).
 * One compressed download instead of several paged queries; the live service is the fallback.
 */
export const SNAPSHOT_URLS = [
    'https://raw.githubusercontent.com/dfraca/windy-plugin-au-grid/main/data/grid.json',
    'https://cdn.jsdelivr.net/gh/dfraca/windy-plugin-au-grid@main/data/grid.json',
];

/**
 * Live generation and flows are switched off: api.openelectricity.org.au rejects cross-origin
 * requests from windy.com ("Disallowed CORS origin"), so a browser plugin cannot call it
 * directly. Turning this on needs a relay that fetches the data server-side.
 */
export const LIVE_DATA_ENABLED = false;

/** Open Electricity (formerly OpenNEM) API: live generation and flows for the NEM and WEM. */
export const OE_BASE = 'https://api.openelectricity.org.au/v4';

export type VoltageClass = 'hvdc' | '500' | '330' | '275' | '220' | '132' | 'other';

export interface VoltageStyle {
    id: VoltageClass;
    label: string;
    color: string;
    weight: number;
    /** Lines of this class are hidden below this zoom so the national view stays readable. */
    minZoom: number;
}

/** Drawn in this order, so the highest voltages end up on top. */
export const VOLTAGE_STYLES: VoltageStyle[] = [
    { id: 'other', label: 'Below 110 kV', color: '#9aa0a6', weight: 1, minZoom: 8 },
    { id: '132', label: '110–132 kV', color: '#e53935', weight: 1.5, minZoom: 6 },
    { id: '220', label: '220 kV', color: '#2f7bff', weight: 2, minZoom: 0 },
    { id: '275', label: '275 kV', color: '#a040e0', weight: 2, minZoom: 0 },
    { id: '330', label: '330 kV', color: '#ff8c00', weight: 2.5, minZoom: 0 },
    { id: '500', label: '500 kV', color: '#ffd400', weight: 3, minZoom: 0 },
    { id: 'hvdc', label: 'HVDC link', color: '#22c55e', weight: 3, minZoom: 0 },
];

export const VOLTAGE_BY_ID: Record<VoltageClass, VoltageStyle> = Object.fromEntries(
    VOLTAGE_STYLES.map(s => [s.id, s]),
) as Record<VoltageClass, VoltageStyle>;

/**
 * The source data has no AC/DC attribute, so the DC links are picked out by how GA names them:
 * Basslink is "Basslink-Loy Yang to Basslink-George Town" (the only 400 kV feature), Murraylink
 * is "Monash to Red Cliffs Terminal" and Directlink is "Mullumbimby to Bungalora".
 */
const HVDC_LINKS: { name: string; pattern: RegExp }[] = [
    { name: 'Basslink', pattern: /basslink-.*basslink-/i },
    { name: 'Murraylink', pattern: /murraylink|monash to red cliffs|red cliffs( terminal)? to monash/i },
    { name: 'Directlink', pattern: /directlink|mullumbimby to bungalora|bungalora to mullumbimby/i },
    { name: 'Marinus Link', pattern: /marinus/i },
    { name: 'HVDC', pattern: /hvdc/i },
];

/** Name of the DC link a line belongs to, or null for ordinary AC lines. */
export function hvdcLinkName(kv: number | null, text = ''): string | null {
    const hit = HVDC_LINKS.find(l => l.pattern.test(text));
    if (hit) {
        return hit.name;
    }
    return kv === 400 ? 'Basslink' : null;
}

export function classifyVoltage(kv: number | null, text = ''): VoltageClass {
    if (hvdcLinkName(kv, text)) {
        return 'hvdc';
    }
    if (kv === null || !isFinite(kv) || kv <= 0) {
        return 'other';
    }
    if (kv >= 450) {
        return '500';
    }
    if (kv >= 300) {
        return '330';
    }
    if (kv >= 250) {
        return '275';
    }
    if (kv >= 200) {
        return '220';
    }
    if (kv >= 100) {
        return '132';
    }
    return 'other';
}

/** Substations at 220 kV and above show from this zoom; the rest from SUBSTATION_MIN_ZOOM. */
export const MAJOR_SUBSTATION_MIN_ZOOM = 6;
export const SUBSTATION_MIN_ZOOM = 8;

export type FuelGroup =
    | 'coal'
    | 'gas'
    | 'hydro'
    | 'wind'
    | 'solar'
    | 'battery'
    | 'bioenergy'
    | 'distillate'
    | 'other';

export const FUEL_STYLES: Record<FuelGroup, { label: string; color: string }> = {
    coal: { label: 'Coal', color: '#3b3b3b' },
    gas: { label: 'Gas', color: '#f4a261' },
    hydro: { label: 'Hydro', color: '#4aa3df' },
    wind: { label: 'Wind', color: '#4caf50' },
    solar: { label: 'Solar', color: '#fff176' },
    battery: { label: 'Battery', color: '#00e5ff' },
    bioenergy: { label: 'Bioenergy', color: '#1d7a7a' },
    distillate: { label: 'Diesel / oil', color: '#f35020' },
    other: { label: 'Other', color: '#bdbdbd' },
};

/**
 * Works for Open Electricity fueltech ids ("gas_ocgt"), GA fuel names ("Natural Gas - Coal Seam
 * Gas") and, as a last resort, GA technology names ("Turbine - Ocgt").
 */
export function fuelGroup(text: string | null | undefined): FuelGroup {
    const t = (text ?? '').toLowerCase().replace(/_/g, ' ');
    if (!t.trim()) {
        return 'other';
    }
    if (/battery/.test(t)) {
        return 'battery';
    }
    // \bgas\b, not "gas": "bagasse" is a biomass fuel.
    if (
        /\bgas\b|coal seam|methane|ocgt|ccgt|spark ignition/.test(t) &&
        !/biogas|landfill|sewage/.test(t)
    ) {
        return 'gas';
    }
    if (/coal/.test(t)) {
        return 'coal';
    }
    if (/hydro|water|pumps/.test(t)) {
        return 'hydro';
    }
    if (/wind/.test(t)) {
        return 'wind';
    }
    if (/solar|photovoltaic/.test(t)) {
        return 'solar';
    }
    if (/bio|waste|wood|bagasse|landfill|sewage/.test(t)) {
        return 'bioenergy';
    }
    if (/diesel|distillate|\boil\b|kerosene|compression ignition/.test(t)) {
        return 'distillate';
    }
    return 'other';
}

export interface RegionInfo {
    id: string;
    label: string;
    /** Where the live badge sits on the map. */
    lat: number;
    lng: number;
}

export const NEM_REGIONS: RegionInfo[] = [
    { id: 'QLD1', label: 'QLD', lat: -23.5, lng: 146.5 },
    { id: 'NSW1', label: 'NSW', lat: -32.3, lng: 147.3 },
    { id: 'VIC1', label: 'VIC', lat: -36.9, lng: 144.6 },
    { id: 'SA1', label: 'SA', lat: -32.6, lng: 137.4 },
    { id: 'TAS1', label: 'TAS', lat: -42.1, lng: 146.6 },
];

export interface Corridor {
    id: string;
    from: string;
    to: string;
    /** Label position, roughly where the interconnectors cross the border. */
    lat: number;
    lng: number;
    note: string;
}

export const CORRIDORS: Corridor[] = [
    {
        id: 'QLD-NSW',
        from: 'QLD1',
        to: 'NSW1',
        lat: -28.75,
        lng: 151.6,
        note: 'QNI + Terranora (Directlink)',
    },
    {
        id: 'NSW-VIC',
        from: 'NSW1',
        to: 'VIC1',
        lat: -36.05,
        lng: 147.3,
        note: 'VIC1–NSW1. Includes any share of SA flow carried on Project EnergyConnect.',
    },
    {
        id: 'VIC-SA',
        from: 'VIC1',
        to: 'SA1',
        lat: -36.4,
        lng: 140.97,
        note: 'Heywood + Murraylink (+ Project EnergyConnect). Total SA exchange.',
    },
    {
        id: 'TAS-VIC',
        from: 'TAS1',
        to: 'VIC1',
        lat: -39.9,
        lng: 146.3,
        note: 'Basslink',
    },
];
