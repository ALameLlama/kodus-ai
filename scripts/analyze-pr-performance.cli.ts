#!/usr/bin/env npx ts-node

/**
 * PR Performance Analysis CLI
 *
 * Usage:
 *   npx ts-node scripts/analyze-pr-performance.cli.ts <prNumber> [repoFullName] [--days=7]
 *
 * Examples:
 *   npx ts-node scripts/analyze-pr-performance.cli.ts 701 LumeWeb/web
 *   npx ts-node scripts/analyze-pr-performance.cli.ts 723 LumeWeb/web --days=1
 *
 * Or with pnpm script (after adding to package.json):
 *   pnpm analyze-pr 701 LumeWeb/web
 *
 * Environment variables (uses .env):
 *   API_MG_DB_HOST, API_MG_DB_PORT, API_MG_DB_USERNAME, API_MG_DB_PASSWORD, API_MG_DB_DATABASE
 *   Or: MONGODB_URI
 */

import * as dotenv from 'dotenv';
import { MongoClient, Db } from 'mongodb';
import * as path from 'path';

// Load .env - check for --env flag or DOTENV_CONFIG_PATH, otherwise use .env
const envArg = process.argv.find(a => a.startsWith('--env='));
const envPath = envArg
    ? path.resolve(envArg.split('=')[1])
    : process.env.DOTENV_CONFIG_PATH
        ? path.resolve(process.env.DOTENV_CONFIG_PATH)
        : path.resolve(__dirname, '../.env');

dotenv.config({ path: envPath });
console.log(`Using env file: ${envPath}`);

interface StageData {
    timestamp: Date;
    stage: string;
    durationMs: number;
}

interface LLMCallData {
    timestamp: Date;
    name: string;
    duration: number;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
}

interface AnalysisResult {
    prNumber: number;
    pipelineId: string;
    correlationId: string;
    totalDuration: number;
    stages: StageData[];
    llmCalls: LLMCallData[];
}

function buildMongoUri(): string {
    // Check for direct URI first
    if (process.env.MONGODB_URI) {
        return process.env.MONGODB_URI;
    }

    const host = process.env.API_MG_DB_HOST;
    const port = process.env.API_MG_DB_PORT;
    const username = process.env.API_MG_DB_USERNAME;
    const password = process.env.API_MG_DB_PASSWORD;
    const authSource = process.env.API_MG_DB_AUTH_SOURCE || 'admin';

    if (!host) {
        throw new Error('Missing MongoDB configuration. Set MONGODB_URI or API_MG_DB_* variables.');
    }

    if (username && password) {
        if (port) {
            return `mongodb://${username}:${password}@${host}:${port}/?authSource=${authSource}`;
        }
        return `mongodb+srv://${username}:${password}@${host}/?authSource=${authSource}`;
    }

    if (port) {
        return `mongodb://${host}:${port}`;
    }
    return `mongodb+srv://${host}`;
}

function formatDuration(ms: number): string {
    if (!ms) return '0ms';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
}

function padRight(str: string, len: number): string {
    return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
    return str.length >= len ? str.substring(0, len) : ' '.repeat(len - str.length) + str;
}

function truncate(str: string, len: number): string {
    return str.length <= len ? str : str.substring(0, len - 3) + '...';
}

