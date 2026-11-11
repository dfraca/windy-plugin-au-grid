import {
    CORRIDORS,
    FUEL_STYLES,
    MAJOR_SUBSTATION_MIN_ZOOM,
    NEM_REGIONS,
    SUBSTATION_MIN_ZOOM,
    VOLTAGE_BY_ID,
    VOLTAGE_STYLES,
    classifyVoltage,
    fuelGroup,
    hvdcLinkName,
} from './config';
import type { FuelGroup, VoltageClass } from './config';
import type { Feature, GaData } from './ga';
import type { CorridorFlow, OeFacility, RegionReading, UnitReading } from './oe';
import { distanceKm, esc, fmtMW, num, popupHtml, prop, propsRows, row, swatch } from './util';

export type LayerId = 'lines' | 'substations' | 'generators' | 'flows';
export type LabelKind = 'lines' | 'substations' | 'stations';

const GA_CREDIT = 'Source: Geoscience Australia, Electricity Infrastructure';
const NAME_FIELDS = ['FEATURE_NAME', 'NAME'];
const OE_CREDIT = 'Live data: Open Electricity (AEMO dispatch, 5-minute)';

function lineText(f: Feature): string {
    const p = f.properties;
    return ['FEATURE_NAME', 'NAME', 'CLASS'].map(k => String(prop(p, k) ?? '')).join(' ');
}

function lineKv(f: Feature): number | null {
    return num(prop(f.properties, 'CAPACITYKV', 'VOLTAGEKV', 'CAPACITY_KV', 'VOLTAGE_KV', 'VOLTAGE'));
}

function isOperational(f: Feature): boolean {
    const status = String(prop(f?.properties, 'STATUS', 'OPERATIONALSTATUS', 'OPERATIONAL_STATUS') ?? '');
    return status === '' || /^operational/i.test(status.trim());
}

function pointLatLng(f: Feature): { lat: number; lng: number } | null {
    const g = f.geometry;
    if (!g) {
        return null;
    }
    const c = g.type === 'Point' ? g.coordinates : g.type === 'MultiPoint' ? g.coordinates[0] : null;
    if (!c || !isFinite(c[0]) || !isFinite(c[1])) {
        return null;
    }
    return { lat: c[1], lng: c[0] };
}

/** Power stations are small, uniform dots: the label carries the name and size. */
const STATION_RADIUS = 3.5;

interface PointTarget {
    lat: number;
    lng: number;
    /** Drawn radius in pixels. */
    radius: number;
    /** Map label: the name, with the MW or kV figure on a second line. */
    label: string;
    detail: string;
    /** MW or kV; bigger assets get their label first when space is tight. */
    weight: number;
    open: (latlng: { lat: number; lng: number }) => void;
}

interface LineTarget {
    feature: Feature;
    cls: VoltageClass;
    /** west, south, east, north */
    box: [number, number, number, number];
    label: string;
    kv: number;
    /** Half-way along the line; worked out on first use. */
    mid?: LineAnchor | null;
}

/** A position on a line: `t` of the way from vertex `i` to vertex `i + 1` of `part`. */
interface LineAnchor {
    part: number[][];
    i: number;
    t: number;
}

/** 220 kV and above, and the DC links: shown and labelled from further out. */
const MAJOR_CLASSES: VoltageClass[] = ['hvdc', '500', '330', '275', '220'];

function substationMinZoom(cls: VoltageClass): number {
    return MAJOR_CLASSES.includes(cls) ? MAJOR_SUBSTATION_MIN_ZOOM : SUBSTATION_MIN_ZOOM;
}

/** Zoom from which each kind of label appears. */
const LABEL_ZOOM = {
    bigStations: 7, // 500 MW and above
    stations: 8,
    majorSubstations: 9, // 220 kV and above
    substations: 11,
    majorLines: 9, // 220 kV and above, and HVDC
    midLines: 10, // 110–132 kV
    lines: 11,
};
const MAX_LABELS = 70;
const LABEL_FONT_PX = 11;
const LABEL_CHAR_PX = LABEL_FONT_PX * 0.58;
/** How far a line's label sits above the line, in pixels. */
const LINE_LABEL_LIFT_PX = 8;
const LABEL_HALO = 'text-shadow:0 0 2px #000,0 0 3px #000,0 0 4px #000,0 0 5px #000';

function shorten(name: string): string {
    const clean = name.replace(/\s+/g, ' ').trim();
    return clean.length > 36 ? `${clean.slice(0, 35)}…` : clean;
}

/** Line parts as arrays of [lng, lat], whether the geometry is single or multi-part. */
function lineParts(f: Feature): number[][][] {
    const g = f.geometry;
    if (!g) {
        return [];
    }
    return g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
}

function lineBox(f: Feature): [number, number, number, number] {
    let w = 180;
    let s = 90;
    let e = -180;
    let n = -90;
    for (const part of lineParts(f)) {
        for (const c of part) {
            w = Math.min(w, c[0]);
            e = Math.max(e, c[0]);
            s = Math.min(s, c[1]);
            n = Math.max(n, c[1]);
        }
    }
    return [w, s, e, n];
}

