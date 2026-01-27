import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { BetterStackClient } from './betterstack.client';

type IncidentSeverity = 'critical' | 'major' | 'minor';

interface ReportParams {
    key: string;
    title: string;
    description: string;
    component?: string;
}

@Injectable()
export class IncidentManagerService {
    private readonly logger = createLogger(IncidentManagerService.name);
    private readonly deduplicationMap = new Map<string, number>();

    private static readonly DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

    constructor(private readonly betterStackClient: BetterStackClient) {}

    async pingHeartbeat(envKey: string): Promise<void> {
        const url = process.env[envKey];

        if (!url) {
            this.logger.debug({
                message: `Heartbeat URL not configured for ${envKey}, skipping ping`,
                context: IncidentManagerService.name,
            });
            return;
        }

        await this.betterStackClient.pingHeartbeat(url);
    }

    async failHeartbeat(envKey: string, message: string): Promise<void> {
        const url = process.env[envKey];

        if (!url) {
            this.logger.debug({
                message: `Heartbeat URL not configured for ${envKey}, skipping fail report`,
                context: IncidentManagerService.name,
            });
            return;
        }

        await this.betterStackClient.failHeartbeat(url, message);
    }

    async reportCritical(params: ReportParams): Promise<void> {
        await this.report('critical', params);
    }

    async reportMajor(params: ReportParams): Promise<void> {
        await this.report('major', params);
    }

    async reportMinor(params: ReportParams): Promise<void> {
        await this.report('minor', params);
    }

    private async report(
        severity: IncidentSeverity,
        params: ReportParams,
    ): Promise<void> {
        const deduplicationKey = `${severity}:${params.key}`;

        if (this.isDuplicate(deduplicationKey)) {
            this.logger.debug({
                message: `Incident deduplicated (already reported within window)`,
                context: IncidentManagerService.name,
                metadata: {
                    key: params.key,
                    severity,
                    title: params.title,
                },
            });
            return;
        }

        this.deduplicationMap.set(deduplicationKey, Date.now());

        this.logger.warn({
            message: `Incident reported: [${severity.toUpperCase()}] ${params.title}`,
            context: IncidentManagerService.name,
            metadata: {
                key: params.key,
                severity,
                title: params.title,
                description: params.description,
                component: params.component,
            },
        });

        const summary = params.component
            ? `[${params.component}] ${params.description}`
            : params.description;

        await this.betterStackClient.createIncident({
            name: params.title,
            summary,
            severity,
        });
    }

    private isDuplicate(key: string): boolean {
        const lastReported = this.deduplicationMap.get(key);

        if (!lastReported) {
            return false;
        }

        const elapsed = Date.now() - lastReported;

        if (elapsed >= IncidentManagerService.DEDUP_WINDOW_MS) {
            this.deduplicationMap.delete(key);
            return false;
        }

        return true;
    }
}
