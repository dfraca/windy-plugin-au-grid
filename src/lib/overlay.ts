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

export type LayerId = 'lines' | 'substations' | 'generators' | 'flows' | 'labels';

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

function capacityRadius(mw: number | null): number {
    if (!mw || mw <= 0) {
        return 4;
    }
    return Math.max(4, Math.min(14, 3 + Math.sqrt(mw) / 3.2));
}

interface PointTarget {
    lat: number;
    lng: number;
    /** Drawn radius in pixels. */
    radius: number;
    /** Map label, e.g. "Eraring · 2880 MW". */
    label: string;
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
    /** Point half-way along the line, [lng, lat]; worked out on first use. */
    mid?: number[];
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

function shorten(name: string): string {
    const clean = name.replace(/\s+/g, ' ').trim();
    return clean.length > 36 ? `${clean.slice(0, 35)}…` : clean;
}

/** Point half-way along a line, as [lng, lat]. */
function midPoint(f: Feature): number[] | null {
    const parts = lineParts(f);
    const part = [...parts].sort((a, b) => b.length - a.length)[0];
    if (!part || part.length < 2) {
        return part && part[0] ? part[0] : null;
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
            const t = seg[i] === 0 ? 0 : run / seg[i];
            return [
                part[i][0] + t * (part[i + 1][0] - part[i][0]),
                part[i][1] + t * (part[i + 1][1] - part[i][1]),
            ];
        }
        run -= seg[i];
    }
    return part[part.length - 1];
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

/**
 * Owns every map layer the plugin draws. Receives the Leaflet namespace and the
 * Windy map instance rather than importing them, so the logic can be exercised
 * outside Windy.
 */
export class GridOverlay {
    private L: any;
    private map: any;

    private lineLayers = new Map<VoltageClass, any[]>();
    private substationLayers: { layer: any; minZoom: number }[] = [];
    private generatorLayer: any = null;
    private flowLayer: any = null;
    private labelLayer: any = null;
    private popup: any = null;

    // What a tap can land on. Taps are resolved here, not by the map library, so
    // that thin lines and small circles are easy to hit on a phone.
    private lineIndex: LineTarget[] = [];
    private generatorTargets: PointTarget[] = [];
    private majorSubstationTargets: PointTarget[] = [];
    private minorSubstationTargets: PointTarget[] = [];

    private ga: GaData | null = null;
    private facilities: OeFacility[] = [];
    private readings = new Map<string, UnitReading>();
    private openFacilityCode: string | null = null;

    private layerOn: Record<LayerId, boolean> = {
        lines: true,
        substations: true,
        generators: true,
        flows: true,
        labels: true,
    };
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
        for (const s of this.substationLayers) {
            this.toggle(s.layer, this.layerOn.substations && zoom >= s.minZoom);
        }
        this.toggle(this.generatorLayer, this.layerOn.generators);
        this.toggle(this.flowLayer, this.layerOn.flows);
        this.refreshLabels();
    }

