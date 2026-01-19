import Pyroscope from '@pyroscope/nodejs';

export interface PyroscopeConfig {
    appName: string;
    serverAddress?: string;
    tags?: Record<string, string>;
}

let isInitialized = false;

export function initPyroscope(config: PyroscopeConfig): void {
    const serverAddress = config.serverAddress || process.env.PYROSCOPE_SERVER_ADDRESS;

    if (!serverAddress) {
        console.log('[Pyroscope] PYROSCOPE_SERVER_ADDRESS not set, skipping profiling');
        return;
    }

    if (isInitialized) {
        console.log('[Pyroscope] Already initialized, skipping');
        return;
    }

    try {
        Pyroscope.init({
            serverAddress,
            appName: config.appName,
            tags: {
                env: process.env.NODE_ENV || 'development',
                ...config.tags,
            },
        });

        Pyroscope.start();
        isInitialized = true;

        console.log(`[Pyroscope] Profiling started for ${config.appName} -> ${serverAddress}`);
    } catch (error) {
        console.error('[Pyroscope] Failed to initialize:', error);
    }
}

export function stopPyroscope(): void {
    if (isInitialized) {
        Pyroscope.stop();
        isInitialized = false;
        console.log('[Pyroscope] Profiling stopped');
    }
}
