#!/usr/bin/env npx ts-node

/**
 * LangSmith eval runner for the cross-file analysis prompt.
 *
 * Usage:
 *   npx ts-node scripts/crossfile-eval.cli.ts --env=.env.prod
 *   npx ts-node scripts/crossfile-eval.cli.ts --max-concurrency=4 --experiment-prefix=crossfile
 */

import * as dotenv from 'dotenv';
import { Client } from 'langsmith';
import { evaluate, type EvaluatorT, type EvaluationResult } from 'langsmith/evaluation';
import { Logger } from '@nestjs/common';
import {
    BYOKProviderService,
    LLMModelProvider,
    LLMProviderService,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { BYOKProvider } from '@kodus/kodus-common/llm';

import {
    CrossFileAnalysisPayload,
    CrossFileAnalysisSchema,
    CrossFileAnalysisSchemaType,
    prompt_codereview_cross_file_analysis,
} from '../../libs/common/utils/langchainCommon/prompts/codeReviewCrossFileAnalysis';

type DatasetConfig = {
    id: string;
    label: 'quality' | 'suppression';
    evaluatorPrompt: string;
    gateKeys: string[];
};

const DATASETS: DatasetConfig[] = [
    {
        id: '8cf18f34-65dd-42d4-87e4-253ae01e9530',
        label: 'quality',
        evaluatorPrompt: 'eval_cross_file_dataset_cross_file_evaluator_9f0d79e3',
        gateKeys: ['pr_review_evaluation'],
    },
    {
        id: '5cb83c22-9d25-481f-a50e-437af3168065',
        label: 'suppression',
        evaluatorPrompt:
            'eval_cross_file_supression_dataset_cross_file_supression_eval_3b36a361',
        gateKeys: ['validate_suppression'],
    },
];

const DEFAULT_LANGUAGE = 'en-US';
const RUN_NAME = 'crossFileAnalyzeCodeWithAI';
const MAX_REASONING_TOKENS = 5000;

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith('--env='));
const maxConcurrencyArg = args.find((a) => a.startsWith('--max-concurrency='));
const experimentPrefixArg = args.find((a) =>
    a.startsWith('--experiment-prefix='),
);
const datasetArg = args.find((a) => a.startsWith('--dataset='));
const inspectFull = args.includes('--inspect-full');
const inspectEvaluatorArg = args.find((a) =>
    a.startsWith('--inspect-evaluator='),
);
const inspectOnly =
    args.includes('--inspect') || inspectFull || !!inspectEvaluatorArg;
const judgeProviderArg = args.find((a) => a.startsWith('--judge-provider='));
const judgeModelArg = args.find((a) => a.startsWith('--judge-model='));
const judgeBaseUrlArg = args.find((a) => a.startsWith('--judge-base-url='));
const thresholdArg = args.find((a) => a.startsWith('--threshold='));
const thresholdQualityArg = args.find((a) =>
    a.startsWith('--threshold-quality='),
);
const thresholdSuppressionArg = args.find((a) =>
    a.startsWith('--threshold-suppression='),
);

const envPath = envArg ? envArg.split('=')[1] : process.env.DOTENV_CONFIG_PATH;

if (envPath) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

function inferByokProvider(model?: string): BYOKProvider | undefined {
    if (!model) return undefined;
    const lower = model.toLowerCase();
    if (
        lower.startsWith('gpt-') ||
        lower.startsWith('o1') ||
        lower.startsWith('o3') ||
        lower.startsWith('o4')
    ) {
        return BYOKProvider.OPENAI;
    }
    if (lower.startsWith('claude')) {
        return BYOKProvider.ANTHROPIC;
    }
    if (lower.startsWith('gemini')) {
        return BYOKProvider.GOOGLE_GEMINI;
    }
    return undefined;
}

function parseJudgeProvider(value?: string): BYOKProvider | undefined {
    if (!value) return undefined;
    const normalized = value.toLowerCase();
    switch (normalized) {
        case 'openai':
            return BYOKProvider.OPENAI;
        case 'openai_compatible':
            return BYOKProvider.OPENAI_COMPATIBLE;
        case 'anthropic':
            return BYOKProvider.ANTHROPIC;
        case 'google_gemini':
        case 'gemini':
            return BYOKProvider.GOOGLE_GEMINI;
        case 'google_vertex':
        case 'vertex':
            return BYOKProvider.GOOGLE_VERTEX;
        case 'open_router':
        case 'openrouter':
            return BYOKProvider.OPEN_ROUTER;
        case 'novita':
            return BYOKProvider.NOVITA;
        default:
            return undefined;
    }
}

