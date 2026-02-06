#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'output.json'), 'utf-8'));

// Model stats aggregator
const modelStats = {};

// The actual results array is at data.results.results
const results = data.results.results;

// Parse JUDGE_METRICS from judge-assertion.js reason string
// Format: JUDGE_METRICS sonnet_score=0.83 gpt_score=0.75 sonnet_coverage=1.0 ...
function parseJudgeMetrics(reason) {
    const metrics = {};
    const match = reason.match(/JUDGE_METRICS\s+(.+)/);
    if (!match) return null;

    const pairs = match[1].split(/\s+/);
    for (const pair of pairs) {
        const [key, val] = pair.split('=');
        if (key && val) {
            metrics[key] = val === 'null' ? null : parseFloat(val);
        }
    }
    return metrics;
}

results.forEach(result => {
    const provider = result.provider.id || result.provider;

    if (!modelStats[provider]) {
        modelStats[provider] = {
            tests: 0,
            latencies: [],
            lineAccScores: [],
            avgIoUScores: [],
            exactMatchScores: [],
            within3Scores: [],
            apiErrors: 0,
            parseErrors: 0,
            // Per-judge stats
            judges: {
                sonnet: { coverage: [], validity: [], scores: [] },
                gpt: { coverage: [], validity: [], scores: [] },
            },
            judgeFailsSonnet: 0,
            judgeFailsGpt: 0,
            // Combined (average of both judges)
            combinedScores: [],
        };
    }

    const stats = modelStats[provider];
    stats.tests++;

    // Track API errors (404, timeout, etc.)
    const isApiError = result.error && (
        result.error.includes('API error') ||
        result.error.includes('timeout') ||
        result.error.includes('ECONNREFUSED') ||
        (result.response?.output || '').length === 0
    );
    if (isApiError) {
        stats.apiErrors++;
        return;
    }

    // Track parse errors (production parser couldn't parse model output)
    const components = result.gradingResult?.componentResults || [];
    const parseAssertion = components.find(
        c => (c.reason || '').includes('PARSE_FAIL') || (c.reason || '').includes('Invalid JSON') || (c.reason || '').includes('Missing codeSuggestions')
    );
    if (parseAssertion && !parseAssertion.pass) {
        stats.parseErrors++;
    }

    // Collect latency
    if (result.latencyMs) {
        stats.latencies.push(result.latencyMs);
    }

    // Find judge assertion (has JUDGE_METRICS in reason)
    const judgeAssertion = components.find(
        c => c.reason && c.reason.includes('JUDGE_METRICS')
    );

    if (judgeAssertion) {
        const metrics = parseJudgeMetrics(judgeAssertion.reason);
        if (metrics) {
            const sonnetScore = metrics.sonnet_score;
            const gptScore = metrics.gpt_score;

            // Per-judge tracking
            if (sonnetScore !== null && !isNaN(sonnetScore)) {
                stats.judges.sonnet.scores.push(sonnetScore);
                if (metrics.sonnet_coverage !== null) stats.judges.sonnet.coverage.push(metrics.sonnet_coverage);
                if (metrics.sonnet_validity !== null) stats.judges.sonnet.validity.push(metrics.sonnet_validity);
            } else {
                stats.judgeFailsSonnet++;
            }

            if (gptScore !== null && !isNaN(gptScore)) {
                stats.judges.gpt.scores.push(gptScore);
                if (metrics.gpt_coverage !== null) stats.judges.gpt.coverage.push(metrics.gpt_coverage);
                if (metrics.gpt_validity !== null) stats.judges.gpt.validity.push(metrics.gpt_validity);
            } else {
                stats.judgeFailsGpt++;
            }

            // Combined score (missing judge = 0)
            const s = sonnetScore !== null && !isNaN(sonnetScore) ? sonnetScore : 0;
            const g = gptScore !== null && !isNaN(gptScore) ? gptScore : 0;
            stats.combinedScores.push((s + g) / 2);
        }
    }

    // Find the line accuracy assertion result (has LINE_METRICS in reason)
    const lineAssertions = components.filter(
        c => c.reason && c.reason.includes('LINE_METRICS')
    );

    for (const lineAssertion of lineAssertions) {
        const reason = lineAssertion.reason || '';
        const lineAccMatch = reason.match(/line_acc=([\d.]+)/);
        const avgIoUMatch = reason.match(/avg_iou=([\d.]+)/);
        const exactMatchMatch = reason.match(/exact_match=([\d.]+)/);
        const within3Match = reason.match(/within3=([\d.]+)/);

        if (lineAccMatch) stats.lineAccScores.push(parseFloat(lineAccMatch[1]));
        if (avgIoUMatch) stats.avgIoUScores.push(parseFloat(avgIoUMatch[1]));
        if (exactMatchMatch) stats.exactMatchScores.push(parseFloat(exactMatchMatch[1]));
        if (within3Match) stats.within3Scores.push(parseFloat(within3Match[1]));
    }
});

// Helper to calculate percentile
function percentile(arr, p) {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
}

// Format milliseconds to readable string
function formatTime(ms) {
    if (ms >= 60000) return (ms / 60000).toFixed(1) + 'm';
    if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
    return ms + 'ms';
}

