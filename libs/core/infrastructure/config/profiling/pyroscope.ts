import Pyroscope from '@pyroscope/nodejs';

export interface PyroscopeConfig {
    appName: string;
    serverAddress?: string;
    tags?: Record<string, string>;
    enableHeapProfiling?: boolean;
}

let isInitialized = false;

export function initPyroscope(config: PyroscopeConfig): void {
    const serverAddress = config.serverAddress || process.env.PYROSCOPE_SERVER_ADDRESS;
    const enableHeapProfiling = config.enableHeapProfiling ??
        process.env.PYROSCOPE_HEAP_PROFILING === 'true';

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
            // Heap profiling configuration
            heap: enableHeapProfiling ? {
                samplingIntervalBytes: 524288, // 512KB - sample every 512KB allocated
                stackDepth: 32,                // Capture up to 32 frames in stack traces
            } : undefined,
        });

        // Start CPU/Wall profiling
        Pyroscope.start();

        // Start heap profiling if enabled
        if (enableHeapProfiling) {
            Pyroscope.startHeapProfiling();
            console.log(`[Pyroscope] Heap profiling enabled for ${config.appName}`);
        }

        isInitialized = true;

        console.log(`[Pyroscope] Profiling started for ${config.appName} -> ${serverAddress}`);
    } catch (error) {
        console.error('[Pyroscope] Failed to initialize:', error);
    }
}

export async function stopPyroscope(): Promise<void> {
    if (isInitialized) {
        await Pyroscope.stopHeapProfiling();
        await Pyroscope.stop();
        isInitialized = false;
        console.log('[Pyroscope] Profiling stopped');
    }
}
