export type Props = Record<string, unknown>;

export function esc(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Case-insensitive property lookup; the GA layers are not consistent about field-name case. */
export function prop(props: Props | null | undefined, ...names: string[]): unknown {
    if (!props) {
        return undefined;
    }
    const keys = Object.keys(props);
    for (const name of names) {
        const key = keys.find(k => k.toLowerCase() === name.toLowerCase());
        if (key !== undefined && props[key] !== null && props[key] !== '') {
            return props[key];
        }
    }
    return undefined;
}

export function num(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    return isFinite(n) ? n : null;
}

export function fmtMW(value: number | null | undefined): string {
    if (value === null || value === undefined || !isFinite(value)) {
        return '–';
    }
    const abs = Math.abs(value);
    return `${value.toFixed(abs >= 100 ? 0 : 1)} MW`;
}

const HIDDEN_FIELDS = /^(objectid|fid|shape.*|ga_guid|globalid|featuretype|st_length.*|se_anno.*)$/i;

function fmtValue(key: string, value: unknown): string {
    if (typeof value === 'number' && value > 1e11 && /revis|date|updated|created/i.test(key)) {
        return new Date(value).toISOString().slice(0, 10);
    }
    if (typeof value === 'number' && !Number.isInteger(value)) {
        return value.toFixed(2);
    }
    return String(value);
}

function fmtKey(key: string): string {
    const k = key.replace(/_+$/, '').replace(/_/g, ' ').toLowerCase();
    const pretty: Record<string, string> = {
        capacitykv: 'Voltage (kV)',
        voltagekv: 'Voltage (kV)',
        operationalstatus: 'Status',
        generationmw: 'Capacity (MW)',
        generationtype: 'Generation type',
        primaryfueltype: 'Primary fuel',
        primarysubfueltype: 'Fuel detail',
        generatornumber: 'Generating units',
        spatialconfidence: 'Location confidence (1–5)',
    };
    return pretty[k] ?? k.charAt(0).toUpperCase() + k.slice(1);
}

/** Every non-empty attribute as table rows, so popups stay useful if the source schema changes. */
export function propsRows(props: Props | null | undefined, skip: string[] = []): string {
    if (!props) {
        return '';
    }
    const skipLower = skip.map(s => s.toLowerCase());
    return Object.keys(props)
        .filter(k => !HIDDEN_FIELDS.test(k) && !skipLower.includes(k.toLowerCase()))
        .filter(k => props[k] !== null && props[k] !== undefined && String(props[k]).trim() !== '')
        .map(k => row(fmtKey(k), esc(fmtValue(k, props[k]))))
        .join('');
}

export function row(label: string, valueHtml: string): string {
    return (
        `<tr><td style="padding:2px 8px 2px 0;color:#666;vertical-align:top;white-space:nowrap">` +
        `${esc(label)}</td><td style="padding:2px 0;color:#111">${valueHtml}</td></tr>`
    );
}

export function popupHtml(title: string, subtitle: string, rowsHtml: string, footer = ''): string {
    return (
        `<div style="background:#fff;color:#111;font-size:12px;line-height:1.35;min-width:200px;` +
        `max-width:280px;padding:8px 10px;border-radius:6px">` +
        `<div style="font-weight:700;font-size:14px">${esc(title)}</div>` +
        (subtitle ? `<div style="color:#555;margin-bottom:4px">${subtitle}</div>` : '') +
        `<table style="border-collapse:collapse;width:100%">${rowsHtml}</table>` +
        (footer ? `<div style="color:#777;margin-top:6px;font-size:11px">${footer}</div>` : '') +
        `</div>`
    );
}

export function swatch(color: string): string {
    return (
        `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;` +
        `background:${color};border:1px solid #555;margin-right:5px;vertical-align:-1px"></span>`
    );
}

/** Great-circle distance in km. */
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
    const rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad;
    const dLng = (bLng - aLng) * rad;
    const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
}

/**
 * Wall-clock time in a fixed-offset market time zone, formatted the way the
 * Open Electricity API expects (network-local, no offset suffix).
 */
export function networkLocalIso(date: Date, offsetHours: number): string {
    return new Date(date.getTime() + offsetHours * 3600_000).toISOString().slice(0, 19);
}
