#!/usr/bin/env npx ts-node

/**
 * PR Performance Analysis CLI
 *
 * Usage:
 *   npx ts-node scripts/analyze-pr-performance.cli.ts <prNumber> <orgId> [options]
 *
 * Examples:
 *   npx ts-node scripts/analyze-pr-performance.cli.ts 558 04bd288b-595a-4ee1-87cd-8bbbdc312b3c --env=.env.prod
 *   npx ts-node scripts/analyze-pr-performance.cli.ts 723 97442318-9d2a-496b-a0d2-b45fb --days=1 --env=.env.prod
 *
 * Or with yarn script:
 *   yarn analyze-pr 558 04bd288b-595a-4ee1-87cd-8bbbdc312b3c --env=.env.prod
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
    reasoningTokens?: number;
    filePath?: string;
}

interface PipelineInfo {
    pipelineId: string;
    correlationId: string;
    organizationId?: string;
    teamId?: string;
    repository?: string;
    status?: string;
    startTime?: Date;
    endTime?: Date;
}

interface AnalysisResult {
    prNumber: number;
    pipelineInfo: PipelineInfo;
    totalDuration: number;
    stages: StageData[];
    llmCalls: LLMCallData[];
    summary: {
        totalLLMCalls: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalReasoningTokens: number;
        slowCallsCount: number;
        modelsUsed: string[];
    };
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

// Helper to find in log collections (optionally include legacy)
async function findOneInLogs(db: Db, query: any, options?: any, includeLegacy: boolean = false): Promise<any> {
    const logsTs = db.collection('observability_logs_ts');

    let result = await logsTs.findOne(query, options);
    if (!result && includeLegacy) {
        const logs = db.collection('observability_logs');
        result = await logs.findOne(query, options);
    }
    return result;
}

async function analyzePR(
    db: Db,
    prNumber: number,
    orgId: string,
    daysBack: number = 7,
    includeLegacy: boolean = false
): Promise<AnalysisResult | null> {
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const end = new Date();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`PR PERFORMANCE ANALYSIS - PR #${prNumber}`);
    console.log(`Organization: ${orgId}`);
    console.log(`Date range: ${start.toISOString()} - ${end.toISOString()}`);
    console.log(`${'='.repeat(80)}\n`);

    const telemetryCollection = db.collection('observability_telemetry');

    // Step 1: Find pipeline info
    console.log('Step 1: Finding pipeline...\n');

    const logQuery: any = {
        timestamp: { $gte: start, $lte: end },
        $and: [
            {
                $or: [
                    { 'attributes.organizationId': orgId },
                    { 'attributes.organizationAndTeamData.organizationId': orgId }
                ]
            },
            {
                $or: [
                    { 'attributes.prNumber': prNumber },
                    { 'attributes.pullRequest.number': prNumber },
                    { message: { $regex: `PR#${prNumber}` } }
                ]
            }
        ]
    };

    const prLog = await findOneInLogs(db, logQuery, {
        projection: {
            timestamp: 1,
            correlationId: 1,
            'attributes.organizationAndTeamData': 1,
            'attributes.pipelineId': 1,
            'attributes.repository': 1
        }
    }, includeLegacy);

    if (!prLog) {
        console.log(`ERROR: No logs found for PR #${prNumber} with orgId ${orgId}`);
        return null;
    }

    const correlationId = prLog.correlationId;
    const teamId = (prLog as any).attributes?.organizationAndTeamData?.teamId;
    const repository = (prLog as any).attributes?.organizationAndTeamData?.repository?.fullName ||
                       (prLog as any).attributes?.repository?.fullName;

    console.log(`Found correlationId: ${correlationId}`);
    console.log(`Found teamId: ${teamId}`);
    if (repository) console.log(`Found repository: ${repository}`);

    // Step 2: Find pipelineId
    console.log('\nStep 2: Finding pipelineId...\n');

    const pipelineLog = await findOneInLogs(db, {
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
    }, includeLegacy);

    let pipelineId = (pipelineLog as any)?.attributes?.pipelineId;

    if (!pipelineId) {
        const altLog = await findOneInLogs(db, {
            'attributes.pipelineId': { $exists: true },
            timestamp: {
                $gte: new Date(prLog.timestamp.getTime() - 60000),
                $lte: new Date(prLog.timestamp.getTime() + 30 * 60000)
            },
            $or: [
                { 'attributes.organizationAndTeamData.teamId': teamId },
                { message: { $regex: `PR#${prNumber}` } }
            ]
        }, undefined, includeLegacy);
        pipelineId = (altLog as any)?.attributes?.pipelineId;
    }

    if (!pipelineId) {
        console.log(`ERROR: Could not find pipelineId for PR #${prNumber}`);
        return null;
    }

    console.log(`Found pipelineId: ${pipelineId}`);

    // Step 3: Get stage times
    console.log(`\nStep 3: Getting stage times${includeLegacy ? ' (including legacy)' : ''}...\n`);

    const stageMatchQuery = {
        'attributes.pipelineId': pipelineId,
        message: { $regex: 'Stage.*completed' }
    };

    const stagePipeline: any[] = [
        { $match: stageMatchQuery }
    ];

    if (includeLegacy) {
        stagePipeline.push({
            $unionWith: {
                coll: 'observability_logs',
                pipeline: [{ $match: stageMatchQuery }]
            }
        });
    }

    stagePipeline.push(
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
    );

    const stagesAgg = await db.collection('observability_logs_ts').aggregate(stagePipeline).toArray();

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

    // Search by prNumber and orgId directly for more reliable results
    const llmCallsRaw = await telemetryCollection.find({
        'attributes.prNumber': prNumber,
        'attributes.organizationId': orgId,
        name: { $not: { $regex: 'workflow\\.job' } }
    }, {
        projection: {
            _id: 0,
            name: 1,
            duration: 1,
            timestamp: 1,
            attributes: 1
        }
    }).sort({ duration: -1 }).toArray();

    const llmCalls: LLMCallData[] = llmCallsRaw.map((call: any) => ({
        timestamp: call.timestamp,
        name: call.name,
        duration: call.duration,
        model: call.attributes?.['gen_ai.response.model'],
        inputTokens: call.attributes?.['gen_ai.usage.input_tokens'],
        outputTokens: call.attributes?.['gen_ai.usage.output_tokens'],
        reasoningTokens: call.attributes?.['gen_ai.usage.reasoning_tokens'],
        filePath: call.attributes?.file?.filePath
    }));

    if (llmCalls.length > 0) {
        // Group calls by type for better readability
        const fileAnalysisCalls = llmCalls.filter(c => c.name.includes('analyzeCodeWithAI'));
        const kodyRulesCalls = llmCalls.filter(c => c.name.includes('kodyRulesAnalyzeCodeWithAI'));
        const otherCalls = llmCalls.filter(c =>
            !c.name.includes('analyzeCodeWithAI') && !c.name.includes('kodyRulesAnalyzeCodeWithAI')
        );

        if (fileAnalysisCalls.length > 0) {
            console.log('FILE ANALYSIS CALLS (sorted by duration):');
            console.log('-'.repeat(110));
            fileAnalysisCalls.forEach((call, i) => {
                const duration = formatDuration(call.duration);
                const highlight = call.duration > 60000 ? ' <<<' : '';
                const filePath = call.filePath || 'unknown';
                const model = call.model || 'unknown';
                const tokens = `${call.inputTokens || 0} in / ${call.outputTokens || 0} out`;
                const reasoning = call.reasoningTokens ? ` / ${call.reasoningTokens} reasoning` : '';

                console.log(`${String(i + 1).padStart(2)}. ${duration.padStart(8)}${highlight} | ${filePath}`);
                console.log(`              Model: ${truncate(model, 25)} | Tokens: ${tokens}${reasoning}`);
            });
            console.log('-'.repeat(110));
        }

        if (kodyRulesCalls.length > 0) {
            console.log('\nKODY RULES CALLS (sorted by duration):');
            console.log('-'.repeat(110));
            kodyRulesCalls.forEach((call, i) => {
                const duration = formatDuration(call.duration);
                const highlight = call.duration > 60000 ? ' <<<' : '';
                const filePath = call.filePath || 'unknown';
                const model = call.model || 'unknown';
                const tokens = `${call.inputTokens || 0} in / ${call.outputTokens || 0} out`;

                console.log(`${String(i + 1).padStart(2)}. ${duration.padStart(8)}${highlight} | ${filePath}`);
                console.log(`              Model: ${truncate(model, 25)} | Tokens: ${tokens}`);
            });
            console.log('-'.repeat(110));
        }

        if (otherCalls.length > 0) {
            console.log('\nOTHER LLM CALLS (sorted by duration):');
            console.log('-'.repeat(110));
            otherCalls.forEach((call, i) => {
                const duration = formatDuration(call.duration);
                const highlight = call.duration > 60000 ? ' <<<' : '';
                const model = call.model || 'unknown';
                const tokens = `${call.inputTokens || 0} in / ${call.outputTokens || 0} out`;

                console.log(`${String(i + 1).padStart(2)}. ${duration.padStart(8)}${highlight} | ${call.name}`);
                console.log(`              Model: ${truncate(model, 25)} | Tokens: ${tokens}`);
            });
            console.log('-'.repeat(110));
        }
    } else {
        console.log('No LLM call telemetry found for this PR.');
    }

    // Step 5: Calculate summary metrics
    const totalInputTokens = llmCalls.reduce((sum, c) => sum + (c.inputTokens || 0), 0);
    const totalOutputTokens = llmCalls.reduce((sum, c) => sum + (c.outputTokens || 0), 0);
    const totalReasoningTokens = llmCalls.reduce((sum, c) => sum + (c.reasoningTokens || 0), 0);
    const slowCallsCount = llmCalls.filter(c => c.duration > 60000).length;
    const modelsUsed = [...new Set(llmCalls.map(c => c.model).filter(Boolean))] as string[];

    // Step 6: Print summary
    console.log('\n\nSUMMARY:');
    console.log('-'.repeat(60));
    console.log(`Total Pipeline Duration: ${formatDuration(totalDuration)}`);
    console.log(`Total LLM Calls: ${llmCalls.length}`);
    console.log(`Total Tokens: ${totalInputTokens.toLocaleString()} input / ${totalOutputTokens.toLocaleString()} output / ${totalReasoningTokens.toLocaleString()} reasoning`);
    console.log(`Slow Calls (>60s): ${slowCallsCount}`);
    if (modelsUsed.length > 0) {
        console.log(`Models Used: ${modelsUsed.join(', ')}`);
    }

    // Step 7: Identify bottlenecks
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
            const fileInfo = c.filePath ? ` [${c.filePath}]` : '';
            console.log(`LLM: ${c.name} - ${formatDuration(c.duration)} (${c.model || 'unknown'})${fileInfo}`);
        });
    }

    // Step 8: Get pipeline status
    const pipelineEndLog = await findOneInLogs(db, {
        'attributes.pipelineId': pipelineId,
        message: { $regex: 'Finished pipeline|Pipeline failed|Pipeline error' }
    }, {
        projection: { message: 1, timestamp: 1 }
    }, includeLegacy);

    let pipelineStatus = 'unknown';
    if (pipelineEndLog) {
        if (pipelineEndLog.message.includes('Finished')) pipelineStatus = 'completed';
        else if (pipelineEndLog.message.includes('failed') || pipelineEndLog.message.includes('error')) pipelineStatus = 'failed';
    }

    console.log(`\nPipeline Status: ${pipelineStatus.toUpperCase()}`);

    console.log(`\n${'='.repeat(80)}`);
    console.log('Analysis complete');
    console.log(`${'='.repeat(80)}\n`);

    return {
        prNumber,
        pipelineInfo: {
            pipelineId,
            correlationId,
            organizationId: orgId,
            teamId,
            repository,
            status: pipelineStatus,
            startTime: prLog.timestamp,
            endTime: pipelineEndLog?.timestamp
        },
        totalDuration,
        stages,
        llmCalls,
        summary: {
            totalLLMCalls: llmCalls.length,
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
            slowCallsCount,
            modelsUsed
        }
    };
}

async function main() {
    const args = process.argv.slice(2).filter(a => !a.startsWith('--env='));

    if (args.length < 2 || args.includes('--help') || args.includes('-h')) {
        console.log(`
PR Performance Analysis CLI

Usage:
  npx ts-node scripts/analyze-pr-performance.cli.ts <prNumber> <orgId> [options]

Arguments:
  prNumber    PR number to analyze (required)
  orgId       Organization ID (required)

Options:
  --days=N      Number of days to search back (default: 7)
  --legacy      Also search in legacy collection (observability_logs)
  --env=PATH    Path to .env file (e.g., --env=.env.prod)

Examples:
  npx ts-node scripts/analyze-pr-performance.cli.ts 558 04bd288b-595a-4ee1-87cd-8bbbdc312b3c --env=.env.prod
  npx ts-node scripts/analyze-pr-performance.cli.ts 723 97442318-9d2a-496b-a0d2-b45fb --days=1 --env=.env.prod
  npx ts-node scripts/analyze-pr-performance.cli.ts 701 97442318-9d2a-496b-a0d2-b45fb --legacy --env=.env.prod
`);
        process.exit(0);
    }

    const prNumber = parseInt(args[0], 10);
    if (isNaN(prNumber)) {
        console.error('ERROR: Invalid PR number');
        process.exit(1);
    }

    const orgId = args[1];
    if (!orgId || orgId.startsWith('--')) {
        console.error('ERROR: Organization ID is required');
        process.exit(1);
    }

    const daysArg = args.find(a => a.startsWith('--days='));
    const daysBack = daysArg ? parseInt(daysArg.split('=')[1], 10) : 7;
    const includeLegacy = args.includes('--legacy');

    let client: MongoClient | null = null;

    try {
        const uri = buildMongoUri();
        const dbName = process.env.API_MG_DB_DATABASE || 'kodus_db';

        console.log(`Connecting to MongoDB (database: ${dbName})...`);

        client = new MongoClient(uri);
        await client.connect();

        const db = client.db(dbName);

        await analyzePR(db, prNumber, orgId, daysBack, includeLegacy);
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
