import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-au-grid',
    version: '0.1.2',
    icon: '⚡',
    title: 'Australian Power Grid',
    description:
        'Australian power lines coloured by voltage, with substations and power stations. ' +
        'Tap anything for details.',
    author: 'dfraca',
    repository: 'https://github.com/dfraca/windy-plugin-au-grid',
    desktopUI: 'rhpane',
    mobileUI: 'small',
    desktopWidth: 320,
    routerPath: '/au-grid',
    // While the plugin is open, taps on the map come to it (see singleclick in plugin.svelte)
    // so they can open grid details; a tap that misses is handed back to Windy's picker.
    listenToSingleclick: true,
    private: true,
};

export default config;