/** Web-Mercator northing expressed in degrees, so x (longitude) and y share one scale. */
function mercatorY(lat: number): number {
    const clamped = Math.max(-85, Math.min(85, lat));
    return (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Half-way along the longest part of a line. */
function midAnchor(f: Feature): LineAnchor | null {
    const part = [...lineParts(f)].sort((a, b) => b.length - a.length)[0];
    if (!part || part.length < 2) {
        return null;
    }
    const seg: number[] = [];
    let total = 0;
    for (let i = 1; i < part.length; i++) {
        const d = Math.hypot(part[i][0] - part[i - 1][0], part[i][1] - part[i - 1][1]);
        seg.push(d);
        total += d;
    }
    let run = total / 2;
    for (let i = 0; i < seg.length; i++) {
        if (run <= seg[i]) {
            return { part, i, t: seg[i] === 0 ? 0 : run / seg[i] };
        }
        run -= seg[i];
    }
    return { part, i: part.length - 2, t: 1 };
}

/** The anchor's position as [lng, lat]. */
function anchorPoint(a: LineAnchor): number[] {
    const from = a.part[a.i];
    const to = a.part[a.i + 1];
    if (!to || a.t === 0) {
        return from;
    }
    return [from[0] + a.t * (to[0] - from[0]), from[1] + a.t * (to[1] - from[1])];
}

/**
 * Direction of the line around an anchor, in screen degrees (clockwise, as CSS rotates),
 * kept between -90 and 90 so text never reads upside down. Measured between the points
 * `halfWidthPx` either side along the line, so a label follows the general run of a
 * winding line and not one short kink.
 */
function anchorAngle(a: LineAnchor, scale: number, halfWidthPx: number): number {
    const screen = (c: number[]) => [c[0] * scale, -mercatorY(c[1]) * scale];
    const here = screen(anchorPoint(a));
    const walk = (indices: number[]): number[] => {
        let need = halfWidthPx;
        let prev = here;
        for (const k of indices) {
            const q = screen(a.part[k]);
            const d = Math.hypot(q[0] - prev[0], q[1] - prev[1]);
            if (d >= need && d > 0) {
                return [prev[0] + ((q[0] - prev[0]) * need) / d, prev[1] + ((q[1] - prev[1]) * need) / d];
            }
            need -= d;
            prev = q;
        }
        return prev;
    };
    const before: number[] = [];
    for (let k = a.i; k >= 0; k--) {
        before.push(k);
    }
    const after: number[] = [];
    for (let k = a.i + 1; k < a.part.length; k++) {
        after.push(k);
    }
    const back = walk(before);
    const fwd = walk(after);
    let angle = (Math.atan2(fwd[1] - back[1], fwd[0] - back[0]) * 180) / Math.PI;
    if (angle > 90) {
        angle -= 180;
    } else if (angle <= -90) {
        angle += 180;
    }
    return angle;
}

/**
 * Owns every map layer the plugin draws. Receives the Leaflet namespace and the
 * Windy map instance rather than importing them, so the logic can be exercised
 * outside Windy.
 */
export class GridOverlay {
    private L: any;
    private map: any;

    private lineLayers = new Map<VoltageClass, any[]>();
    /** One group per voltage class, so the voltage tick boxes switch substations as well as lines. */
    private substationLayers = new Map<VoltageClass, any>();
    private generatorLayer: any = null;
    private flowLayer: any = null;
    private labelLayer: any = null;
    private popup: any = null;

    // What a tap can land on. Taps are resolved here, not by the map library, so
    // that thin lines and small circles are easy to hit on a phone.
    private lineIndex: LineTarget[] = [];
    private generatorTargets: PointTarget[] = [];
    private substationTargets = new Map<VoltageClass, PointTarget[]>();

    private ga: GaData | null = null;
    private facilities: OeFacility[] = [];
    private readings = new Map<string, UnitReading>();
    private openFacilityCode: string | null = null;

    private layerOn: Record<LayerId, boolean> = {
        lines: true,
        substations: true,
        generators: true,
        flows: true,
    };
    private labelOn: Record<LabelKind, boolean> = { lines: true, substations: true, stations: true };
    private classOn = new Map<VoltageClass, boolean>(VOLTAGE_STYLES.map(s => [s.id, true]));

    /** Called when a generator with a live-data code is clicked. */
    onFacilityClick: (facility: OeFacility) => void = () => {};

    constructor(leaflet: any, map: any) {
        this.L = leaflet;
        this.map = map;
    }

    // ---------- public API ----------

    setGaData(data: GaData): void {
        this.ga = data;
        this.buildLines();
        this.buildSubstations();
        this.buildGenerators();
        this.refreshVisibility();
    }

    setFacilities(facilities: OeFacility[]): void {
        this.facilities = facilities;
        this.buildGenerators();
        this.refreshVisibility();
    }

    mergeUnitReadings(readings: Map<string, UnitReading>): void {
        readings.forEach((value, key) => this.readings.set(key, value));
        this.buildGenerators();
        this.refreshVisibility();
        if (this.openFacilityCode && this.popup) {
            const f = this.facilities.find(x => x.code === this.openFacilityCode);
            if (f) {
                this.popup.setContent(this.facilityHtml(f, false));
            }
        }
    }

    setFlows(regions: Map<string, RegionReading>, corridors: CorridorFlow[]): void {
        this.removeLayer(this.flowLayer);
        const group = new this.L.FeatureGroup();

        for (const region of NEM_REGIONS) {
            const r = regions.get(region.id);
            if (!r) {
                continue;
            }
            const net = r.imports !== null && r.exports !== null ? r.exports - r.imports : null;
            const netText =
                net === null
                    ? ''
                    : Math.abs(net) < 1
                      ? 'balanced'
                      : `${net > 0 ? 'exporting' : 'importing'} ${fmtMW(Math.abs(net))}`;
            const priceText = r.price === null ? '' : `$${r.price.toFixed(0)}/MWh`;
            const html =
                `<b>${esc(region.label)}</b> ${esc(priceText)}` +
                (netText ? `<br>${esc(netText)}` : '');
            const marker = this.badge(region.lat, region.lng, html, '#1f2937', '#fff');
            this.onClick(marker, latlng => {
                this.openFacilityCode = null;
                this.openPopup(
                    latlng,
                    popupHtml(
                        `${region.label} region`,
                        esc(region.id),
                        row('Price', esc(priceText || '–')) +
                            row('Demand', esc(fmtMW(r.demand))) +
                            row('Imports', esc(fmtMW(r.imports))) +
                            row('Exports', esc(fmtMW(r.exports))) +
                            row('Interval', esc(r.time ?? '–')),
                        OE_CREDIT,
                    ),
                );
            });
            group.addLayer(marker);
        }

        for (const flow of corridors) {
            const corridor = CORRIDORS.find(c => c.id === flow.id);
            if (!corridor) {
                continue;
            }
            const forward = flow.mw >= 0;
            const a = (forward ? corridor.from : corridor.to).replace(/1$/, '');
            const b = (forward ? corridor.to : corridor.from).replace(/1$/, '');
            const html = `${esc(a)} &rarr; ${esc(b)}<br><b>${esc(fmtMW(Math.abs(flow.mw)))}</b>`;
            const marker = this.badge(corridor.lat, corridor.lng, html, '#22c55e', '#052e16');
            this.onClick(marker, latlng => {
                this.openFacilityCode = null;
                this.openPopup(
                    latlng,
                    popupHtml(
                        `${a} → ${b}: ${fmtMW(Math.abs(flow.mw))}`,
                        esc(corridor.note),
                        '',
                        'Derived from regional imports and exports, before losses. ' +
                            'Flows on individual lines inside a region are not published.',
                    ),
                );
            });
            group.addLayer(marker);
        }

        this.flowLayer = group;
        this.refreshVisibility();
    }

    setLayerVisible(id: LayerId, on: boolean): void {
        this.layerOn[id] = on;
        this.refreshVisibility();
    }

    setLabelVisible(kind: LabelKind, on: boolean): void {
        this.labelOn[kind] = on;
        this.refreshLabels();
    }

    /** A voltage tick box switches that voltage's lines and its substations together. */
    setClassVisible(id: VoltageClass, on: boolean): void {
        this.classOn.set(id, on);
        this.refreshVisibility();
    }

    /** Call on zoomend: lower-voltage lines and substations only appear once zoomed in. */
    refreshVisibility(): void {
        const zoom = Number(this.map.getZoom?.() ?? 5);
        for (const style of VOLTAGE_STYLES) {
            const show = this.classShown(style.id, zoom);
            for (const layer of this.lineLayers.get(style.id) ?? []) {
                this.toggle(layer, show);
            }
        }
        this.substationLayers.forEach((layer, cls) => {
            this.toggle(layer, this.substationShown(cls, zoom));
        });
        this.toggle(this.generatorLayer, this.layerOn.generators);
        this.toggle(this.flowLayer, this.layerOn.flows);
        this.refreshLabels();
    }

    /**
     * Rebuilds the name labels for what is on screen. Call after the map moves or zooms.
     * Labels only exist for the current view, biggest assets first, and one that would
     * overlap an earlier label is left out, so the map never fills with text.
     *
     * Stations and substations get the name with the MW or kV on a second line, beside the
     * marker. Lines get "name · kV" written along the line, just above it.
     */
    refreshLabels(): void {
        this.removeLayer(this.labelLayer);
        this.labelLayer = null;
        const zoom = Number(this.map.getZoom?.() ?? 5);
        const anyOn = this.labelOn.lines || this.labelOn.substations || this.labelOn.stations;
        if (!anyOn || zoom < LABEL_ZOOM.bigStations) {
            return;
        }
        let view: { w: number; s: number; e: number; n: number };
        try {
            const b = this.map.getBounds();
            view = { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() };
        } catch (e) {
            return;
        }
        const scale = this.pixelsPerDegree(zoom);
        const inView = (lat: number, lng: number) =>
            lat >= view.s && lat <= view.n && lng >= view.w && lng <= view.e;

        type Rect = { x: number; y: number; w: number; h: number };
        type Candidate = {
            lat: number;
            lng: number;
            key: string;
            html: string;
            /** Screen area the label covers, as one or more rectangles. */
            rects: Rect[];
            order: number;
        };
        const candidates: Candidate[] = [];
        const lineHeight = LABEL_FONT_PX + 2;
        const baseStyle =
            `position:absolute;white-space:nowrap;pointer-events:none;` +
            `font:600 ${LABEL_FONT_PX}px/${lineHeight}px sans-serif;${LABEL_HALO}`;

        const addPoints = (targets: PointTarget[], color: string, tier: number, minWeight = 0) => {
            for (const t of targets) {
                if (!t.label || t.weight < minWeight || !inView(t.lat, t.lng)) {
                    continue;
                }
                const offset = Math.round(t.radius + 4);
                const width = Math.max(t.label.length, t.detail.length) * LABEL_CHAR_PX + 4;
                const height = (t.detail ? 2 : 1) * lineHeight;
                candidates.push({
                    lat: t.lat,
                    lng: t.lng,
                    key: `${t.label}|${t.detail}`,
                    html:
                        `<div style="${baseStyle};left:${offset}px;transform:translateY(-50%);color:${color}">` +
                        esc(t.label) +
                        (t.detail ? `<br><span style="font-weight:400">${esc(t.detail)}</span>` : '') +
                        `</div>`,
                    rects: [
                        {
                            x: t.lng * scale + offset,
                            y: -mercatorY(t.lat) * scale - height / 2,
                            w: width,
                            h: height,
                        },
                    ],
                    order: tier * 1e6 - t.weight,
                });
            }
        };
        if (this.labelOn.stations && this.layerOn.generators) {
            addPoints(this.generatorTargets, '#ffffff', 0, zoom >= LABEL_ZOOM.stations ? 0 : 500);
        }
        if (this.labelOn.substations) {
            this.substationTargets.forEach((targets, cls) => {
                const major = MAJOR_CLASSES.includes(cls);
                const need = major ? LABEL_ZOOM.majorSubstations : LABEL_ZOOM.substations;
                if (zoom >= need && this.substationShown(cls, zoom)) {
                    addPoints(targets, '#d6e4ff', major ? 1 : 3);
                }
            });
        }
        if (this.labelOn.lines && zoom >= LABEL_ZOOM.majorLines) {
            const cx = (view.w + view.e) / 2;
            const cy = (view.s + view.n) / 2;
            for (const item of this.lineIndex) {
                if (!item.label || !this.classShown(item.cls, zoom)) {
                    continue;
                }
                const major = MAJOR_CLASSES.includes(item.cls);
                const need = major
                    ? LABEL_ZOOM.majorLines
                    : item.kv >= 100
                      ? LABEL_ZOOM.midLines
                      : LABEL_ZOOM.lines;
                const [w, s, e, n] = item.box;
                if (zoom < need || e < view.w || w > view.e || n < view.s || s > view.n) {
                    continue;
                }
                if (item.mid === undefined) {
                    item.mid = midAnchor(item.feature);
                }
                // Label the middle of the line; if that is off screen, the on-screen
                // corner of the line nearest the centre of the view.
                let anchor: LineAnchor | null = null;
                if (item.mid) {
                    const m = anchorPoint(item.mid);
                    if (inView(m[1], m[0])) {
                        anchor = item.mid;
                    }
                }
                if (!anchor) {
                    let best = Infinity;
                    for (const part of lineParts(item.feature)) {
                        for (let i = 0; i < part.length; i++) {
                            const c = part[i];
                            const d = Math.hypot(c[0] - cx, c[1] - cy);
                            if (d < best && inView(c[1], c[0])) {
                                best = d;
                                anchor = { part, i, t: 0 };
                            }
                        }
                    }
                }
                if (!anchor) {
                    continue;
                }
                const at = anchorPoint(anchor);
                const width = item.label.length * LABEL_CHAR_PX + 4;
                const angle = anchorAngle(anchor, scale, width / 2);
                const rad = (angle * Math.PI) / 180;
                // Centre of the text: lifted off the line, at right angles to it.
                const mx = at[0] * scale + Math.sin(rad) * LINE_LABEL_LIFT_PX;
                const my = -mercatorY(at[1]) * scale - Math.cos(rad) * LINE_LABEL_LIFT_PX;
                // A slanted label is covered by a run of small squares along its length.
                const rects: Rect[] = [];
                const steps = Math.ceil(width / 2 / lineHeight);
                for (let k = -steps; k <= steps; k++) {
                    rects.push({
                        x: mx + Math.cos(rad) * k * lineHeight - lineHeight / 2,
                        y: my + Math.sin(rad) * k * lineHeight - lineHeight / 2,
                        w: lineHeight,
                        h: lineHeight,
                    });
                }
                candidates.push({
                    lat: at[1],
                    lng: at[0],
                    key: item.label,
                    html:
                        `<div style="${baseStyle};color:${VOLTAGE_BY_ID[item.cls].color};` +
                        `transform:translate(-50%,-50%) rotate(${angle.toFixed(1)}deg) ` +
                        `translateY(-${LINE_LABEL_LIFT_PX}px)">${esc(item.label)}</div>`,
                    rects,
                    order: (major ? 2 : 4) * 1e6 - item.kv,
                });
            }
        }

        candidates.sort((a, b) => a.order - b.order);
        const taken: Rect[] = [];
        const seen = new Set<string>();
        const group = new this.L.FeatureGroup();
        let count = 0;
        for (const c of candidates) {
            if (count >= MAX_LABELS) {
                break;
            }
            if (seen.has(c.key)) {
                continue; // parallel circuits share a name; one label is enough
            }
            const clash = c.rects.some(r =>
                taken.some(p => r.x < p.x + p.w && p.x < r.x + r.w && r.y < p.y + p.h && p.y < r.y + r.h),
            );
            if (clash) {
                continue;
            }
            taken.push(...c.rects);
            seen.add(c.key);
            count++;
            group.addLayer(
                new this.L.Marker(
                    { lat: c.lat, lng: c.lng },
                    { icon: this.makeDivIcon(c.html), interactive: false, keyboard: false },
                ),
            );
        }
        if (count) {
            this.labelLayer = group;
            this.map.addLayer(group);
        }
    }

    /**
     * Resolves a tap on the map. Opens the details popup of the nearest visible generator,
     * substation or line within `tolerancePx` and returns true; returns false on a miss.
     */
    handleMapClick(lat: number, lng: number, tolerancePx: number): boolean {
        const zoom = Number(this.map.getZoom?.() ?? 5);
        const scale = this.pixelsPerDegree(zoom);
        const cx = lng * scale;
        const cy = mercatorY(lat) * scale;

        // Points win over lines: substations and stations sit on top of the lines they join.
        let bestPoint: { d: number; target: PointTarget } | null = null;
        const consider = (targets: PointTarget[]) => {
            for (const t of targets) {
                const d = Math.hypot(t.lng * scale - cx, mercatorY(t.lat) * scale - cy) - t.radius;
                if (d <= tolerancePx && (!bestPoint || d < bestPoint.d)) {
                    bestPoint = { d, target: t };
                }
            }
        };
        if (this.layerOn.generators) {
            consider(this.generatorTargets);
        }
        this.substationTargets.forEach((targets, cls) => {
            if (this.substationShown(cls, zoom)) {
                consider(targets);
            }
        });
        if (bestPoint) {
            const { target } = bestPoint as { d: number; target: PointTarget };
            target.open({ lat: target.lat, lng: target.lng });
            return true;
        }

        const reach = tolerancePx / scale; // tolerance in degrees of longitude
        const rank = (cls: VoltageClass) => VOLTAGE_STYLES.findIndex(v => v.id === cls);
        let bestLine: { d: number; item: LineTarget } | null = null;
        for (const item of this.lineIndex) {
            if (!this.classShown(item.cls, zoom)) {
                continue;
            }
            const [w, s, e, n] = item.box;
            if (lng < w - reach || lng > e + reach || lat < s - reach || lat > n + reach) {
                continue;
            }
            let d = Infinity;
            for (const part of lineParts(item.feature)) {
                for (let i = 1; i < part.length; i++) {
                    d = Math.min(
                        d,
                        distanceToSegment(
                            cx,
                            cy,
                            part[i - 1][0] * scale,
                            mercatorY(part[i - 1][1]) * scale,
                            part[i][0] * scale,
                            mercatorY(part[i][1]) * scale,
                        ),
                    );
                }
            }
            if (d > tolerancePx) {
                continue;
            }
            // Nearest line wins; where lines share a route, the higher voltage wins.
            const current = bestLine as { d: number; item: LineTarget } | null;
            if (
                !current ||
                d < current.d - 1 ||
                (Math.abs(d - current.d) <= 1 && rank(item.cls) > rank(current.item.cls))
            ) {
                bestLine = { d, item };
            }
        }
        if (bestLine) {
            const { item } = bestLine as { d: number; item: LineTarget };
            this.openFacilityCode = null;
            this.openPopup({ lat, lng }, this.lineHtml(item.feature, item.cls));
            return true;
        }
        return false;
    }

    /** Largest facilities currently on screen, for a bounded live-data request. */
    facilitiesInView(limit: number): OeFacility[] {
        let box: { s: number; n: number; w: number; e: number } | null = null;
        try {
            const b = this.map.getBounds();
            box = { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() };
        } catch (e) {
            box = null;
        }
        const inView = this.facilities.filter(
            f => !box || (f.lat >= box.s && f.lat <= box.n && f.lng >= box.w && f.lng <= box.e),
        );
        return inView.sort((a, b) => b.capacity - a.capacity).slice(0, limit);
    }

    hasFacilities(): boolean {
        return this.facilities.length > 0;
    }

    counts(): { lines: number; substations: number; generators: number } {
        return {
            lines: this.ga?.lines.length ?? 0,
            substations: this.ga?.substations.length ?? 0,
            generators: this.facilities.length + this.gaStations().length,
        };
    }

    destroy(): void {
        this.lineLayers.forEach(layers => layers.forEach(l => this.removeLayer(l)));
        this.lineLayers.clear();
        this.lineIndex = [];
        this.substationLayers.forEach(layer => this.removeLayer(layer));
        this.substationLayers.clear();
        this.substationTargets.clear();
        [this.generatorLayer, this.flowLayer, this.labelLayer].forEach(l => this.removeLayer(l));
        this.generatorLayer = this.flowLayer = this.labelLayer = null;
        try {
            this.popup?.remove?.();
        } catch (e) {
            // already closed
        }
        this.popup = null;
    }

    // ---------- layer construction ----------

    private buildLines(): void {
        this.lineLayers.forEach(layers => layers.forEach(l => this.removeLayer(l)));
        this.lineLayers.clear();
        this.lineIndex = [];
        if (!this.ga) {
            return;
        }
        const byClass = new Map<VoltageClass, Feature[]>();
        for (const f of this.ga.lines) {
            const cls = classifyVoltage(lineKv(f), lineText(f));
            if (!byClass.has(cls)) {
                byClass.set(cls, []);
            }
            (byClass.get(cls) as Feature[]).push(f);
            const kv = lineKv(f) ?? 0;
            const name = shorten(String(prop(f.properties, ...NAME_FIELDS) ?? ''));
            this.lineIndex.push({
                feature: f,
                cls,
                box: lineBox(f),
                kv,
                label: name ? `${name} · ${cls === 'hvdc' ? 'HVDC' : kv ? `${kv} kV` : ''}`.replace(/ · $/, '') : '',
            });
        }

        for (const style of VOLTAGE_STYLES) {
            const features = byClass.get(style.id);
            if (!features || !features.length) {
                continue;
            }
            const visible = new this.L.GeoJSON(
                { type: 'FeatureCollection', features },
                {
                    interactive: false,
                    style: (feature: Feature) => ({
                        interactive: false,
                        color: style.color,
                        weight: style.weight,
                        opacity: isOperational(feature) ? 0.95 : 0.4,
                        dashArray: isOperational(feature) ? undefined : '4 4',
                    }),
                },
            );
            this.lineLayers.set(style.id, [visible]);
        }
    }

    private buildSubstations(): void {
        this.substationLayers.forEach(layer => this.removeLayer(layer));
        this.substationLayers.clear();
        this.substationTargets.clear();
        if (!this.ga) {
            return;
        }
        for (const f of this.ga.substations) {
            const at = pointLatLng(f);
            if (!at) {
                continue;
            }
            const kv = num(prop(f.properties, 'VOLTAGE_KV', 'VOLTAGEKV', 'CAPACITY_KV', 'CAPACITYKV'));
            // A substation with no recorded voltage falls in the lowest class.
            const cls = classifyVoltage(kv);
            const isMajor = MAJOR_CLASSES.includes(cls);
            const live = isOperational(f);
            const radius = isMajor ? 4.5 : 3.5;
            const marker = new this.L.CircleMarker(at, {
                interactive: false,
                radius,
                color: kv ? VOLTAGE_BY_ID[cls].color : '#333',
                weight: isMajor ? 2 : 1.5,
                opacity: live ? 1 : 0.5,
                fillColor: '#ffffff',
                fillOpacity: live ? 1 : 0.5,
            });
            if (!this.substationLayers.has(cls)) {
                this.substationLayers.set(cls, new this.L.FeatureGroup());
                this.substationTargets.set(cls, []);
            }
            this.substationLayers.get(cls).addLayer(marker);

            const name = shorten(String(prop(f.properties, ...NAME_FIELDS) ?? ''));
            this.pointTarget(
                this.substationTargets.get(cls) as PointTarget[],
                at,
                radius,
                name && name !== 'Unknown' ? name : '',
                kv ? `${kv} kV` : '',
                kv ?? 0,
                latlng => {
                    this.openFacilityCode = null;
                    const subtype = String(prop(f.properties, 'FEATURE_SUBTYPE') ?? '');
                    const kind =
                        subtype && subtype !== 'Substation' ? `${subtype} substation` : 'Substation';
                    this.openPopup(
                        latlng,
                        popupHtml(
                            String(prop(f.properties, ...NAME_FIELDS) ?? 'Substation'),
                            swatch(kv ? VOLTAGE_BY_ID[cls].color : '#fff') +
                                esc([kind, kv ? `${kv} kV` : ''].filter(Boolean).join(' · ')) +
                                this.statusNote(f),
                            propsRows(f.properties, [...NAME_FIELDS, 'FEATURE_SUBTYPE']),
                            GA_CREDIT,
                        ),
                    );
                },
            );
        }
    }

    /** GA stations not already covered by an Open Electricity facility at the same site. */
    private gaStations(): Feature[] {
        if (!this.ga) {
            return [];
        }
        if (!this.facilities.length) {
            return this.ga.stations;
        }
        return this.ga.stations.filter(f => {
            const at = pointLatLng(f);
            if (!at) {
                return false;
            }
            return !this.facilities.some(o => distanceKm(at.lat, at.lng, o.lat, o.lng) < 3);
        });
    }

    private buildGenerators(): void {
        this.removeLayer(this.generatorLayer);
        this.generatorTargets = [];
        const group = new this.L.FeatureGroup();

        for (const f of this.gaStations()) {
            const at = pointLatLng(f);
            if (!at) {
                continue;
            }
            const p = f.properties;
            // Fuel fields first; GA's technology name only when those say nothing useful ("Fossil").
            let fuel = fuelGroup(
                `${prop(p, 'PRIMARY_FUEL_TYPE_DESCRIPTOR') ?? ''} ` +
                    `${prop(p, 'PRIMARY_FUEL_TYPE', 'PRIMARYFUELTYPE') ?? ''}`,
            );
            if (fuel === 'other') {
                fuel = fuelGroup(String(prop(p, 'TECHNOLOGY_TYPE', 'GENERATIONTYPE') ?? ''));
            }
            const mw = num(prop(p, 'GENERATION_CAPACITY_MW', 'GENERATIONMW', 'CAPACITY_MW'));
            const marker = new this.L.CircleMarker(at, {
                interactive: false,
                radius: STATION_RADIUS,
                color: '#ffffff',
                weight: 1,
                opacity: isOperational(f) ? 0.9 : 0.4,
                fillColor: FUEL_STYLES[fuel].color,
                fillOpacity: isOperational(f) ? 0.85 : 0.3,
            });
            this.pointTarget(this.generatorTargets, at, STATION_RADIUS, shorten(String(prop(p, ...NAME_FIELDS) ?? '')), mw ? fmtMW(mw) : '', mw ?? 0, latlng => {
                this.openFacilityCode = null;
                this.openPopup(
                    latlng,
                    popupHtml(
                        String(prop(p, ...NAME_FIELDS) ?? 'Power station'),
                        `${swatch(FUEL_STYLES[fuel].color)}${esc(FUEL_STYLES[fuel].label)}` +
                            (mw ? ` · ${esc(fmtMW(mw))}` : '') +
                            this.statusNote(f),
                        propsRows(p, NAME_FIELDS),
                        GA_CREDIT,
                    ),
                );
            });
            group.addLayer(marker);
        }

        for (const f of this.facilities) {
            const fuel = this.facilityFuel(f);
            const output = this.facilityOutput(f);
            const live = output !== null;
            const marker = new this.L.CircleMarker(
                { lat: f.lat, lng: f.lng },
                {
                    interactive: false,
                    radius: STATION_RADIUS,
                    // A bright ring marks stations that are generating right now.
                    color: live && (output as number) > 1 ? '#00ff9c' : '#ffffff',
                    weight: live && (output as number) > 1 ? 2.5 : 1,
                    opacity: 0.95,
                    fillColor: FUEL_STYLES[fuel].color,
                    fillOpacity: live
                        ? 0.25 + 0.7 * Math.max(0, Math.min(1, (output as number) / (f.capacity || 1)))
                        : 0.85,
                },
            );
            this.pointTarget(this.generatorTargets, { lat: f.lat, lng: f.lng }, STATION_RADIUS, shorten(f.name), f.capacity ? fmtMW(f.capacity) : '', f.capacity, latlng => {
                this.openFacilityCode = f.code;
                const fresh = f.units.some(u => this.readings.has(u.code));
                this.openPopup(latlng, this.facilityHtml(f, !fresh));
                this.onFacilityClick(f);
            });
            group.addLayer(marker);
        }

        this.generatorLayer = group;
    }

    // ---------- popup content ----------

    private lineHtml(f: Feature, cls: VoltageClass): string {
        const kv = lineKv(f);
        const style = VOLTAGE_BY_ID[cls];
        const link = hvdcLinkName(kv, lineText(f));
        const headline =
            cls === 'hvdc'
                ? `HVDC link${link && link !== 'HVDC' ? ` (${link})` : ''}`
                : kv
                  ? `${kv} kV`
                  : style.label;
        const subtype = String(prop(f.properties, 'FEATURE_SUBTYPE') ?? '').toLowerCase();
        return popupHtml(
            String(prop(f.properties, ...NAME_FIELDS) ?? 'Power line'),
            `${swatch(style.color)}${esc(headline)}` +
                (subtype ? ` · ${esc(subtype)}` : '') +
                this.statusNote(f),
            // For DC links the listed kV is GA's nominal figure, so it stays in the table.
            propsRows(f.properties, [...NAME_FIELDS, 'FEATURE_SUBTYPE']),
            GA_CREDIT,
        );
    }

    /** " · under construction" and the like, for anything that is not operational. */
    private statusNote(f: Feature): string {
        if (isOperational(f)) {
            return '';
        }
        return ` · ${esc(String(prop(f.properties, 'STATUS') ?? 'not operational').toLowerCase())}`;
    }

    private facilityFuel(f: OeFacility): FuelGroup {
        const biggest = [...f.units].sort(
            (a, b) => (b.capacity_registered ?? 0) - (a.capacity_registered ?? 0),
        )[0];
        return fuelGroup(biggest?.fueltech_id);
    }

    /** Net output in MW (generation minus load), or null if no unit has a reading. */
    private facilityOutput(f: OeFacility): number | null {
        let total = 0;
        let any = false;
        for (const u of f.units) {
            const r = this.readings.get(u.code);
            if (r) {
                any = true;
                // Loads are normally reported as negative already; force the sign to be safe.
                total += u.dispatch_type === 'LOAD' ? -Math.abs(r.mw) : r.mw;
            }
        }
        return any ? total : null;
    }

    private facilityHtml(f: OeFacility, loading: boolean): string {
        const fuel = this.facilityFuel(f);
        const output = this.facilityOutput(f);
        let latestTime = '';
        const unitRows = f.units
            .map(u => {
                const r = this.readings.get(u.code);
                if (r && r.time > latestTime) {
                    latestTime = r.time;
                }
                const cap = u.capacity_registered !== null ? fmtMW(u.capacity_registered) : '–';
                const now = r ? `<b>${esc(fmtMW(r.mw))}</b>` : loading ? '…' : '–';
                return row(
                    `${u.code}`,
                    `${now} of ${esc(cap)}<br><span style="color:#777">${esc(
                        (u.fueltech_id ?? '').replace(/_/g, ' '),
                    )}${u.dispatch_type === 'LOAD' ? ' (load)' : ''}</span>`,
                );
            })
            .join('');
        const headline =
            output !== null
                ? row('Output now', `<b>${esc(fmtMW(output))}</b>`)
                : row('Output now', loading ? 'Loading…' : 'No recent data');
        return popupHtml(
            f.name,
            `${swatch(FUEL_STYLES[fuel].color)}${esc(FUEL_STYLES[fuel].label)} · ` +
                `${esc(f.network_region || f.network_id)}`,
            headline + row('Capacity', esc(fmtMW(f.capacity))) + unitRows,
            OE_CREDIT + (latestTime ? ` · interval ${esc(latestTime.slice(0, 16).replace('T', ' '))}` : ''),
        );
    }

    // ---------- Leaflet helpers ----------

    /** Substations follow their own layer switch, their voltage's tick box and the zoom. */
    private substationShown(cls: VoltageClass, zoom: number): boolean {
        return (
            this.layerOn.substations && !!this.classOn.get(cls) && zoom >= substationMinZoom(cls)
        );
    }

    private classShown(id: VoltageClass, zoom: number): boolean {
        return this.layerOn.lines && !!this.classOn.get(id) && zoom >= VOLTAGE_BY_ID[id].minZoom;
    }

    /** Screen pixels per degree of longitude, measured from the map itself. */
    private pixelsPerDegree(zoom: number): number {
        try {
            const b = this.map.getBounds();
            const span = b.getEast() - b.getWest();
            const el = this.map.getContainer?.();
            const width =
                (el && el.clientWidth) || (typeof window !== 'undefined' ? window.innerWidth : 0);
            if (span > 0 && width > 0) {
                return width / span;
            }
        } catch (e) {
            // fall through to the estimate
        }
        return (256 * Math.pow(2, zoom)) / 360;
    }

    private pointTarget(
        list: PointTarget[],
        at: { lat: number; lng: number },
        radius: number,
        label: string,
        detail: string,
        weight: number,
        open: (latlng: { lat: number; lng: number }) => void,
    ): void {
        list.push({ lat: at.lat, lng: at.lng, radius, label, detail, weight, open });
    }

    private badge(lat: number, lng: number, html: string, bg: string, fg: string): any {
        const icon = this.makeDivIcon(
            `<div style="position:absolute;transform:translate(-50%,-50%);white-space:nowrap;` +
                `background:${bg};color:${fg};font-size:11px;line-height:1.25;text-align:center;` +
                `padding:3px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.6);` +
                `box-shadow:0 1px 4px rgba(0,0,0,.5);cursor:pointer">${html}</div>`,
        );
        return new this.L.Marker({ lat, lng }, { icon, bubblingMouseEvents: false });
    }

    private makeDivIcon(html: string): any {
        const options = { html, className: 'au-grid-badge', iconSize: [0, 0] };
        return typeof this.L.divIcon === 'function'
            ? this.L.divIcon(options)
            : new this.L.DivIcon(options);
    }

    private onClick(layer: any, handler: (latlng: any) => void): void {
        layer.on('click', (e: any) => {
            try {
                this.L.DomEvent?.stopPropagation?.(e);
            } catch (err) {
                // not every event object can be stopped; harmless
            }
            handler(e?.latlng ?? layer.getLatLng?.());
        });
    }

    private openPopup(latlng: any, html: string): void {
        if (!latlng) {
            return;
        }
        if (!this.popup) {
            this.popup = new this.L.Popup({ maxWidth: 320, autoPan: true });
        }
        this.popup.setLatLng(latlng).setContent(html);
        if (typeof this.popup.openOn === 'function') {
            this.popup.openOn(this.map);
        } else {
            this.map.openPopup(this.popup);
        }
    }

    private toggle(layer: any, show: boolean): void {
        if (!layer) {
            return;
        }
        const has = this.map.hasLayer(layer);
        if (show && !has) {
            this.map.addLayer(layer);
        } else if (!show && has) {
            this.map.removeLayer(layer);
        }
    }

    private removeLayer(layer: any): void {
        if (layer && this.map.hasLayer(layer)) {
            this.map.removeLayer(layer);
        }
    }
}