const judgeModel =
    (judgeModelArg ? judgeModelArg.split('=')[1] : undefined) ||
    process.env.EVAL_JUDGE_MODEL;
const judgeBaseUrl =
    (judgeBaseUrlArg ? judgeBaseUrlArg.split('=')[1] : undefined) ||
    process.env.EVAL_JUDGE_BASE_URL;
const judgeApiKey = process.env.EVAL_JUDGE_API_KEY;

const DEFAULT_THRESHOLD_QUALITY = 0.7;
const DEFAULT_THRESHOLD_SUPPRESSION = 0.7;

const parsedThreshold = thresholdArg
    ? Number(thresholdArg.split('=')[1])
    : process.env.EVAL_THRESHOLD
      ? Number(process.env.EVAL_THRESHOLD)
      : undefined;

const thresholdAllOverride =
    parsedThreshold !== undefined &&
    Number.isFinite(parsedThreshold) &&
    parsedThreshold >= 0
        ? parsedThreshold
        : undefined;

function parseThresholdValue(value?: string) {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const thresholdByDataset: Record<string, number | undefined> = {
    quality: parseThresholdValue(
        thresholdQualityArg?.split('=')[1] ??
            process.env.EVAL_THRESHOLD_QUALITY,
    ),
    suppression: parseThresholdValue(
        thresholdSuppressionArg?.split('=')[1] ??
            process.env.EVAL_THRESHOLD_SUPPRESSION,
    ),
};

function getThresholdForDataset(label: string) {
    switch (label) {
        case 'quality':
            return (
                thresholdByDataset[label] ??
                thresholdAllOverride ??
                DEFAULT_THRESHOLD_QUALITY
            );
        case 'suppression':
            return (
                thresholdByDataset[label] ??
                thresholdAllOverride ??
                DEFAULT_THRESHOLD_SUPPRESSION
            );
        default:
            return thresholdAllOverride ?? DEFAULT_THRESHOLD_QUALITY;
    }
}
const judgeProvider =
    parseJudgeProvider(judgeProviderArg?.split('=')[1]) ??
    parseJudgeProvider(process.env.EVAL_JUDGE_PROVIDER) ??
    inferByokProvider(judgeModel);
const useJudgeByok = !!judgeProvider || !!judgeModel || !!judgeBaseUrl;

const missingEnv: string[] = [];
if (!process.env.LANGCHAIN_API_KEY && !process.env.LANGSMITH_API_KEY) {
    missingEnv.push('LANGCHAIN_API_KEY (or LANGSMITH_API_KEY)');
}
if (!process.env.API_GOOGLE_AI_API_KEY) {
    missingEnv.push('API_GOOGLE_AI_API_KEY');
}
if (useJudgeByok) {
    if (
        judgeProvider === BYOKProvider.OPENAI ||
        judgeProvider === BYOKProvider.OPENAI_COMPATIBLE ||
        !judgeProvider
    ) {
        if (!process.env.API_OPEN_AI_API_KEY && !judgeApiKey) {
            missingEnv.push('API_OPEN_AI_API_KEY');
        }
    } else if (judgeProvider === BYOKProvider.ANTHROPIC) {
        if (!process.env.API_ANTHROPIC_API_KEY) {
            missingEnv.push('API_ANTHROPIC_API_KEY');
        }
    } else if (judgeProvider === BYOKProvider.GOOGLE_GEMINI) {
        if (!process.env.API_GOOGLE_AI_API_KEY) {
            missingEnv.push('API_GOOGLE_AI_API_KEY');
        }
    } else if (judgeProvider === BYOKProvider.GOOGLE_VERTEX) {
        if (!process.env.API_VERTEX_AI_API_KEY) {
            missingEnv.push('API_VERTEX_AI_API_KEY');
        }
    } else if (judgeProvider === BYOKProvider.NOVITA) {
        if (!process.env.API_NOVITA_AI_API_KEY) {
            missingEnv.push('API_NOVITA_AI_API_KEY');
        }
    }
    if (judgeProvider === BYOKProvider.OPENAI_COMPATIBLE && !judgeBaseUrl) {
        missingEnv.push('JUDGE_BASE_URL (--judge-base-url)');
    }
}

if (missingEnv.length > 0) {
    throw new Error(
        `Missing required environment variables: ${missingEnv.join(', ')}`,
    );
}

const parsedConcurrency = maxConcurrencyArg
    ? Number(maxConcurrencyArg.split('=')[1])
    : NaN;
const maxConcurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency > 0
        ? parsedConcurrency
        : 2;

const experimentPrefix = experimentPrefixArg
    ? experimentPrefixArg.split('=')[1]
    : 'crossfile-eval';

const datasetFilter = datasetArg ? datasetArg.split('=')[1] : undefined;

const selectedDatasets = datasetFilter
    ? DATASETS.filter(
          (dataset) =>
              dataset.id === datasetFilter || dataset.label === datasetFilter,
      )
    : DATASETS;

if (selectedDatasets.length === 0) {
    throw new Error(
        `No datasets matched filter "${datasetFilter}". Use dataset id or label.`,
    );
}

const logger = new Logger('LangSmithCrossFileEval');
const byokProviderService = new BYOKProviderService();
const llmProviderService = new LLMProviderService(logger, byokProviderService);
const promptRunnerService = new PromptRunnerService(logger, llmProviderService);
const client = new Client();
const evaluatorCache = new Map<string, EvaluatorT>();

function normalizeFiles(
    rawInputs: Record<string, unknown>,
): CrossFileAnalysisPayload['files'] {
    const rawFiles =
        (rawInputs.files as unknown[]) ??
        (rawInputs.preparedFiles as unknown[]) ??
        [];

    if (!Array.isArray(rawFiles)) {
        return [];
    }

    return rawFiles.map((entry) => {
        const record = entry as Record<string, unknown>;

        if (
            record?.file &&
            typeof record.file === 'object' &&
            (record.file as Record<string, unknown>).filename &&
            (record.file as Record<string, unknown>).codeDiff
        ) {
            return record as CrossFileAnalysisPayload['files'][number];
        }

        const filename =
            record.filename ??
            record.fileName ??
            record.path ??
            (record.file as Record<string, unknown> | undefined)?.filename ??
            'unknown';

        const codeDiff =
            record.codeDiff ??
            record.patchWithLinesStr ??
            record.patch ??
            record.diff ??
            (record.file as Record<string, unknown> | undefined)?.codeDiff ??
            '';

        return {
            file: {
                filename: String(filename),
                codeDiff: String(codeDiff),
            },
        };
    });
}

function buildPayload(inputs: unknown): CrossFileAnalysisPayload {
    const rawInputs = ((inputs as Record<string, unknown>)?.payload ??
        (inputs as Record<string, unknown>)?.input ??
        (inputs as Record<string, unknown>) ??
        {}) as Record<string, unknown>;

    const files = normalizeFiles(rawInputs);
    const language =
        (rawInputs as Record<string, unknown>).language ?? DEFAULT_LANGUAGE;

    if (!files.length) {
        throw new Error(
            'Eval input missing files. Expected inputs.files or inputs.preparedFiles.',
        );
    }

    const v2PromptOverrides = (rawInputs.v2PromptOverrides ??
        {}) as CrossFileAnalysisPayload['v2PromptOverrides'];

    return {
        files,
        language: String(language),
        v2PromptOverrides,
    } as CrossFileAnalysisPayload;
}

function buildRunner(
    payload: CrossFileAnalysisPayload,
    metadata: Record<string, unknown>,
) {
    return promptRunnerService
        .builder()
        .setProviders({
            main: LLMModelProvider.GEMINI_2_5_PRO,
            fallback: LLMModelProvider.GEMINI_2_5_FLASH,
        })
        .setParser(ParserType.ZOD, CrossFileAnalysisSchema)
        .setLLMJsonMode(true)
        .setPayload(payload)
        .addPrompt({
            prompt: prompt_codereview_cross_file_analysis,
            role: PromptRole.SYSTEM,
        })
        .addPrompt({
            prompt: 'Please analyze the provided information and return the response in the specified format.',
            role: PromptRole.USER,
        })
        .setTemperature(0)
        .setRunName(RUN_NAME)
        .setMaxReasoningTokens(MAX_REASONING_TOKENS)
        .addTags(['crossFileAnalysis', 'eval'])
        .addMetadata(metadata);
}

type FeedbackStats = {
    total: number;
    runIds: Set<string>;
    scoreNumericCount: number;
    scoreNumericSum: number;
    scoreBoolCount: number;
    scoreBoolTrue: number;
    valueNumericCount: number;
    valueNumericSum: number;
    valueBoolCount: number;
    valueBoolTrue: number;
    valueStringCount: number;
};

type FeedbackSummary = {
    key: string;
    coverage: number;
    scoreAvg?: number;
    scoreTrueRate?: number;
    valueAvg?: number;
    valueTrueRate?: number;
    effectiveScore?: number;
    status?: 'PASS' | 'FAIL' | 'SKIP';
    threshold?: number;
};

function initFeedbackStats(): FeedbackStats {
    return {
        total: 0,
        runIds: new Set<string>(),
        scoreNumericCount: 0,
        scoreNumericSum: 0,
        scoreBoolCount: 0,
        scoreBoolTrue: 0,
        valueNumericCount: 0,
        valueNumericSum: 0,
        valueBoolCount: 0,
        valueBoolTrue: 0,
        valueStringCount: 0,
    };
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectFeedbackStats(runIds: string[]) {
    const statsByKey = new Map<string, FeedbackStats>();

    for await (const feedback of client.listFeedback({ runIds })) {
        const key = feedback.key ?? 'unknown';
        const stats = statsByKey.get(key) ?? initFeedbackStats();

        stats.total += 1;
        stats.runIds.add(feedback.run_id);

        if (typeof feedback.score === 'number') {
            stats.scoreNumericCount += 1;
            stats.scoreNumericSum += feedback.score;
        } else if (typeof feedback.score === 'boolean') {
            stats.scoreBoolCount += 1;
            stats.scoreBoolTrue += feedback.score ? 1 : 0;
        }

        if (typeof feedback.value === 'number') {
            stats.valueNumericCount += 1;
            stats.valueNumericSum += feedback.value;
        } else if (typeof feedback.value === 'boolean') {
            stats.valueBoolCount += 1;
            stats.valueBoolTrue += feedback.value ? 1 : 0;
        } else if (typeof feedback.value === 'string') {
            stats.valueStringCount += 1;
        }

        statsByKey.set(key, stats);
    }

    return statsByKey;
}

function computeSummary(
    key: string,
    stats: FeedbackStats,
    totalRuns: number,
): FeedbackSummary {
    const coverage = totalRuns > 0 ? (stats.runIds.size / totalRuns) * 100 : 0;
    const scoreAvg =
        stats.scoreNumericCount > 0
            ? stats.scoreNumericSum / stats.scoreNumericCount
            : undefined;
    const scoreTrueRate =
        stats.scoreBoolCount > 0
            ? stats.scoreBoolTrue / stats.scoreBoolCount
            : undefined;
    const valueAvg =
        stats.valueNumericCount > 0
            ? stats.valueNumericSum / stats.valueNumericCount
            : undefined;
    const valueTrueRate =
        stats.valueBoolCount > 0
            ? stats.valueBoolTrue / stats.valueBoolCount
            : undefined;

    const effectiveScore =
        scoreAvg ?? valueAvg ?? scoreTrueRate ?? valueTrueRate ?? undefined;

    return {
        key,
        coverage,
        scoreAvg,
        scoreTrueRate,
        valueAvg,
        valueTrueRate,
        effectiveScore,
    };
}

async function summarizeFeedback(
    experimentName: string,
    thresholdValue: number,
    gateKeys?: string[],
) {
    const runIds: string[] = [];

    for await (const run of client.listRuns({
        projectName: experimentName,
        isRoot: true,
        select: ['id'],
    })) {
        if (run?.id) {
            runIds.push(run.id);
        }
    }

    if (runIds.length === 0) {
        logger.warn(`No runs found for experiment "${experimentName}".`);
        return;
    }

    let statsByKey = await collectFeedbackStats(runIds);
    let attempts = 0;

    while (statsByKey.size === 0 && attempts < 3) {
        attempts += 1;
        logger.log(
            `No feedback yet for "${experimentName}". Retrying in 3s (attempt ${attempts}/3)...`,
        );
        await delay(3000);
        statsByKey = await collectFeedbackStats(runIds);
    }

    if (statsByKey.size === 0) {
        logger.warn(
            `No feedback found for experiment "${experimentName}". Check if evaluators are attached in LangSmith.`,
        );
        return {
            summaries: [] as FeedbackSummary[],
            failures: [`${experimentName}: no feedback`],
        };
    }

    logger.log(`Feedback summary for "${experimentName}"`);

    const summaries: FeedbackSummary[] = [];
    const failures: string[] = [];
    const gateKeySet = new Set(gateKeys ?? []);

    if (gateKeys?.length) {
        const missingGateKeys = gateKeys.filter((key) => !statsByKey.has(key));
        if (missingGateKeys.length > 0) {
            missingGateKeys.forEach((key) => {
                logger.warn(
                    `Missing evaluator feedback "${key}" for experiment "${experimentName}".`,
                );
                summaries.push({
                    key,
                    coverage: 0,
                    status: 'FAIL',
                    threshold: thresholdValue,
                });
                failures.push(
                    `${experimentName}:${key} missing evaluator feedback`,
                );
            });
        }
    }

    for (const [key, stats] of statsByKey.entries()) {
        const summary = computeSummary(key, stats, runIds.length);
        const parts: string[] = [`coverage=${summary.coverage.toFixed(1)}%`];

        if (summary.scoreAvg !== undefined) {
            parts.push(`score_avg=${summary.scoreAvg.toFixed(3)}`);
        }
        if (summary.scoreTrueRate !== undefined) {
            parts.push(
                `score_true=${(summary.scoreTrueRate * 100).toFixed(1)}%`,
            );
        }
        if (summary.valueAvg !== undefined) {
            parts.push(`value_avg=${summary.valueAvg.toFixed(3)}`);
        }
        if (summary.valueTrueRate !== undefined) {
            parts.push(
                `value_true=${(summary.valueTrueRate * 100).toFixed(1)}%`,
            );
        }
        if (stats.valueStringCount > 0) {
            parts.push(`value_text=${stats.valueStringCount}`);
        }

        const shouldGate =
            !gateKeys || gateKeys.length === 0 || gateKeySet.has(key);

        if (shouldGate) {
            summary.threshold = thresholdValue;
            if (summary.effectiveScore === undefined) {
                summary.status = 'FAIL';
                parts.push(`threshold=${thresholdValue.toFixed(2)} (FAIL)`);
                failures.push(
                    `${experimentName}:${key} missing score for threshold ${thresholdValue.toFixed(2)}`,
                );
            } else {
                summary.status =
                    summary.effectiveScore >= thresholdValue ? 'PASS' : 'FAIL';
                parts.push(
                    `threshold=${thresholdValue.toFixed(2)} (${summary.status})`,
                );
                if (summary.status === 'FAIL') {
                    failures.push(
                        `${experimentName}:${key} score ${summary.effectiveScore.toFixed(3)} < ${thresholdValue.toFixed(2)}`,
                    );
                }
            }
        } else {
            summary.status = 'SKIP';
            parts.push('threshold=skipped');
        }

        logger.log(`- ${key}: ${parts.join(' | ')}`);
        summaries.push(summary);
    }

    return { summaries, failures };
}

function formatKeys(obj?: Record<string, unknown>) {
    if (!obj) return [];
    return Object.keys(obj);
}

function formatNestedKeys(
    obj: Record<string, unknown> | undefined,
    path: string,
) {
    if (!obj) return;
    const value = path
        .split('.')
        .reduce<Record<string, unknown> | undefined>((acc, key) => {
            if (!acc || typeof acc !== 'object') return undefined;
            return acc[key] as Record<string, unknown> | undefined;
        }, obj);

    if (!value || typeof value !== 'object') return;
    logger.log(`- ${path} keys: ${Object.keys(value).join(', ')}`);
}

function previewObject(obj?: Record<string, unknown>, maxLen = 300) {
    if (!obj) return '';
    try {
        const str = JSON.stringify(obj);
        if (str.length <= maxLen) return str;
        return `${str.slice(0, maxLen)}...`;
    } catch {
        return '[unserializable]';
    }
}

function renderMustache(
    template: string,
    vars: Record<string, string>,
): string {
    return template.replace(/{{\s*(\w+)\s*}}/g, (_, key: string) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '',
    );
}

async function getEvaluator(promptName: string): Promise<EvaluatorT> {
    const cached = evaluatorCache.get(promptName);
    if (cached) return cached;

    const commit = await client.pullPromptCommit(promptName);
    const manifest = commit.manifest ?? {};
    const schema = manifest?.kwargs?.schema_ as
        | Record<string, unknown>
        | undefined;
    const messages = (manifest?.kwargs?.messages as any[]) ?? [];

    const systemTemplate = messages.find(
        (msg) => msg?.id?.[3] === 'SystemMessagePromptTemplate',
    )?.kwargs?.prompt?.kwargs?.template as string | undefined;

    const userTemplate = messages.find(
        (msg) => msg?.id?.[3] === 'HumanMessagePromptTemplate',
    )?.kwargs?.prompt?.kwargs?.template as string | undefined;

    if (!systemTemplate || !userTemplate) {
        throw new Error(
            `Evaluator prompt "${promptName}" is missing system or user template.`,
        );
    }

    const key =
        (schema?.title as string | undefined) ?? promptName ?? 'evaluation';

    const evaluator = (async (args: any): Promise<EvaluationResult> => {
        const payload = args as {
            inputs?: Record<string, unknown>;
            outputs?: Record<string, unknown>;
            referenceOutputs?: Record<string, unknown>;
            run?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
            example?: { outputs?: Record<string, unknown> };
        };

        const inputs =
            payload.inputs ?? payload.run?.inputs ?? {};
        const outputs =
            payload.outputs ?? payload.run?.outputs ?? {};
        const referenceOutputs =
            payload.referenceOutputs ?? payload.example?.outputs ?? {};

        const vars = {
            input: JSON.stringify(inputs ?? {}),
            output: JSON.stringify(outputs ?? {}),
            reference: JSON.stringify(referenceOutputs ?? {}),
        };

        const systemPrompt = renderMustache(systemTemplate, vars);
        const userPrompt = renderMustache(userTemplate, vars);

        let builder = promptRunnerService.builder();

        if (useJudgeByok) {
            const provider = judgeProvider ?? BYOKProvider.OPENAI;
            const apiKey =
                judgeApiKey ??
                (provider === BYOKProvider.ANTHROPIC
                    ? process.env.API_ANTHROPIC_API_KEY
                    : provider === BYOKProvider.GOOGLE_GEMINI
                      ? process.env.API_GOOGLE_AI_API_KEY
                      : provider === BYOKProvider.GOOGLE_VERTEX
                        ? process.env.API_VERTEX_AI_API_KEY
                        : provider === BYOKProvider.NOVITA
                          ? process.env.API_NOVITA_AI_API_KEY
                          : process.env.API_OPEN_AI_API_KEY);

            if (!apiKey) {
                throw new Error(
                    `Missing API key for judge provider ${provider}.`,
                );
            }

            builder = builder.setBYOKConfig({
                provider,
                apiKey,
                model: judgeModel ?? 'gpt-5.1-chat-2025-11-13',
                baseURL:
                    provider === BYOKProvider.OPENAI_COMPATIBLE
                        ? judgeBaseUrl
                        : undefined,
            });
        }

        const result = await builder
            .setProviders({
                main: useJudgeByok
                    ? LLMModelProvider.OPENAI_GPT_4O
                    : LLMModelProvider.GEMINI_2_5_PRO,
                fallback: useJudgeByok
                    ? undefined
                    : LLMModelProvider.GEMINI_2_5_FLASH,
            })
            .setParser(ParserType.JSON)
            .setLLMJsonMode(true)
            .addPrompt({ prompt: systemPrompt, role: PromptRole.SYSTEM })
            .addPrompt({ prompt: userPrompt, role: PromptRole.USER })
            .setTemperature(0)
            .setRunName(`${promptName}-judge`)
            .execute();

        if (!result || typeof result !== 'object') {
            throw new Error(
                `Evaluator "${promptName}" returned invalid JSON output.`,
            );
        }

        const record = result as Record<string, unknown>;
        const score =
            typeof record.correctness_score === 'number'
                ? record.correctness_score
                : typeof record.score === 'number'
                  ? record.score
                  : typeof record.passed === 'boolean'
                    ? record.passed
                    : null;
        const value =
            (record.value ??
                record.correctness_score ??
                record.score ??
                record.passed ??
                record.result ??
                record) as EvaluationResult['value'];
        const comment =
            (record.reasoning as string | undefined) ??
            (record.failure_reason as string | undefined) ??
            (record.reason as string | undefined) ??
            (record.summary as string | undefined) ??
            (record.comment as string | undefined) ??
            null;

        const evaluationResult: EvaluationResult = {
            key,
            score,
            value,
            comment: comment ?? undefined,
        };

        return evaluationResult;
    }) as EvaluatorT;

    evaluatorCache.set(promptName, evaluator);
    return evaluator;
}

async function inspectDataset(dataset: (typeof DATASETS)[number]) {
    let firstExample: any | null = null;

    for await (const example of client.listExamples({
        datasetId: dataset.id,
        limit: 1,
        asOf: 'latest',
    })) {
        firstExample = example;
        break;
    }

    if (!firstExample) {
        logger.warn(`No examples found for dataset ${dataset.label}.`);
        return;
    }

    logger.log(`Inspecting dataset ${dataset.label} (${dataset.id})`);
    logger.log(`- exampleId: ${firstExample.id}`);
    logger.log(`- input keys: ${formatKeys(firstExample.inputs).join(', ')}`);
    logger.log(`- output keys: ${formatKeys(firstExample.outputs).join(', ')}`);
    logger.log(
        `- metadata keys: ${formatKeys(firstExample.metadata).join(', ')}`,
    );
    logger.log(`- inputs preview: ${previewObject(firstExample.inputs)}`);
    logger.log(`- outputs preview: ${previewObject(firstExample.outputs)}`);
    logger.log(`- metadata preview: ${previewObject(firstExample.metadata)}`);

    const inputs = firstExample.inputs as Record<string, unknown> | undefined;
    const outputs = firstExample.outputs as Record<string, unknown> | undefined;

    formatNestedKeys(inputs, 'files.0');
    formatNestedKeys(outputs, 'suggestions.0');

    if (inspectFull) {
        logger.log(
            `- inputs full: ${JSON.stringify(firstExample.inputs, null, 2)}`,
        );
        logger.log(
            `- outputs full: ${JSON.stringify(firstExample.outputs, null, 2)}`,
        );
        logger.log(
            `- metadata full: ${JSON.stringify(firstExample.metadata, null, 2)}`,
        );
    }
}

async function inspectEvaluatorPrompt(promptName: string) {
    const commit = await client.pullPromptCommit(promptName);

    logger.log(`Inspecting evaluator prompt "${promptName}"`);
    logger.log(`- owner: ${commit.owner}`);
    logger.log(`- repo: ${commit.repo}`);
    logger.log(`- commit: ${commit.commit_hash}`);
    logger.log(
        `- manifest keys: ${Object.keys(commit.manifest ?? {}).join(', ')}`,
    );
    logger.log(`- manifest: ${JSON.stringify(commit.manifest ?? {}, null, 2)}`);
    if (commit.examples?.length) {
        logger.log(
            `- prompt examples: ${JSON.stringify(commit.examples, null, 2)}`,
        );
    }
}

type DatasetRunSummary = {
    label: DatasetConfig['label'];
    experimentName: string;
    summaries: FeedbackSummary[];
    failures: string[];
};

async function runDatasetEval(
    dataset: DatasetConfig,
): Promise<DatasetRunSummary> {
    const experimentName = `${experimentPrefix}-${dataset.label}`;
    const evaluator = dataset.evaluatorPrompt
        ? await getEvaluator(dataset.evaluatorPrompt)
        : undefined;
    const datasetThreshold = getThresholdForDataset(dataset.label);

    logger.log(
        `Starting dataset eval: ${dataset.label} (${dataset.id})` +
            (useJudgeByok
                ? ` | judge=${judgeProvider ?? 'openai'}:${judgeModel ?? 'gpt-5.1-chat-2025-11-13'}`
                : ''),
    );

    const target = async (
        inputs: Record<string, unknown>,
    ): Promise<CrossFileAnalysisSchemaType> => {
        const payload = buildPayload(inputs);
        const runner = buildRunner(payload, {
            datasetId: dataset.id,
            datasetLabel: dataset.label,
            provider: LLMModelProvider.GEMINI_2_5_PRO,
        });

        const result = await runner.execute();

        if (!result) {
            throw new Error('LLM returned empty response for eval run.');
        }

        return result;
    };

    const results = await evaluate(target, {
        data: dataset.id,
        experimentPrefix: experimentName,
        maxConcurrency,
        description: `Cross-file eval (${dataset.label}) using ${LLMModelProvider.GEMINI_2_5_PRO}`,
        metadata: {
            datasetId: dataset.id,
            datasetLabel: dataset.label,
            provider: LLMModelProvider.GEMINI_2_5_PRO,
            judgeProvider: useJudgeByok
                ? (judgeProvider ?? 'openai')
                : 'gemini',
            judgeModel: useJudgeByok
                ? (judgeModel ?? 'gpt-5.1-chat-2025-11-13')
                : 'gemini-2.5-pro',
        },
        evaluators: evaluator ? [evaluator] : undefined,
        client,
    });

    logger.log(`Completed dataset eval: ${dataset.label}`);
    const summary = await summarizeFeedback(
        results.experimentName,
        datasetThreshold,
        dataset.gateKeys,
    );

    return {
        label: dataset.label,
        experimentName: results.experimentName,
        summaries: summary?.summaries ?? [],
        failures: summary?.failures ?? [],
    };
}

async function main() {
    if (inspectOnly) {
        if (inspectEvaluatorArg) {
            const promptName = inspectEvaluatorArg.split('=')[1];
            if (!promptName) {
                throw new Error('Missing prompt name in --inspect-evaluator');
            }
            await inspectEvaluatorPrompt(promptName);
            return;
        }

        for (const dataset of selectedDatasets) {
            await inspectDataset(dataset);
        }
        return;
    }

    const failures: string[] = [];
    const datasetSummaries: DatasetRunSummary[] = [];

    for (const dataset of selectedDatasets) {
        const summary = await runDatasetEval(dataset);
        if (summary?.failures?.length) {
            failures.push(...summary.failures);
        }
        datasetSummaries.push(summary);
    }

    const project =
        process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT;
    const prefixes = selectedDatasets
        .map((dataset) => `${experimentPrefix}-${dataset.label}`)
        .join(', ');

    if (project) {
        logger.log(
            `Done. Check LangSmith project "${project}" for experiments with prefix "${prefixes}".`,
        );
    } else {
        logger.log(
            `Done. Check LangSmith for experiments with prefix "${prefixes}".`,
        );
    }

    if (datasetSummaries.length > 0) {
        logger.log('Final eval summary');
        for (const datasetSummary of datasetSummaries) {
            const datasetConfig = selectedDatasets.find(
                (dataset) => dataset.label === datasetSummary.label,
            );
            const gateKeys = new Set(datasetConfig?.gateKeys ?? []);
            const sorted = [...datasetSummary.summaries].sort((a, b) => {
                const aGate = gateKeys.has(a.key) ? 0 : 1;
                const bGate = gateKeys.has(b.key) ? 0 : 1;
                if (aGate !== bGate) return aGate - bGate;
                return a.key.localeCompare(b.key);
            });

            for (const summary of sorted) {
                const score =
                    summary.effectiveScore !== undefined
                        ? summary.effectiveScore.toFixed(3)
                        : 'n/a';
                const thresholdText =
                    summary.threshold !== undefined
                        ? summary.threshold.toFixed(2)
                        : 'n/a';
                const status = summary.status ?? 'SKIP';
                logger.log(
                    `- ${datasetSummary.label}/${summary.key}: ${status} (score=${score}, threshold=${thresholdText}, coverage=${summary.coverage.toFixed(1)}%)`,
                );
            }
        }
        const overallStatus = failures.length > 0 ? 'FAIL' : 'PASS';
        logger.log(`Final status: ${overallStatus}`);
    }

    if (failures.length > 0) {
        logger.error(
            `Threshold check failed (quality=${DEFAULT_THRESHOLD_QUALITY.toFixed(2)}, suppression=${DEFAULT_THRESHOLD_SUPPRESSION.toFixed(2)}):`,
        );
        failures.forEach((failure) => logger.error(`- ${failure}`));
        process.exitCode = 1;
    }
}

main().catch((error) => {
    logger.error('Cross-file eval failed', error as Error);
    process.exitCode = 1;
});
