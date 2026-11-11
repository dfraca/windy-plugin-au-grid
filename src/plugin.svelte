<!--
    Australian Power Grid overlay.

    Two layouts: on phones and tablets (mobileUI: 'small') a compact strip of
    toggle chips that leaves the map visible; on desktop a right-hand pane.
-->
{#if isMobileOrTablet}
    <section class="au-mobile">
        <div class="chips">
            {#each layerChips as chip}
                <button
                    class="chip"
                    class:off={!show[chip.id]}
                    on:click={() => toggleLayer(chip.id)}
                >
                    {chip.label}
                </button>
            {/each}
            <span class="sep"></span>
            {#each labelChips as chip}
                <button
                    class="chip"
                    class:off={!labelShow[chip.id]}
                    on:click={() => toggleLabel(chip.id)}
                >
                    {chip.label}
                </button>
            {/each}
            {#if LIVE_DATA_ENABLED}
                <button
                    class="chip live"
                    class:off={!showLivePanel}
                    on:click={() => (showLivePanel = !showLivePanel)}
                >
                    Live data
                </button>
            {/if}
            <span class="sep"></span>
            {#each legend as item}
                <button
                    class="chip"
                    class:off={!classOn[item.id]}
                    on:click={() => toggleClass(item.id)}
                >
                    <span class="line" style="background:{item.color}"></span>
                    {item.label}
                </button>
            {/each}
            <span class="sep"></span>
            {#each fuels as fuel}
                <span class="fuel">
                    <span class="dot" style="background:{fuel.color}"></span>{fuel.label}
                </span>
            {/each}
        </div>
        {#if LIVE_DATA_ENABLED && showLivePanel}
            <div class="keyrow">
                <input
                    class="key"
                    type="password"
                    placeholder="Open Electricity API key"
                    autocomplete="off"
                    bind:value={apiKey}
                />
                <button class="btn" on:click={saveKey} disabled={busy}>
                    {connected ? 'Update' : 'Connect'}
                </button>
                {#if connected}
                    <button class="btn" on:click={refreshLive} disabled={busy}>
                        {busy ? '…' : 'Refresh'}
                    </button>
                {/if}
            </div>
        {/if}
        <p class="status one-line" class:error={liveMessage ? liveIsError : statusIsError}>
            {liveMessage || status}
        </p>
    </section>
{:else}
    <section class="plugin__content">
        <div
            class="plugin__title plugin__title--chevron-back"
            on:click={() => bcast.emit('rqstOpen', 'menu')}
        >
            {title}
        </div>

        <p class="status" class:error={statusIsError}>{status}</p>
        {#each warnings as warning}
            <p class="status error">{warning}</p>
        {/each}

        <h4>Layers</h4>
        {#each layerChips as chip}
            <label class="check">
                <input
                    type="checkbox"
                    checked={show[chip.id]}
                    on:change={() => toggleLayer(chip.id)}
                />
                {chip.long}
            </label>
        {/each}

        <h4>Voltage</h4>
        {#each legend as item}
            <label class="check">
                <input
                    type="checkbox"
                    checked={classOn[item.id]}
                    on:change={() => toggleClass(item.id)}
                />
                <span class="line" style="background:{item.color}"></span>
                {item.label}
                {#if item.minZoom > 0}<span class="hint">(zoom in)</span>{/if}
            </label>
        {/each}

        <h4>Labels</h4>
        {#each labelChips as chip}
            <label class="check">
                <input
                    type="checkbox"
                    checked={labelShow[chip.id]}
                    on:change={() => toggleLabel(chip.id)}
                />
                {chip.long}
            </label>
        {/each}

        <h4>Power stations</h4>
        <div class="fuels">
            {#each fuels as fuel}
                <span class="fuel">
                    <span class="dot" style="background:{fuel.color}"></span>{fuel.label}
                </span>
            {/each}
        </div>
        <p class="hint">Circle size shows capacity.</p>

        {#if LIVE_DATA_ENABLED}
        <h4>Live data</h4>
        {#if !connected}
            <p class="hint">
                Live output and flows come from Open Electricity. Paste an API key from
                platform.openelectricity.org.au. It is kept only in this browser.
            </p>
        {/if}
        <div class="keyrow">
            <input
                class="key"
                type="password"
                placeholder="Open Electricity API key"
                autocomplete="off"
                bind:value={apiKey}
            />
            <button class="btn" on:click={saveKey} disabled={busy}>
                {connected ? 'Update' : 'Connect'}
            </button>
        </div>
        {#if connected}
            <div class="keyrow">
                <button class="btn wide" on:click={refreshLive} disabled={busy}>
                    {busy ? 'Loading…' : 'Refresh live data'}
                </button>
            </div>
            <label class="check">
                <input type="checkbox" bind:checked={autoRefresh} on:change={applyAutoRefresh} />
                Refresh every 5 minutes
            </label>
            <p class="hint">
                Refresh loads the {MAX_LIVE_FACILITIES} largest generators in view. Click any
                generator for its own live reading.
            </p>
        {/if}
        {#if liveMessage}
            <p class="status" class:error={liveIsError}>{liveMessage}</p>
        {/if}
        {/if}

        <p class="credit">
            Network data: © Commonwealth of Australia (Geoscience Australia), CC BY 4.0{snapshotDate
                ? `, copied ${snapshotDate}`
                : ''}. Locations are indicative. Not for operational use.
        </p>
    </section>
{/if}

<script lang="ts">
    import bcast from '@windy/broadcast';
    import { map } from '@windy/map';
    import { isMobileOrTablet } from '@windy/rootScope';
    import { singleclick } from '@windy/singleclick';
    import { onDestroy, onMount } from 'svelte';

    import config from './pluginConfig';
    import { FUEL_STYLES, LIVE_DATA_ENABLED, VOLTAGE_STYLES } from './lib/config';
    import { loadGaData } from './lib/ga';
    import {
        deriveCorridorFlows,
        fetchFacilities,
        fetchRegionReadings,
        fetchUnitPower,
    } from './lib/oe';
    import { GridOverlay } from './lib/overlay';

    // IMPORTANT: types must be imported with `import type`, or the Svelte TS compiler fails.
    import type { VoltageClass } from './lib/config';
    import type { OeFacility } from './lib/oe';
    import type { LabelKind, LayerId } from './lib/overlay';

    const { name, title } = config;
    // Fingers are less precise than a mouse pointer.
    const TAP_TOLERANCE_PX = isMobileOrTablet ? 18 : 8;
    const STORAGE_KEY = 'windy-plugin-au-grid:oe-key';
    const MAX_LIVE_FACILITIES = 90;
    const REFRESH_MS = 5 * 60 * 1000;

    // Highest voltage first in the legend.
    const legend = [...VOLTAGE_STYLES].reverse();
    // Battery only appears in the live (Open Electricity) generator list.
    const fuels = Object.entries(FUEL_STYLES)
        .filter(([id]) => LIVE_DATA_ENABLED || id !== 'battery')
        .map(([, style]) => style);
    const allLayerChips: { id: LayerId; label: string; long: string }[] = [
        { id: 'lines', label: 'Lines', long: 'Power lines' },
        { id: 'substations', label: 'Substations', long: 'Substations' },
        { id: 'generators', label: 'Power stations', long: 'Power stations' },
        { id: 'flows', label: 'Flows', long: 'Live flows between regions' },
    ];
    const labelChips: { id: LabelKind; label: string; long: string }[] = [
        { id: 'lines', label: 'Line labels', long: 'Power lines' },
        { id: 'substations', label: 'Substation labels', long: 'Substations' },
        { id: 'stations', label: 'Station labels', long: 'Power stations' },
    ];
    const layerChips = allLayerChips.filter(c => LIVE_DATA_ENABLED || c.id !== 'flows');

    let overlay: GridOverlay | null = null;
    let status = 'Loading the grid…';
    let statusIsError = false;
    let warnings: string[] = [];
    let snapshotDate: string | null = null;

    let show: Record<LayerId, boolean> = {
        lines: true,
        substations: true,
        generators: true,
        flows: true,
    };
    let labelShow: Record<LabelKind, boolean> = { lines: true, substations: true, stations: true };
    let classOn = Object.fromEntries(VOLTAGE_STYLES.map(s => [s.id, true])) as Record<
        VoltageClass,
        boolean
    >;

    let apiKey = '';
    let connected = false;
    let busy = false;
    let autoRefresh = false;
    let showLivePanel = false;
    let liveMessage = '';
    let liveIsError = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let destroyed = false;
    const lastFetched = new Map<string, number>();

    function readStoredKey(): string {
        try {
            return window.localStorage.getItem(STORAGE_KEY) ?? '';
        } catch (e) {
            return '';
        }
    }

    function storeKey(value: string): void {
        try {
            if (value) {
                window.localStorage.setItem(STORAGE_KEY, value);
            } else {
                window.localStorage.removeItem(STORAGE_KEY);
            }
        } catch (e) {
            // Storage can be unavailable (private mode); the key then lasts for this session only.
        }
    }

    function toggleLayer(id: LayerId): void {
        show[id] = !show[id];
        show = show;
        overlay?.setLayerVisible(id, show[id]);
    }

    function toggleLabel(id: LabelKind): void {
        labelShow[id] = !labelShow[id];
        labelShow = labelShow;
        overlay?.setLabelVisible(id, labelShow[id]);
    }

    function toggleClass(id: VoltageClass): void {
        classOn[id] = !classOn[id];
        classOn = classOn;
        overlay?.setClassVisible(id, classOn[id]);
    }

    /**
     * Windy sends map taps here while the plugin is open (listenToSingleclick in pluginConfig).
     * A tap on grid infrastructure opens its details; anything else goes back to Windy's
     * own weather picker so the map still behaves normally.
     */
    function onMapClick(position: { lat: number; lon: number }): void {
        if (!position || !overlay) {
            return;
        }
        const hit = overlay.handleMapClick(position.lat, position.lon, TAP_TOLERANCE_PX);
        if (!hit) {
            try {
                bcast.emit('rqstOpen', isMobileOrTablet ? 'picker-mobile' : 'picker', {
                    lat: position.lat,
                    lon: position.lon,
                });
            } catch (e) {
                // No picker available in this Windy version; nothing else to do.
            }
        }
    }

    function onZoom(): void {
        overlay?.refreshVisibility();
    }

    /** Labels exist only for what is on screen, so they are rebuilt after every pan. */
    function onMove(): void {
        overlay?.refreshLabels();
    }

    function setLive(message: string, isError = false): void {
        liveMessage = message;
        liveIsError = isError;
    }

    function describeCounts(): string {
        const c = overlay?.counts();
        if (!c) {
            return '';
        }
        return `${c.lines} lines · ${c.substations} substations · ${c.generators} power stations. Tap anything for details.`;
    }

    async function loadGrid(): Promise<void> {
        try {
            const data = await loadGaData();
            if (destroyed || !overlay) {
                return;
            }
            overlay.setGaData(data);
            warnings = data.warnings;
            snapshotDate = data.snapshotDate;
            status = describeCounts();
            statusIsError = false;
        } catch (e) {
            status = `Could not load the grid: ${(e as Error).message}.`;
            statusIsError = true;
        }
    }

    async function saveKey(): Promise<void> {
        apiKey = apiKey.trim();
        storeKey(apiKey);
        if (!apiKey) {
            connected = false;
            setLive('');
            return;
        }
        await connectLive();
    }

    async function connectLive(): Promise<void> {
        if (!overlay || !apiKey) {
            return;
        }
        busy = true;
        setLive('Loading generators from Open Electricity…');
        try {
            const facilities = await fetchFacilities(apiKey);
            if (destroyed || !overlay) {
                return;
            }
            overlay.setFacilities(facilities);
            connected = true;
            status = describeCounts();
        } catch (e) {
            connected = false;
            setLive((e as Error).message, true);
            busy = false;
            return;
        }
        busy = false;
        await refreshLive();
    }

    async function refreshLive(): Promise<void> {
        if (!overlay || !apiKey || busy) {
            return;
        }
        busy = true;
        const problems: string[] = [];
        setLive('Loading live data…');

        try {
            const regions = await fetchRegionReadings(apiKey);
            if (!destroyed && overlay) {
                overlay.setFlows(regions, deriveCorridorFlows(regions));
            }
            if (!regions.size) {
                problems.push('No regional flow data was returned.');
            }
        } catch (e) {
            problems.push(`Flows: ${(e as Error).message}`);
        }

        try {
            const inView = overlay ? overlay.facilitiesInView(MAX_LIVE_FACILITIES) : [];
            const byNetwork = new Map<string, string[]>();
            for (const f of inView) {
                if (!byNetwork.has(f.network_id)) {
                    byNetwork.set(f.network_id, []);
                }
                (byNetwork.get(f.network_id) as string[]).push(f.code);
            }
            for (const [network, codes] of byNetwork) {
                const readings = await fetchUnitPower(apiKey, network, codes);
                if (destroyed || !overlay) {
                    return;
                }
                overlay.mergeUnitReadings(readings);
                codes.forEach(code => lastFetched.set(code, Date.now()));
            }
        } catch (e) {
            problems.push(`Generation: ${(e as Error).message}`);
        }

        busy = false;
        if (problems.length) {
            setLive(problems.join(' '), true);
        } else {
            setLive(`Live data updated ${new Date().toLocaleTimeString()}.`);
        }
    }

    /** One small request when a generator is tapped, unless its reading is already fresh. */
    async function loadFacilityLive(facility: OeFacility): Promise<void> {
        if (!overlay || !apiKey) {
            return;
        }
        const last = lastFetched.get(facility.code) ?? 0;
        if (Date.now() - last < 4 * 60 * 1000) {
            return;
        }
        lastFetched.set(facility.code, Date.now());
        try {
            const readings = await fetchUnitPower(apiKey, facility.network_id, [facility.code]);
            if (!destroyed && overlay) {
                overlay.mergeUnitReadings(readings);
            }
        } catch (e) {
            lastFetched.delete(facility.code);
            setLive(`Generation: ${(e as Error).message}`, true);
        }
    }

    /** If the map is looking somewhere else in the world, bring Australia into view. */
    function showAustralia(): void {
        try {
            const c = map.getCenter();
            const inAustralia = c.lat > -45 && c.lat < -9 && c.lng > 110 && c.lng < 156;
            if (!inAustralia) {
                map.setView([-28, 134], 4);
            }
        } catch (e) {
            // Leave the view alone if the map does not answer.
        }
    }

    function applyAutoRefresh(): void {
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        if (autoRefresh) {
            timer = setInterval(() => {
                void refreshLive();
            }, REFRESH_MS);
        }
    }

    export const onopen = (_params: unknown) => {
        // Nothing to do: the overlay is created on mount.
    };

    onMount(() => {
        // Windy exposes its Leaflet-style map library as the global `L`.
        const leaflet = typeof L !== 'undefined' ? L : (globalThis as any).L;
        if (!leaflet || !map) {
            status = 'The Windy map library was not found; this Windy version may be unsupported.';
            statusIsError = true;
            return;
        }
        overlay = new GridOverlay(leaflet, map);
        overlay.onFacilityClick = facility => {
            void loadFacilityLive(facility);
        };
        map.on('zoomend', onZoom);
        map.on('moveend', onMove);
        singleclick.on(name, onMapClick);

        showAustralia();
        apiKey = LIVE_DATA_ENABLED ? readStoredKey() : '';
        void loadGrid().then(() => {
            if (apiKey && !destroyed) {
                void connectLive();
            }
        });
    });

    onDestroy(() => {
        destroyed = true;
        if (timer) {
            clearInterval(timer);
        }
        map.off('zoomend', onZoom);
        map.off('moveend', onMove);
        singleclick.off(name, onMapClick);
        overlay?.destroy();
        overlay = null;
    });
</script>

<style lang="less">
    h4 {
        margin: 14px 0 6px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        opacity: 0.7;
    }
    .status {
        margin: 6px 0;
        font-size: 12px;
        line-height: 1.4;
        &.error {
            color: #ff8a80;
        }
        &.one-line {
            margin: 4px 8px 6px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
    }
    .check {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 0;
        font-size: 13px;
        cursor: pointer;
        input {
            margin: 0;
        }
    }
    .hint {
        font-size: 11px;
        opacity: 0.65;
        line-height: 1.4;
    }
    .line {
        display: inline-block;
        flex: none;
        width: 22px;
        height: 4px;
        border-radius: 2px;
    }
    .fuels {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        font-size: 12px;
        margin-bottom: 4px;
    }
    .fuel {
        display: inline-flex;
        flex: none;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        white-space: nowrap;
    }
    .dot {
        display: inline-block;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.7);
    }
    .keyrow {
        display: flex;
        gap: 6px;
        margin: 6px 0;
    }
    .key {
        flex: 1;
        min-width: 0;
        padding: 6px 8px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.3);
        background: rgba(0, 0, 0, 0.25);
        color: inherit;
        font-size: 12px;
    }
    .btn {
        padding: 6px 10px;
        border-radius: 4px;
        border: 0;
        background: #d49500;
        color: #fff;
        font-size: 12px;
        cursor: pointer;
        &.wide {
            flex: 1;
        }
        &:disabled {
            opacity: 0.5;
            cursor: default;
        }
    }
    .credit {
        margin-top: 16px;
        font-size: 10px;
        opacity: 0.55;
        line-height: 1.4;
    }

    // Phone layout: one scrolling row of chips, then an optional key row and a status line.
    .au-mobile {
        padding: 6px 0 0;
        .chips {
            display: flex;
            flex-direction: row;
            align-items: center;
            gap: 6px;
            padding: 0 8px 4px;
            overflow-x: auto;
            -webkit-overflow-scrolling: touch;
        }
        .chip {
            display: inline-flex;
            flex: none;
            align-items: center;
            gap: 5px;
            padding: 6px 10px;
            border-radius: 14px;
            border: 1px solid rgba(255, 255, 255, 0.55);
            background: rgba(255, 255, 255, 0.16);
            color: inherit;
            font-size: 12px;
            white-space: nowrap;
            &.off {
                opacity: 0.45;
                background: transparent;
            }
            &.live {
                border-color: #d49500;
            }
        }
        .sep {
            flex: none;
            width: 1px;
            height: 18px;
            background: rgba(255, 255, 255, 0.3);
        }
        .keyrow {
            margin: 4px 8px;
        }
    }
</style>