    /**
     * Rebuilds the name labels for what is on screen. Call after the map moves or zooms.
     * Labels only exist for the current view, biggest assets first, and one that would
     * overlap an earlier label is left out, so the map never fills with text.
     */
    refreshLabels(): void {
        this.removeLayer(this.labelLayer);
        this.labelLayer = null;
        const zoom = Number(this.map.getZoom?.() ?? 5);
        if (!this.layerOn.labels || zoom < LABEL_ZOOM.bigStations) {
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

        type Candidate = {
            lat: number;
            lng: number;
            text: string;
            color: string;
            /** Pixels from the anchor to the label's left edge; null centres the label. */
            offset: number | null;
            order: number;
        };
        const candidates: Candidate[] = [];

        const addPoints = (targets: PointTarget[], color: string, tier: number, minWeight = 0) => {
            for (const t of targets) {
                if (t.label && t.weight >= minWeight && inView(t.lat, t.lng)) {
                    candidates.push({
                        lat: t.lat,
                        lng: t.lng,
                        text: t.label,
                        color,
                        offset: t.radius + 4,
                        order: tier * 1e6 - t.weight,
                    });
                }
            }
        };
        if (this.layerOn.generators) {
            addPoints(this.generatorTargets, '#ffffff', 0, zoom >= LABEL_ZOOM.stations ? 0 : 500);
        }
        if (this.layerOn.substations && zoom >= LABEL_ZOOM.majorSubstations) {
            addPoints(this.majorSubstationTargets, '#d6e4ff', 1);
        }
        if (this.layerOn.substations && zoom >= LABEL_ZOOM.substations) {
            addPoints(this.minorSubstationTargets, '#d6e4ff', 3);
        }
        if (zoom >= LABEL_ZOOM.majorLines) {
            const cx = (view.w + view.e) / 2;
            const cy = (view.s + view.n) / 2;
            for (const item of this.lineIndex) {
                if (!item.label || !this.classShown(item.cls, zoom)) {
                    continue;
                }
                const major = item.cls === 'hvdc' || item.kv >= 200;
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
                    item.mid = midPoint(item.feature) ?? [];
                }
                // Label the middle of the line; if that is off screen, the on-screen
                // corner of the line nearest the centre of the view.
                let at: number[] | null = item.mid.length && inView(item.mid[1], item.mid[0]) ? item.mid : null;
                if (!at) {
                    let best = Infinity;
                    for (const part of lineParts(item.feature)) {
                        for (const c of part) {
                            const d = Math.hypot(c[0] - cx, c[1] - cy);
                            if (d < best && inView(c[1], c[0])) {
                                best = d;
                                at = c;
                            }
                        }
                    }
                }
                if (at) {
                    candidates.push({
                        lat: at[1],
                        lng: at[0],
                        text: item.label,
                        color: VOLTAGE_BY_ID[item.cls].color,
                        offset: null,
                        order: (major ? 2 : 4) * 1e6 - item.kv,
                    });
                }
            }
        }

        candidates.sort((a, b) => a.order - b.order);
        const placed: { x: number; y: number; w: number; h: number }[] = [];
        const seen = new Set<string>();
        const group = new this.L.FeatureGroup();
        const height = LABEL_FONT_PX + 5;
        for (const c of candidates) {
            if (placed.length >= MAX_LABELS) {
                break;
            }
            if (seen.has(c.text)) {
                continue; // parallel circuits share a name; one label is enough
            }
            const width = c.text.length * LABEL_FONT_PX * 0.58 + 6;
            const ax = c.lng * scale;
            const ay = -mercatorY(c.lat) * scale;
            const box = {
                x: c.offset === null ? ax - width / 2 : ax + c.offset,
                y: ay - height / 2,
                w: width,
                h: height,
            };
            const clash = placed.some(
                p => box.x < p.x + p.w && p.x < box.x + box.w && box.y < p.y + p.h && p.y < box.y + box.h,
            );
            if (clash) {
                continue;
            }
            placed.push(box);
            seen.add(c.text);
            const position =
                c.offset === null
                    ? 'transform:translate(-50%,-50%)'
                    : `left:${c.offset.toFixed(0)}px;transform:translateY(-50%)`;
            const icon = this.makeDivIcon(
                `<div style="position:absolute;${position};white-space:nowrap;pointer-events:none;` +
                    `font:600 ${LABEL_FONT_PX}px/1.2 sans-serif;color:${c.color};` +
                    `text-shadow:0 0 2px #000,0 0 3px #000,0 0 4px #000,0 0 5px #000">${esc(c.text)}</div>`,
            );
            group.addLayer(
                new this.L.Marker({ lat: c.lat, lng: c.lng }, { icon, interactive: false, keyboard: false }),
            );
        }
        if (placed.length) {
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
        if (this.layerOn.substations && zoom >= MAJOR_SUBSTATION_MIN_ZOOM) {
            consider(this.majorSubstationTargets);
        }
        if (this.layerOn.substations && zoom >= SUBSTATION_MIN_ZOOM) {
            consider(this.minorSubstationTargets);
        }
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
        this.substationLayers.forEach(s => this.removeLayer(s.layer));
        this.substationLayers = [];
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
        this.substationLayers.forEach(s => this.removeLayer(s.layer));
        this.substationLayers = [];
        if (!this.ga) {
            return;
        }
        this.majorSubstationTargets = [];
        this.minorSubstationTargets = [];
        const major = new this.L.FeatureGroup();
        const minor = new this.L.FeatureGroup();
        for (const f of this.ga.substations) {
            const at = pointLatLng(f);
            if (!at) {
                continue;
            }
            const kv = num(prop(f.properties, 'VOLTAGEKV', 'CAPACITYKV', 'VOLTAGE_KV', 'VOLTAGE'));
            const cls = classifyVoltage(kv);
            const isMajor = kv !== null && kv >= 200;
            const live = isOperational(f);
            const marker = new this.L.CircleMarker(at, {
                interactive: false,
                radius: isMajor ? 4.5 : 3.5,
                color: kv ? VOLTAGE_BY_ID[cls].color : '#333',
                weight: isMajor ? 2 : 1.5,
                opacity: live ? 1 : 0.5,
                fillColor: '#ffffff',
                fillOpacity: live ? 1 : 0.5,
            });
            const subName = shorten(String(prop(f.properties, ...NAME_FIELDS) ?? ''));
            const subLabel = subName && subName !== 'Unknown' ? `${subName}${kv ? ` · ${kv} kV` : ''}` : '';
            this.pointTarget(isMajor ? this.majorSubstationTargets : this.minorSubstationTargets, at, isMajor ? 4.5 : 3.5, subLabel, kv ?? 0, latlng => {
                this.openFacilityCode = null;
                const subtype = String(prop(f.properties, 'FEATURE_SUBTYPE') ?? '');
                const kind = subtype && subtype !== 'Substation' ? `${subtype} substation` : 'Substation';
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
            });
            (isMajor ? major : minor).addLayer(marker);
        }
        this.substationLayers = [
            { layer: minor, minZoom: SUBSTATION_MIN_ZOOM },
            { layer: major, minZoom: MAJOR_SUBSTATION_MIN_ZOOM },
        ];
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
                radius: capacityRadius(mw),
                color: '#ffffff',
                weight: 1,
                opacity: isOperational(f) ? 0.9 : 0.4,
                fillColor: FUEL_STYLES[fuel].color,
                fillOpacity: isOperational(f) ? 0.85 : 0.3,
            });
            const stationName = shorten(String(prop(p, ...NAME_FIELDS) ?? ''));
            const stationLabel = stationName ? `${stationName}${mw ? ` · ${fmtMW(mw)}` : ''}` : '';
            this.pointTarget(this.generatorTargets, at, capacityRadius(mw), stationLabel, mw ?? 0, latlng => {
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
                    radius: capacityRadius(f.capacity),
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
            this.pointTarget(this.generatorTargets, { lat: f.lat, lng: f.lng }, capacityRadius(f.capacity), `${shorten(f.name)}${f.capacity ? ` · ${fmtMW(f.capacity)}` : ''}`, f.capacity, latlng => {
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
        weight: number,
        open: (latlng: { lat: number; lng: number }) => void,
    ): void {
        list.push({ lat: at.lat, lng: at.lng, radius, label, weight, open });
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
