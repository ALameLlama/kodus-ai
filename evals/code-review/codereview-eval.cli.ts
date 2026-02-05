#!/usr/bin/env npx ts-node

/**
 * LangSmith eval runner for the file-level code review prompt.
 *
 * Usage:
 *   yarn eval:codereview --language=typescript
 *   yarn eval:codereview --language=typescript --model=gemini-2.5-pro
 *   yarn eval:codereview --language=typescript --model=claude-sonnet
 *   yarn eval:codereview --language=typescript --models=gemini-2.5-pro,claude-sonnet
 *   yarn eval:codereview --inspect --language=typescript
 *
 * Available models:
 *   - gemini-2.5-pro (default)
 *   - gemini-2.5-flash
 *   - gemini-3-pro
 *   - gemini-3-flash
 *   - claude-sonnet
 *   - gpt-4o
 *   - gpt-4o-mini
 *   - gpt-4.1
 *   - deepseek-v3
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
import { z } from 'zod';

import {
    prompt_codereview_system_gemini_v2,
    prompt_codereview_user_gemini_v2,
    CodeReviewPayload,
} from '../../libs/common/utils/langchainCommon/prompts/configuration/codeReview';

// ============================================================================
// Types & Configuration
// ============================================================================

type LanguageConfig = {
    id: string;
    label: string;
    evaluatorPrompt?: string;
    gateKeys: string[];
};

// Dataset configuration per language
// TODO: Add more languages as datasets are created
const LANGUAGE_DATASETS: Record<string, LanguageConfig> = {
    typescript: {
        id: 'eb7a4983-a789-4cf7-8901-bc039c3a9372',
        label: 'typescript',
        evaluatorPrompt: 'eval_bugs_javascript_typescript_eval_codereview_standard_suggestions_3ebd1b32',
        gateKeys: ['true_positives', 'recall', 'precision', 'f1'],
    },
    // python: {
    //     id: 'PYTHON_DATASET_ID',
    //     label: 'python',
    //     evaluatorPrompt: 'eval_codereview_python_evaluator_xxxxx',
    //     gateKeys: ['pr_review_evaluation'],
    // },
    // go: {
    //     id: 'GO_DATASET_ID',
    //     label: 'go',
    //     evaluatorPrompt: 'eval_codereview_go_evaluator_xxxxx',
    //     gateKeys: ['pr_review_evaluation'],
    // },
};

const CodeReviewSuggestionSchema = z.object({
    codeSuggestions: z.array(
        z.object({
            relevantFile: z.string(),
            language: z.string(),
            suggestionContent: z.string(),
            existingCode: z.string().optional(),
            improvedCode: z.string(),
            oneSentenceSummary: z.string().optional(),
            relevantLinesStart: z.number().min(1).optional(),
            relevantLinesEnd: z.number().min(1).optional(),
            label: z.string(),
            severity: z.string().optional(),
            rankScore: z.number().optional(),
            llmPrompt: z.string().optional(),
        }),
    ),
});

type CodeReviewSuggestionSchemaType = z.infer<typeof CodeReviewSuggestionSchema>;

const DEFAULT_LANGUAGE = 'en-US';
const RUN_NAME = 'codeReviewAnalyzeWithAI';
const MAX_REASONING_TOKENS = 5000;

// Model configuration - maps friendly names to LLMModelProvider
type ModelConfig = {
    provider: LLMModelProvider;
    fallback?: LLMModelProvider;
    label: string;
};

const MODEL_CONFIGS: Record<string, ModelConfig> = {
    'gemini-2.5-pro': {
        provider: LLMModelProvider.GEMINI_2_5_PRO,
        fallback: LLMModelProvider.GEMINI_2_5_FLASH,
        label: 'gemini-2.5-pro',
    },
    'gemini-2.5-flash': {
        provider: LLMModelProvider.GEMINI_2_5_FLASH,
        fallback: undefined,
        label: 'gemini-2.5-flash',
    },
    'gemini-3-pro': {
        provider: LLMModelProvider.GEMINI_3_PRO_PREVIEW,
        fallback: LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
        label: 'gemini-3-pro',
    },
    'gemini-3-flash': {
        provider: LLMModelProvider.GEMINI_3_FLASH_PREVIEW,
        fallback: undefined,
        label: 'gemini-3-flash',
    },
    'claude-sonnet': {
        provider: LLMModelProvider.CLAUDE_3_5_SONNET,
        fallback: undefined,
        label: 'claude-sonnet',
    },
    'gpt-4o': {
        provider: LLMModelProvider.OPENAI_GPT_4O,
        fallback: LLMModelProvider.OPENAI_GPT_4O_MINI,
        label: 'gpt-4o',
    },
    'gpt-4o-mini': {
        provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
        fallback: undefined,
        label: 'gpt-4o-mini',
    },
    'gpt-4.1': {
        provider: LLMModelProvider.OPENAI_GPT_4_1,
        fallback: LLMModelProvider.OPENAI_GPT_4O,
        label: 'gpt-4.1',
    },
    'deepseek-v3': {
        provider: LLMModelProvider.NOVITA_DEEPSEEK_V3,
        fallback: LLMModelProvider.NOVITA_DEEPSEEK_V3_0324,
        label: 'deepseek-v3',
    },
};

const DEFAULT_MODEL = 'gemini-2.5-pro';

// ============================================================================
// CLI Arguments
// ============================================================================

const args = process.argv.slice(2);
const envArg = args.find((a) => a.startsWith('--env='));
const maxConcurrencyArg = args.find((a) => a.startsWith('--max-concurrency='));
const experimentPrefixArg = args.find((a) => a.startsWith('--experiment-prefix='));
const languageArg = args.find((a) => a.startsWith('--language='));
const modelArg = args.find((a) => a.startsWith('--model='));
const modelsArg = args.find((a) => a.startsWith('--models='));
const inspectFull = args.includes('--inspect-full');
const inspectEvaluatorArg = args.find((a) => a.startsWith('--inspect-evaluator='));
const inspectOnly = args.includes('--inspect') || inspectFull || !!inspectEvaluatorArg;
const judgeProviderArg = args.find((a) => a.startsWith('--judge-provider='));
const judgeModelArg = args.find((a) => a.startsWith('--judge-model='));
const judgeBaseUrlArg = args.find((a) => a.startsWith('--judge-base-url='));
const thresholdArg = args.find((a) => a.startsWith('--threshold='));

const envPath = envArg ? envArg.split('=')[1] : process.env.DOTENV_CONFIG_PATH;

if (envPath) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

// ============================================================================
// Helper Functions
// ============================================================================

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

// ============================================================================
// Configuration
// ============================================================================

const judgeModel =
    (judgeModelArg ? judgeModelArg.split('=')[1] : undefined) ||
    process.env.EVAL_JUDGE_MODEL;
const judgeBaseUrl =
    (judgeBaseUrlArg ? judgeBaseUrlArg.split('=')[1] : undefined) ||
    process.env.EVAL_JUDGE_BASE_URL;
const judgeApiKey = process.env.EVAL_JUDGE_API_KEY;

const DEFAULT_THRESHOLD = 0.7;

const parsedThreshold = thresholdArg
    ? Number(thresholdArg.split('=')[1])
    : process.env.EVAL_THRESHOLD
      ? Number(process.env.EVAL_THRESHOLD)
      : undefined;

const thresholdValue =
    parsedThreshold !== undefined &&
    Number.isFinite(parsedThreshold) &&
    parsedThreshold >= 0
        ? parsedThreshold
        : DEFAULT_THRESHOLD;

const judgeProvider =
    parseJudgeProvider(judgeProviderArg?.split('=')[1]) ??
    parseJudgeProvider(process.env.EVAL_JUDGE_PROVIDER) ??
    inferByokProvider(judgeModel);
const useJudgeByok = !!judgeProvider || !!judgeModel || !!judgeBaseUrl;

// Validate environment variables
const missingEnv: string[] = [];
if (!process.env.LANGCHAIN_API_KEY && !process.env.LANGSMITH_API_KEY) {
    missingEnv.push('LANGCHAIN_API_KEY (or LANGSMITH_API_KEY)');
}
if (!process.env.API_GOOGLE_AI_API_KEY) {
    missingEnv.push('API_GOOGLE_AI_API_KEY');
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
    : 'codereview-eval';

// Parse language filter
const languageFilter = languageArg ? languageArg.split('=')[1] : undefined;
const selectedLanguages = languageFilter === 'all' || !languageFilter
    ? Object.keys(LANGUAGE_DATASETS)
    : [languageFilter];

// Validate selected languages
const invalidLanguages = selectedLanguages.filter((lang) => !LANGUAGE_DATASETS[lang]);
if (invalidLanguages.length > 0) {
    throw new Error(
        `Unknown language(s): ${invalidLanguages.join(', ')}. Available: ${Object.keys(LANGUAGE_DATASETS).join(', ')}`,
    );
}

// Parse model selection
function parseModels(): string[] {
    // --models takes precedence (comma-separated list)
    if (modelsArg) {
        return modelsArg.split('=')[1].split(',').map(m => m.trim());
    }
    // --model for single model
    if (modelArg) {
        return [modelArg.split('=')[1].trim()];
    }
    // Default model
    return [DEFAULT_MODEL];
}

const selectedModels = parseModels();

// Validate selected models
const invalidModels = selectedModels.filter((model) => !MODEL_CONFIGS[model]);
if (invalidModels.length > 0) {
    throw new Error(
        `Unknown model(s): ${invalidModels.join(', ')}. Available: ${Object.keys(MODEL_CONFIGS).join(', ')}`,
    );
}

// ============================================================================
// Services
// ============================================================================

const logger = new Logger('LangSmithCodeReviewEval');
const byokProviderService = new BYOKProviderService();
const llmProviderService = new LLMProviderService(logger, byokProviderService);
const promptRunnerService = new PromptRunnerService(logger, llmProviderService);
const client = new Client();
const evaluatorCache = new Map<string, EvaluatorT>();

// ============================================================================
// Payload Building
// ============================================================================

interface DatasetInput {
    id?: string;
}

interface DatasetOutput {
    inputs?: {
        filePath?: string;
        language?: string;
        fileContent?: string;
        pullRequest?: Record<string, unknown>;
        patchWithLinesStr?: string;
        reviewOptions?: Record<string, boolean>;
        severityLevelFilter?: string;
        languageResultPrompt?: string;
        maxSuggestionsParams?: number;
        organizationAndTeamData?: Record<string, unknown>;
        limitationType?: string;
        groupingMode?: string;
        v2PromptOverrides?: Record<string, unknown>;
    };
}

function normalizeKey(key: string): string {
    // Convert PascalCase/camelCase to camelCase for consistent access
    return key.charAt(0).toLowerCase() + key.slice(1);
}

function getField(obj: Record<string, unknown>, ...keys: string[]): unknown {
    // Try each key variation (original, camelCase, PascalCase)
    for (const key of keys) {
        if (obj[key] !== undefined) return obj[key];
        const camel = normalizeKey(key);
        if (obj[camel] !== undefined) return obj[camel];
        const pascal = key.charAt(0).toUpperCase() + key.slice(1);
        if (obj[pascal] !== undefined) return obj[pascal];
    }
    return undefined;
}

function buildPayload(inputs: Record<string, unknown>): CodeReviewPayload {
    // Handle nested structure: inputs.inputs.* or inputs.* directly
    // The CSV import creates: { id: "...", inputs: { FileContent: "...", ... } }
    const nestedInputs = inputs.inputs as Record<string, unknown> | undefined;
    const actualInputs = nestedInputs || inputs;

    const fileContent = getField(actualInputs, 'fileContent', 'FileContent') as string | undefined;
    const patchWithLinesStr = getField(actualInputs, 'patchWithLinesStr', 'PatchWithLinesStr') as string | undefined;
    const languageResultPrompt = (getField(actualInputs, 'languageResultPrompt', 'LanguageResultPrompt') as string) || DEFAULT_LANGUAGE;
    const maxSuggestionsParams = getField(actualInputs, 'maxSuggestionsParams', 'MaxSuggestionsParams') as number | undefined;
    const limitationType = getField(actualInputs, 'limitationType', 'LimitationType') as string | undefined;
    const v2PromptOverrides = getField(actualInputs, 'v2PromptOverrides', 'V2PromptOverrides') as Record<string, unknown> | undefined;
    const pullRequest = getField(actualInputs, 'pullRequest', 'PullRequest') as Record<string, unknown> | undefined;

    if (!patchWithLinesStr) {
        throw new Error(
            `Eval input missing patchWithLinesStr. Available keys: ${Object.keys(actualInputs).join(', ')}`,
        );
    }

    return {
        fileContent,
        patchWithLinesStr,
        relevantContent: fileContent,
        languageResultPrompt,
        maxSuggestionsParams,
        limitationType: limitationType as any,
        v2PromptOverrides: v2PromptOverrides as any,
        prSummary: pullRequest?.body as string | undefined,
    };
}

function buildRunner(
    payload: CodeReviewPayload,
    metadata: Record<string, unknown>,
    modelConfig: ModelConfig,
) {
    return promptRunnerService
        .builder()
        .setProviders({
            main: modelConfig.provider,
            fallback: modelConfig.fallback,
        })
        .setParser(ParserType.ZOD, CodeReviewSuggestionSchema, {
            provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
            fallbackProvider: LLMModelProvider.OPENAI_GPT_4O,
        })
        .setLLMJsonMode(true)
        .setPayload(payload)
        .addPrompt({
            prompt: prompt_codereview_system_gemini_v2,
            role: PromptRole.SYSTEM,
        })
        .addPrompt({
            prompt: prompt_codereview_user_gemini_v2,
            role: PromptRole.USER,
        })
        .setTemperature(0)
        .setRunName(RUN_NAME)
        .setMaxReasoningTokens(MAX_REASONING_TOKENS)
        .addTags(['codeReview', 'eval', 'file-level', modelConfig.label])
        .addMetadata({ ...metadata, model: modelConfig.label });
}

// ============================================================================
// Feedback Collection & Summary
// ============================================================================

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
    threshold: number,
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

    for (const [key, stats] of statsByKey.entries()) {
        const summary = computeSummary(key, stats, runIds.length);
        const parts: string[] = [`coverage=${summary.coverage.toFixed(1)}%`];

        if (summary.scoreAvg !== undefined) {
            parts.push(`score_avg=${summary.scoreAvg.toFixed(3)}`);
        }
        if (summary.scoreTrueRate !== undefined) {
            parts.push(`score_true=${(summary.scoreTrueRate * 100).toFixed(1)}%`);
        }
        if (summary.valueAvg !== undefined) {
            parts.push(`value_avg=${summary.valueAvg.toFixed(3)}`);
        }
        if (summary.valueTrueRate !== undefined) {
            parts.push(`value_true=${(summary.valueTrueRate * 100).toFixed(1)}%`);
        }
        if (stats.valueStringCount > 0) {
            parts.push(`value_text=${stats.valueStringCount}`);
        }

        const shouldGate =
            !gateKeys || gateKeys.length === 0 || gateKeySet.has(key);

        if (shouldGate) {
            summary.threshold = threshold;
            if (summary.effectiveScore === undefined) {
                summary.status = 'FAIL';
                parts.push(`threshold=${threshold.toFixed(2)} (FAIL)`);
                failures.push(
                    `${experimentName}:${key} missing score for threshold ${threshold.toFixed(2)}`,
                );
            } else {
                summary.status =
                    summary.effectiveScore >= threshold ? 'PASS' : 'FAIL';
                parts.push(
                    `threshold=${threshold.toFixed(2)} (${summary.status})`,
                );
                if (summary.status === 'FAIL') {
                    failures.push(
                        `${experimentName}:${key} score ${summary.effectiveScore.toFixed(3)} < ${threshold.toFixed(2)}`,
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

// ============================================================================
// Evaluator
// ============================================================================

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
    const schema = manifest?.kwargs?.schema_ as Record<string, unknown> | undefined;
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

    const key = (schema?.title as string | undefined) ?? promptName ?? 'evaluation';

    const evaluator = (async (args: any): Promise<EvaluationResult> => {
        const payload = args as {
            inputs?: Record<string, unknown>;
            outputs?: Record<string, unknown>;
            referenceOutputs?: Record<string, unknown>;
            run?: { inputs?: Record<string, unknown>; outputs?: Record<string, unknown> };
            example?: { outputs?: Record<string, unknown> };
        };

        const inputs = payload.inputs ?? payload.run?.inputs ?? {};
        const outputs = payload.outputs ?? payload.run?.outputs ?? {};
        const referenceOutputs = payload.referenceOutputs ?? payload.example?.outputs ?? {};

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
                throw new Error(`Missing API key for judge provider ${provider}.`);
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
                fallback: useJudgeByok ? undefined : LLMModelProvider.GEMINI_2_5_FLASH,
            })
            .setParser(ParserType.JSON)
            .setLLMJsonMode(true)
            .addPrompt({ prompt: systemPrompt, role: PromptRole.SYSTEM })
            .addPrompt({ prompt: userPrompt, role: PromptRole.USER })
            .setTemperature(0)
            .setRunName(`${promptName}-judge`)
            .execute();

        if (!result || typeof result !== 'object') {
            throw new Error(`Evaluator "${promptName}" returned invalid JSON output.`);
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

// ============================================================================
// Dataset Inspection
// ============================================================================

function formatKeys(obj?: Record<string, unknown>) {
    if (!obj) return [];
    return Object.keys(obj);
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

async function inspectDataset(config: LanguageConfig) {
    let firstExample: any | null = null;

    for await (const example of client.listExamples({
        datasetId: config.id,
        limit: 1,
        asOf: 'latest',
    })) {
        firstExample = example;
        break;
    }

    if (!firstExample) {
        logger.warn(`No examples found for dataset ${config.label}.`);
        return;
    }

    logger.log(`Inspecting dataset ${config.label} (${config.id})`);
    logger.log(`- exampleId: ${firstExample.id}`);
    logger.log(`- input keys: ${formatKeys(firstExample.inputs).join(', ')}`);

    // Check for nested inputs structure (CSV import creates inputs.inputs.*)
    const nestedInputs = firstExample.inputs?.inputs;
    if (nestedInputs && typeof nestedInputs === 'object') {
        logger.log(`- inputs.inputs keys: ${formatKeys(nestedInputs).join(', ')}`);
    }

    logger.log(`- output keys: ${formatKeys(firstExample.outputs).join(', ')}`);
    logger.log(`- metadata keys: ${formatKeys(firstExample.metadata).join(', ')}`);
    logger.log(`- inputs preview: ${previewObject(firstExample.inputs, 500)}`);

    // Try to build payload to verify structure works
    try {
        const payload = buildPayload(firstExample.inputs);
        logger.log(`- payload build: ✅ SUCCESS`);
        logger.log(`  - fileContent: ${payload.fileContent ? `${payload.fileContent.length} chars` : 'missing'}`);
        logger.log(`  - patchWithLinesStr: ${payload.patchWithLinesStr ? `${payload.patchWithLinesStr.length} chars` : 'missing'}`);
        logger.log(`  - languageResultPrompt: ${payload.languageResultPrompt}`);
    } catch (e) {
        logger.log(`- payload build: ❌ FAILED - ${(e as Error).message}`);
    }

    if (inspectFull) {
        logger.log(`- inputs full: ${JSON.stringify(firstExample.inputs, null, 2)}`);
        logger.log(`- outputs full: ${JSON.stringify(firstExample.outputs, null, 2)}`);
    }
}

async function inspectEvaluatorPrompt(promptName: string) {
    const commit = await client.pullPromptCommit(promptName);

    logger.log(`Inspecting evaluator prompt "${promptName}"`);
    logger.log(`- owner: ${commit.owner}`);
    logger.log(`- repo: ${commit.repo}`);
    logger.log(`- commit: ${commit.commit_hash}`);
    logger.log(`- manifest keys: ${Object.keys(commit.manifest ?? {}).join(', ')}`);
    logger.log(`- manifest: ${JSON.stringify(commit.manifest ?? {}, null, 2)}`);
}

// ============================================================================
// Main Eval Runner
// ============================================================================

type DatasetRunSummary = {
    language: string;
    model: string;
    experimentName: string;
    summaries: FeedbackSummary[];
    failures: string[];
};

async function runLanguageEval(
    config: LanguageConfig,
    modelConfig: ModelConfig,
): Promise<DatasetRunSummary> {
    const experimentName = `${experimentPrefix}-${config.label}-${modelConfig.label}`;
    const evaluator = config.evaluatorPrompt
        ? await getEvaluator(config.evaluatorPrompt)
        : undefined;

    logger.log(
        `Starting eval for language: ${config.label} | model: ${modelConfig.label}` +
            (useJudgeByok
                ? ` | judge=${judgeProvider ?? 'openai'}:${judgeModel ?? 'gpt-5.1-chat-2025-11-13'}`
                : ''),
    );

    const target = async (
        inputs: Record<string, unknown>,
    ): Promise<CodeReviewSuggestionSchemaType> => {
        const payload = buildPayload(inputs);
        const runner = buildRunner(
            payload,
            {
                datasetId: config.id,
                language: config.label,
                provider: modelConfig.provider,
            },
            modelConfig,
        );

        const result = await runner.execute();

        if (!result) {
            throw new Error('LLM returned empty response for eval run.');
        }

        return result;
    };

    const results = await evaluate(target, {
        data: config.id,
        experimentPrefix: experimentName,
        maxConcurrency,
        description: `Code review eval (${config.label}) using ${modelConfig.label}`,
        metadata: {
            datasetId: config.id,
            language: config.label,
            model: modelConfig.label,
            provider: modelConfig.provider,
            judgeProvider: useJudgeByok ? (judgeProvider ?? 'openai') : 'gemini',
            judgeModel: useJudgeByok
                ? (judgeModel ?? 'gpt-5.1-chat-2025-11-13')
                : 'gemini-2.5-pro',
        },
        evaluators: evaluator ? [evaluator] : undefined,
        client,
    });

    logger.log(`Completed eval for language: ${config.label} | model: ${modelConfig.label}`);
    const summary = await summarizeFeedback(
        results.experimentName,
        thresholdValue,
        config.gateKeys,
    );

    return {
        language: config.label,
        model: modelConfig.label,
        experimentName: results.experimentName,
        summaries: summary?.summaries ?? [],
        failures: summary?.failures ?? [],
    };
}

async function main() {
    // Log selected models
    logger.log(`Selected models: ${selectedModels.join(', ')}`);

    if (inspectOnly) {
        if (inspectEvaluatorArg) {
            const promptName = inspectEvaluatorArg.split('=')[1];
            if (!promptName) {
                throw new Error('Missing prompt name in --inspect-evaluator');
            }
            await inspectEvaluatorPrompt(promptName);
            return;
        }

        for (const lang of selectedLanguages) {
            const config = LANGUAGE_DATASETS[lang];
            await inspectDataset(config);
        }
        return;
    }

    const failures: string[] = [];
    const summaries: DatasetRunSummary[] = [];

    // Run eval for each language x model combination
    for (const lang of selectedLanguages) {
        const langConfig = LANGUAGE_DATASETS[lang];
        for (const modelName of selectedModels) {
            const modelConfig = MODEL_CONFIGS[modelName];
            const summary = await runLanguageEval(langConfig, modelConfig);
            if (summary?.failures?.length) {
                failures.push(...summary.failures);
            }
            summaries.push(summary);
        }
    }

    const project =
        process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT;
    const prefixes = selectedLanguages
        .flatMap((lang) => selectedModels.map((model) => `${experimentPrefix}-${lang}-${model}`))
        .join(', ');

    if (project) {
        logger.log(
            `Done. Check LangSmith project "${project}" for experiments with prefix "${prefixes}".`,
        );
    } else {
        logger.log(`Done. Check LangSmith for experiments with prefix "${prefixes}".`);
    }

    if (summaries.length > 0) {
        logger.log('Final eval summary');
        for (const summary of summaries) {
            const config = LANGUAGE_DATASETS[summary.language];
            const gateKeys = new Set(config?.gateKeys ?? []);
            const sorted = [...summary.summaries].sort((a, b) => {
                const aGate = gateKeys.has(a.key) ? 0 : 1;
                const bGate = gateKeys.has(b.key) ? 0 : 1;
                if (aGate !== bGate) return aGate - bGate;
                return a.key.localeCompare(b.key);
            });

            for (const s of sorted) {
                const score =
                    s.effectiveScore !== undefined
                        ? s.effectiveScore.toFixed(3)
                        : 'n/a';
                const thresholdText =
                    s.threshold !== undefined ? s.threshold.toFixed(2) : 'n/a';
                const status = s.status ?? 'SKIP';
                logger.log(
                    `- ${summary.language}/${summary.model}/${s.key}: ${status} (score=${score}, threshold=${thresholdText}, coverage=${s.coverage.toFixed(1)}%)`,
                );
            }
        }
        const overallStatus = failures.length > 0 ? 'FAIL' : 'PASS';
        logger.log(`Final status: ${overallStatus}`);
    }

    if (failures.length > 0) {
        logger.error(`Threshold check failed (threshold=${thresholdValue.toFixed(2)}):`);
        failures.forEach((failure) => logger.error(`- ${failure}`));
        process.exitCode = 1;
    }
}

main().catch((error) => {
    logger.error('Code review eval failed', error as Error);
    process.exitCode = 1;
});
