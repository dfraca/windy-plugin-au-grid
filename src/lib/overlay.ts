import {
    CORRIDORS,
    FUEL_STYLES,
    NEM_REGIONS,
    SUBSTATION_MIN_ZOOM,
    VOLTAGE_BY_ID,
    VOLTAGE_STYLES,
    classifyVoltage,
    fuelGroup,
} from './config';
import type { FuelGroup, VoltageClass } from './config';
import type { Feature, GaData } from './ga';
import type { CorridorFlow, OeFacility, RegionReading, UnitReading } from './oe';
import { distanceKm, esc, fmtMW, num, popupHtml, prop, propsRows, row, swatch } from './util';

export type LayerId = 'lines' | 'substations' | 'generators' | 'flows';

const GA_CREDIT = 'Source: Geoscience Australia, National Electricity Infrastructure';
const OE_CREDIT = 'Live data: Open Electricity (AEMO dispatch, 5-minute)';

function lineText(f: Feature): string {
    const p = f.properties;
    return ['NAME', 'CLASS', 'DESCRIPTION', 'COMMENT_', 'COMMENT']
        .map(k => String(prop(p, k) ?? ''))
        .join(' ');
}

function lineKv(f: Feature): number | null {
    return num(prop(f.properties, 'CAPACITYKV', 'VOLTAGEKV', 'CAPACITY_KV', 'VOLTAGE_KV', 'VOLTAGE'));
}

function isOperational(f: Feature): boolean {
    const status = String(prop(f?.properties, 'OPERATIONALSTATUS', 'OPERATIONAL_STATUS', 'STATUS') ?? '');
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

/**
 * Owns every map layer the plugin draws. Receives the Leaflet namespace and the
 * Windy map instance rather than importing them, so the logic can be exercised
 * outside Windy.
 */
export class GridOverlay {
    private L: any;
    private map: any;

    private lineLayers = new Map<VoltageClass, any[]>();
    private substationLayer: any = null;
    private generatorLayer: any = null;
    private flowLayer: any = null;
    private popup: any = null;

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
            const show =
                this.layerOn.lines && !!this.classOn.get(style.id) && zoom >= style.minZoom;
            for (const layer of this.lineLayers.get(style.id) ?? []) {
                this.toggle(layer, show);
            }
        }
        this.toggle(this.substationLayer, this.layerOn.substations && zoom >= SUBSTATION_MIN_ZOOM);
        this.toggle(this.generatorLayer, this.layerOn.generators);
        this.toggle(this.flowLayer, this.layerOn.flows);
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
        [this.substationLayer, this.generatorLayer, this.flowLayer].forEach(l => this.removeLayer(l));
        this.substationLayer = this.generatorLayer = this.flowLayer = null;
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
        }

        for (const style of VOLTAGE_STYLES) {
            const features = byClass.get(style.id);
            if (!features || !features.length) {
                continue;
            }
            const collection = { type: 'FeatureCollection', features };
            const bind = (feature: Feature, layer: any) =>
                this.onClick(layer, latlng => {
                    this.openFacilityCode = null;
                    this.openPopup(latlng, this.lineHtml(feature, style.id));
                });

            const visible = new this.L.GeoJSON(collection, {
                bubblingMouseEvents: false,
                style: (feature: Feature) => ({
                    bubblingMouseEvents: false,
                    color: style.color,
                    weight: style.weight,
                    opacity: isOperational(feature) ? 0.95 : 0.4,
                    dashArray: isOperational(feature) ? undefined : '4 4',
                }),
                onEachFeature: bind,
            });
            // Wide, near-invisible twin so thin lines are easy to tap on a phone.
            const hit = new this.L.GeoJSON(collection, {
                bubblingMouseEvents: false,
                style: () => ({
                    bubblingMouseEvents: false,
                    color: style.color,
                    weight: 14,
                    opacity: 0.01,
                }),
                onEachFeature: bind,
            });
            this.lineLayers.set(style.id, [hit, visible]);
        }
    }

    private buildSubstations(): void {
        this.removeLayer(this.substationLayer);
        this.substationLayer = null;
        if (!this.ga) {
            return;
        }
        const group = new this.L.FeatureGroup();
        for (const f of this.ga.substations) {
            const at = pointLatLng(f);
            if (!at) {
                continue;
            }
            const kv = num(prop(f.properties, 'VOLTAGEKV', 'CAPACITYKV', 'VOLTAGE_KV', 'VOLTAGE'));
            const cls = classifyVoltage(kv);
            const marker = new this.L.CircleMarker(at, {
                bubblingMouseEvents: false,
                radius: 3.5,
                color: kv ? VOLTAGE_BY_ID[cls].color : '#333',
                weight: 1.5,
                fillColor: '#ffffff',
                fillOpacity: 1,
            });
            this.onClick(marker, latlng => {
                this.openFacilityCode = null;
                this.openPopup(
                    latlng,
                    popupHtml(
                        String(prop(f.properties, 'NAME') ?? 'Substation'),
                        'Substation',
                        propsRows(f.properties, ['NAME']),
                        GA_CREDIT,
                    ),
                );
            });
            group.addLayer(marker);
        }
        this.substationLayer = group;
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
        const group = new this.L.FeatureGroup();

        for (const f of this.gaStations()) {
            const at = pointLatLng(f);
            if (!at) {
                continue;
            }
            const p = f.properties;
            const fuel = fuelGroup(
                `${prop(p, 'PRIMARYFUELTYPE') ?? ''} ${prop(p, 'GENERATIONTYPE') ?? ''}`,
            );
            const mw = num(prop(p, 'GENERATIONMW', 'CAPACITYMW', 'CAPACITY_MW'));
            const marker = new this.L.CircleMarker(at, {
                bubblingMouseEvents: false,
                radius: capacityRadius(mw),
                color: '#ffffff',
                weight: 1,
                opacity: isOperational(f) ? 0.9 : 0.4,
                fillColor: FUEL_STYLES[fuel].color,
                fillOpacity: isOperational(f) ? 0.85 : 0.3,
            });
            this.onClick(marker, latlng => {
                this.openFacilityCode = null;
                this.openPopup(
                    latlng,
                    popupHtml(
                        String(prop(p, 'NAME') ?? 'Power station'),
                        `${swatch(FUEL_STYLES[fuel].color)}${esc(FUEL_STYLES[fuel].label)}` +
                            (mw ? ` · ${esc(fmtMW(mw))}` : ''),
                        propsRows(p, ['NAME']),
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
                    bubblingMouseEvents: false,
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
            this.onClick(marker, latlng => {
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
        return popupHtml(
            String(prop(f.properties, 'NAME') ?? 'Transmission line'),
            `${swatch(style.color)}${esc(cls === 'hvdc' ? 'HVDC link' : kv ? `${kv} kV` : style.label)}` +
                (isOperational(f) ? '' : ' · not operational'),
            propsRows(f.properties, ['NAME']),
            GA_CREDIT,
        );
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