function avg(arr) {
    const valid = arr.filter(v => v != null && !isNaN(v));
    if (valid.length === 0) return null;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function fmtPct(val) {
    if (val == null || isNaN(val)) return 'N/A';
    return (val * 100).toFixed(0) + '%';
}

// Sort by combined average score
const sorted = Object.entries(modelStats).sort((a, b) => {
    const aAvg = avg(a[1].combinedScores) || 0;
    const bAvg = avg(b[1].combinedScores) || 0;
    return bAvg - aAvg;
});

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║       CODE REVIEW EVALUATION RESULTS (Sonnet + GPT)         ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');

sorted.forEach(([model, stats], index) => {
    // Shorten model name
    const shortName = model
        .replace('google:gemini-', 'Gemini ')
        .replace('anthropic:messages:', '')
        .replace('openai:', '')
        .replace('openrouter:moonshotai/', '')
        .replace('openrouter:z-ai/', '')
        .replace('-20250929', '')
        .replace('-preview', '')
        .replace('kimi-k2.5', 'Kimi K2.5')
        .replace('glm-4.7', 'GLM 4.7');

    const totalTests = stats.tests;
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';

    // Combined score
    const combinedAvg = avg(stats.combinedScores);
    const combinedPct = combinedAvg !== null ? (combinedAvg * 100).toFixed(1) : 'N/A';

    // Per-judge averages
    const sonnet = stats.judges.sonnet;
    const gpt = stats.judges.gpt;

    const sonnetCov = avg(sonnet.coverage);
    const gptCov = avg(gpt.coverage);
    const sonnetVal = avg(sonnet.validity);
    const gptVal = avg(gpt.validity);

    // Combined coverage/validity (average of both judges)
    const covValues = [...sonnet.coverage, ...gpt.coverage];
    const valValues = [...sonnet.validity, ...gpt.validity];
    const combinedCov = avg(covValues);
    const combinedVal = avg(valValues);

    // Pass count (based on combined score >= 0.7)
    const passCount = stats.combinedScores.filter(s => s >= 0.7).length;

    // Latency
    const p50 = formatTime(percentile(stats.latencies, 50));
    const p95 = formatTime(percentile(stats.latencies, 95));

    // Errors
    const errorTotal = stats.apiErrors + stats.parseErrors;

    console.log(`${medal} ${shortName}`);
    console.log(`   ├─ Score:     ${combinedPct}% (avg of 2 judges)`);
    const judgeFails = stats.judgeFailsSonnet + stats.judgeFailsGpt;
    if (errorTotal > 0 || judgeFails > 0) {
        const parts = [];
        if (stats.apiErrors > 0) parts.push(`${stats.apiErrors} API`);
        if (stats.parseErrors > 0) parts.push(`${stats.parseErrors} parse`);
        if (stats.judgeFailsSonnet > 0) parts.push(`${stats.judgeFailsSonnet} judge-sonnet`);
        if (stats.judgeFailsGpt > 0) parts.push(`${stats.judgeFailsGpt} judge-gpt`);
        console.log(`   ├─ Errors:    ${errorTotal + judgeFails}/${totalTests} (${parts.join(', ')})`);
    }
    console.log(`   ├─ Passou:    ${passCount}/${totalTests} (threshold 0.7)`);
    console.log(`   ├─ Coverage:  ${fmtPct(combinedCov)} (Sonnet: ${fmtPct(sonnetCov)} | GPT: ${fmtPct(gptCov)})`);
    console.log(`   ├─ Validity:  ${fmtPct(combinedVal)} (Sonnet: ${fmtPct(sonnetVal)} | GPT: ${fmtPct(gptVal)})`);

    // Line accuracy metrics
    const avgLineAcc = avg(stats.lineAccScores);
    const avgIoU = avg(stats.avgIoUScores);
    const avgExactMatch = avg(stats.exactMatchScores);
    const avgWithin3 = avg(stats.within3Scores);

    if (avgLineAcc !== null) {
        console.log(`   ├─ Line Acc:  ${(avgLineAcc * 100).toFixed(1)}%`);
        console.log(`   ├─ Avg IoU:   ${(avgIoU * 100).toFixed(1)}%`);
        console.log(`   ├─ Exact:     ${(avgExactMatch * 100).toFixed(1)}%`);
        console.log(`   ├─ Within 3:  ${(avgWithin3 * 100).toFixed(1)}%`);
    }

    console.log(`   └─ Latency:   p50=${p50}  p95=${p95}`);
    console.log('');
});

console.log('─────────────────────────────────────────────────────────────────');
console.log('Score    = avg(Judge Sonnet score, Judge GPT score)');
console.log('Coverage = % dos bugs conhecidos que foram encontrados');
console.log('Validity = % das sugestoes que sao bugs reais');
console.log('Line Acc = IoU medio das linhas (incluindo bugs nao encontrados = 0)');
console.log('Avg IoU  = IoU medio so dos bugs que o modelo encontrou');
console.log('Exact    = % de linhas exatamente iguais ao reference');
console.log('Within 3 = % com diferenca <= 3 linhas no start/end');
console.log('');
