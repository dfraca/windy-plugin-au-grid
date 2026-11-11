import type { ExternalPluginConfig } from '@windy/interfaces';

const config: ExternalPluginConfig = {
    name: 'windy-plugin-au-grid',
    version: '0.1.0',
    icon: '⚡',
    title: 'Australian Power Grid',
    description:
        'Transmission lines by voltage, substations and generators across Australia, ' +
        'with live generation and interconnector flows for the NEM and WEM.',
    author: 'dfraca',
    repository: 'https://github.com/dfraca/windy-plugin-au-grid',
    desktopUI: 'rhpane',
    mobileUI: 'small',
    desktopWidth: 320,
    routerPath: '/au-grid',
    private: true,
};

export default config;