async function analyzePR(
    db: Db,
    prNumber: number,
    repoFullName?: string,
    daysBack: number = 7
): Promise<AnalysisResult | null> {
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const end = new Date();

    console.log(`\n${'='.repeat(70)}`);
    console.log(`PR PERFORMANCE ANALYSIS - PR #${prNumber}`);
    console.log(`Repository: ${repoFullName || 'any'}`);
    console.log(`Date range: ${start.toISOString()} - ${end.toISOString()}`);
    console.log(`${'='.repeat(70)}\n`);

    const logsCollection = db.collection('observability_logs_ts');
    const telemetryCollection = db.collection('observability_telemetry');

    // Step 1: Find pipeline info
    console.log('Step 1: Finding pipeline...\n');

    const logQuery: any = {
        message: { $regex: `PR#${prNumber}` },
        timestamp: { $gte: start, $lte: end }
    };

    const prLog = await logsCollection.findOne(logQuery, {
        projection: {
            timestamp: 1,
            correlationId: 1,
            'attributes.organizationAndTeamData': 1,
            'attributes.pipelineId': 1
        }
    });

    if (!prLog) {
        console.log(`ERROR: No logs found for PR #${prNumber}`);
        return null;
    }

    const correlationId = prLog.correlationId;
    const teamId = (prLog as any).attributes?.organizationAndTeamData?.teamId;

    console.log(`Found correlationId: ${correlationId}`);
    console.log(`Found teamId: ${teamId}`);

    // Step 2: Find pipelineId
    console.log('\nStep 2: Finding pipelineId...\n');

    const pipelineLog = await logsCollection.findOne({
        component: 'PipelineExecutor',
        message: { $regex: 'Starting pipeline: CodeReviewPipeline' },
        timestamp: {
            $gte: new Date(prLog.timestamp.getTime() - 60000),
            $lte: new Date(prLog.timestamp.getTime() + 60000)
        },
        $or: [
            { 'attributes.organizationAndTeamData.teamId': teamId },
            { correlationId: correlationId }
        ]
    }, {
        projection: { 'attributes.pipelineId': 1, timestamp: 1 }
    });

    let pipelineId = (pipelineLog as any)?.attributes?.pipelineId;

    if (!pipelineId) {
        const altLog = await logsCollection.findOne({
            'attributes.pipelineId': { $exists: true },
            timestamp: {
                $gte: new Date(prLog.timestamp.getTime() - 60000),
                $lte: new Date(prLog.timestamp.getTime() + 30 * 60000)
            },
            $or: [
                { 'attributes.organizationAndTeamData.teamId': teamId },
                { message: { $regex: `PR#${prNumber}` } }
            ]
        });
        pipelineId = (altLog as any)?.attributes?.pipelineId;
    }

    if (!pipelineId) {
        console.log(`ERROR: Could not find pipelineId for PR #${prNumber}`);
        return null;
    }

    console.log(`Found pipelineId: ${pipelineId}`);

    // Step 3: Get stage times
    console.log('\nStep 3: Getting stage times...\n');

    const stagesAgg = await logsCollection.aggregate([
        {
            $match: {
                'attributes.pipelineId': pipelineId,
                message: { $regex: 'Stage.*completed' }
            }
        },
        {
            $addFields: {
                stageName: '$attributes.stage',
                durationMs: {
                    $toInt: {
                        $arrayElemAt: [
                            { $split: [
                                { $arrayElemAt: [{ $split: ['$message', 'completed in '] }, 1] },
                                'ms'
                            ] },
                            0
                        ]
                    }
                }
            }
        },
        {
            $project: {
                _id: 0,
                timestamp: 1,
                stage: '$stageName',
                durationMs: 1
            }
        },
        { $sort: { timestamp: 1 } }
    ]).toArray();

    const stages: StageData[] = stagesAgg as StageData[];

    if (stages.length === 0) {
        console.log(`ERROR: No stage data found for pipeline ${pipelineId}`);
        return null;
    }

    const totalDuration = stages.reduce((sum, s) => sum + (s.durationMs || 0), 0);

    console.log('STAGE TIMES:');
    console.log('-'.repeat(80));
    console.log(padRight('Stage', 50) + padLeft('Duration', 15) + padLeft('% Total', 10));
    console.log('-'.repeat(80));

    stages.forEach((s, i) => {
        const pct = ((s.durationMs / totalDuration) * 100).toFixed(1);
        const duration = formatDuration(s.durationMs);
        const highlight = s.durationMs > 60000 ? ' <<<' : '';
        console.log(padRight(`${i + 1}. ${s.stage}`, 50) + padLeft(duration, 15) + padLeft(`${pct}%`, 10) + highlight);
    });

    console.log('-'.repeat(80));
    console.log(padRight('TOTAL', 50) + padLeft(formatDuration(totalDuration), 15));

    // Step 4: Get LLM call details
    console.log('\n\nStep 4: Getting LLM call details...\n');

    const telemetryCorrelation = await telemetryCollection.findOne({
        timestamp: {
            $gte: new Date(prLog.timestamp.getTime() - 60000),
            $lte: new Date(prLog.timestamp.getTime() + 30 * 60000)
        },
        $or: [
            { 'attributes.prNumber': prNumber },
            { 'attributes.organizationAndTeamData.teamId': teamId }
        ],
        name: { $regex: 'LLMAnalysisService|CrossFileAnalysis|KodyRules' }
    });

    const telemetryCorrelationId = telemetryCorrelation?.correlationId || correlationId;

    const llmCallsRaw = await telemetryCollection.find({
        correlationId: telemetryCorrelationId,
        name: { $not: { $regex: 'workflow\\.job' } }
    }, {
        projection: {
            _id: 0,
            name: 1,
            duration: 1,
            timestamp: 1,
            'attributes.gen_ai.response.model': 1,
            'attributes.gen_ai.usage.input_tokens': 1,
            'attributes.gen_ai.usage.output_tokens': 1
        }
    }).sort({ timestamp: 1 }).toArray();

    const llmCalls: LLMCallData[] = llmCallsRaw.map((call: any) => ({
        timestamp: call.timestamp,
        name: call.name,
        duration: call.duration,
        model: call.attributes?.['gen_ai.response.model'],
        inputTokens: call.attributes?.['gen_ai.usage.input_tokens'],
        outputTokens: call.attributes?.['gen_ai.usage.output_tokens']
    }));

    if (llmCalls.length > 0) {
        console.log('LLM CALLS:');
        console.log('-'.repeat(110));
        console.log(padRight('Operation', 50) + padLeft('Model', 30) + padLeft('Tokens', 15) + padLeft('Duration', 12));
        console.log('-'.repeat(110));

        llmCalls.forEach(call => {
            const model = call.model || 'unknown';
            const tokens = `${call.inputTokens || 0}/${call.outputTokens || 0}`;
            const duration = formatDuration(call.duration);
            const highlight = call.duration > 60000 ? ' <<<' : '';

            console.log(
                padRight(call.name, 50) +
                padLeft(truncate(model, 29), 30) +
                padLeft(tokens, 15) +
                padLeft(duration, 12) +
                highlight
            );
        });

        console.log('-'.repeat(110));
    } else {
        console.log('No LLM call telemetry found for this correlationId.');

        // Try alternative search
        const altLlmCalls = await telemetryCollection.find({
            timestamp: {
                $gte: new Date(prLog.timestamp.getTime() - 60000),
                $lte: new Date(prLog.timestamp.getTime() + 30 * 60000)
            },
            'attributes.prNumber': prNumber
        }, {
            projection: {
                _id: 0,
                name: 1,
                duration: 1,
                correlationId: 1,
                'attributes.gen_ai.response.model': 1
            }
        }).sort({ timestamp: 1 }).limit(20).toArray();

        if (altLlmCalls.length > 0) {
            console.log(`\nFound ${altLlmCalls.length} LLM calls with prNumber=${prNumber}:`);
            console.log('-'.repeat(80));
            altLlmCalls.forEach((call: any) => {
                const model = call.attributes?.['gen_ai.response.model'] || 'unknown';
                const duration = formatDuration(call.duration);
                console.log(`${call.name}: ${duration} (${model})`);
            });

            // Update correlationId for return
            if (altLlmCalls[0]?.correlationId) {
                llmCalls.push(...altLlmCalls.map((c: any) => ({
                    timestamp: c.timestamp,
                    name: c.name,
                    duration: c.duration,
                    model: c.attributes?.['gen_ai.response.model']
                })));
            }
        }
    }

    // Step 5: Identify bottlenecks
    console.log('\n\nBOTTLENECKS (> 60s):');
    console.log('-'.repeat(60));

    const slowStages = stages.filter(s => s.durationMs > 60000);
    const slowLlmCalls = llmCalls.filter(c => c.duration > 60000);

    if (slowStages.length === 0 && slowLlmCalls.length === 0) {
        console.log('None found - all operations completed in < 60s');
    } else {
        slowStages.forEach(s => {
            console.log(`STAGE: ${s.stage} - ${formatDuration(s.durationMs)}`);
        });
        slowLlmCalls.forEach(c => {
            console.log(`LLM: ${c.name} - ${formatDuration(c.duration)} (${c.model || 'unknown'})`);
        });
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log('Analysis complete');
    console.log(`${'='.repeat(70)}\n`);

    return {
        prNumber,
        pipelineId,
        correlationId: telemetryCorrelationId,
        totalDuration,
        stages,
        llmCalls
    };
}

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
PR Performance Analysis CLI

Usage:
  npx ts-node scripts/analyze-pr-performance.cli.ts <prNumber> [repoFullName] [--days=7]

Arguments:
  prNumber      PR number to analyze (required)
  repoFullName  Repository full name, e.g., "LumeWeb/web" (optional)
  --days=N      Number of days to search back (default: 7)

Examples:
  npx ts-node scripts/analyze-pr-performance.cli.ts 701 LumeWeb/web
  npx ts-node scripts/analyze-pr-performance.cli.ts 723 LumeWeb/web --days=1

Environment:
  Uses MongoDB connection from .env file (API_MG_DB_* or MONGODB_URI)
`);
        process.exit(0);
    }

    const prNumber = parseInt(args[0], 10);
    if (isNaN(prNumber)) {
        console.error('ERROR: Invalid PR number');
        process.exit(1);
    }

    const repoFullName = args.find(a => !a.startsWith('--') && a !== args[0]);
    const daysArg = args.find(a => a.startsWith('--days='));
    const daysBack = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;

    let client: MongoClient | null = null;

    try {
        const uri = buildMongoUri();
        const dbName = process.env.API_MG_DB_DATABASE || 'kodus_db';

        console.log(`Connecting to MongoDB (database: ${dbName})...`);

        client = new MongoClient(uri);
        await client.connect();

        const db = client.db(dbName);

        await analyzePR(db, prNumber, repoFullName, daysBack);
    } catch (error) {
        console.error('ERROR:', error);
        process.exit(1);
    } finally {
        if (client) {
            await client.close();
        }
    }
}

main();
