/** Geoscience Australia: National Electricity Infrastructure (lines, substations, power stations). */
export const GA_SERVICE =
    'https://services.ga.gov.au/gis/rest/services/National_Electricity_Infrastructure/MapServer';

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

/** Names of the DC links, used because the source data has no AC/DC attribute. */
const HVDC_PATTERN = /basslink|murraylink|directlink|terranora|marinus|hvdc|\bdc (link|cable|line)\b/i;

export function classifyVoltage(kv: number | null, text = ''): VoltageClass {
    if (HVDC_PATTERN.test(text)) {
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

/** Works for both Open Electricity fueltech ids ("gas_ocgt") and GA fuel names ("Natural Gas"). */
export function fuelGroup(text: string | null | undefined): FuelGroup {
    const t = (text ?? '').toLowerCase();
    if (!t) {
        return 'other';
    }
    if (/battery/.test(t)) {
        return 'battery';
    }
    if (/coal seam|methane|gas/.test(t) && !/biogas|landfill|sewage/.test(t)) {
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
    if (/diesel|distillate|oil|kerosene/.test(t)) {
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
