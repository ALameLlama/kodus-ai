#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'output.json'), 'utf-8'));

// Model stats aggregator
const modelStats = {};

// The actual results array is at data.results.results
const results = data.results.results;

results.forEach(result => {
    const provider = result.provider.id || result.provider;

    if (!modelStats[provider]) {
        modelStats[provider] = {
            tests: 0,
            totalF1: 0,
            totalTP: 0,
            totalFP: 0,
            totalFN: 0,
            f1Scores: [],
            latencies: [],
            passAt07: 0,
            passAt05: 0
        };
    }

    const stats = modelStats[provider];
    stats.tests++;

    // Collect latency
    if (result.latencyMs) {
        stats.latencies.push(result.latencyMs);
    }

    // Find the llm-rubric assertion result
    const llmAssertion = result.gradingResult?.componentResults?.find(
        c => c.assertion?.type === 'llm-rubric'
    );

    if (llmAssertion) {
        const score = llmAssertion.score || 0;
        stats.totalF1 += score;
        stats.f1Scores.push(score);

        if (score >= 0.7) stats.passAt07++;
        if (score >= 0.5) stats.passAt05++;

        // Extract metrics from reason text
        const reason = llmAssertion.reason || '';

        // Try to extract coverage - multiple formats:
        // "coverage_score = 0.5" or "coverage is 2/2 = 1.0" or "reference coverage = 1/1 = 1.0"
        const coverageMatch = reason.match(/coverage[_\s]?(?:score)?\s*(?:is|=)\s*(?:\d+\/\d+\s*=\s*)?([\d.]+)/i);
        // Try to extract validity - multiple formats:
        // "validity_score = 1.0" or "validity is 2/2 = 1.0" or "validity = 1"
        const validityMatch = reason.match(/validity[_\s]?(?:score)?\s*(?:is|=)\s*(?:\d+\/\d+\s*=\s*)?([\d.]+)/i);

        if (coverageMatch) {
            stats.totalCoverage = (stats.totalCoverage || 0) + parseFloat(coverageMatch[1]);
            stats.coverageCount = (stats.coverageCount || 0) + 1;
        }
        if (validityMatch) {
            stats.totalValidity = (stats.totalValidity || 0) + parseFloat(validityMatch[1]);
            stats.validityCount = (stats.validityCount || 0) + 1;
        }

        // Also try old format: TP, FP, FN
        const tpMatch = reason.match(/TP\s*=\s*(\d+)/i) || reason.match(/(\d+)\s*TP/i);
        const fpMatch = reason.match(/FP\s*=\s*(\d+)/i) || reason.match(/(\d+)\s*FP/i);
        const fnMatch = reason.match(/FN\s*=\s*(\d+)/i) || reason.match(/(\d+)\s*FN/i);

        if (tpMatch) stats.totalTP += parseInt(tpMatch[1]);
        if (fpMatch) stats.totalFP += parseInt(fpMatch[1]);
        if (fnMatch) stats.totalFN += parseInt(fnMatch[1]);
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

// Sort by average F1
const sorted = Object.entries(modelStats).sort((a, b) =>
    (b[1].totalF1 / b[1].tests) - (a[1].totalF1 / a[1].tests)
);

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║              CODE REVIEW EVALUATION RESULTS                    ║');
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

    const avgF1 = (stats.totalF1 / stats.tests * 100).toFixed(1);
    const passRate07 = stats.passAt07;
    const passRate05 = stats.passAt05;
    const totalTests = stats.tests;

    // Calculate aggregate precision and recall
    const precision = stats.totalTP + stats.totalFP > 0
        ? (stats.totalTP / (stats.totalTP + stats.totalFP) * 100).toFixed(0)
        : 0;
    const recall = stats.totalTP + stats.totalFN > 0
        ? (stats.totalTP / (stats.totalTP + stats.totalFN) * 100).toFixed(0)
        : 0;

    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '  ';

    // Calculate latency percentiles
    const p50 = formatTime(percentile(stats.latencies, 50));
    const p95 = formatTime(percentile(stats.latencies, 95));

    // Calculate coverage and validity averages (new format)
    const avgCoverage = stats.coverageCount > 0
        ? (stats.totalCoverage / stats.coverageCount * 100).toFixed(0)
        : null;
    const avgValidity = stats.validityCount > 0
        ? (stats.totalValidity / stats.validityCount * 100).toFixed(0)
        : null;

    console.log(`${medal} ${shortName}`);
    console.log(`   ├─ Score:     ${avgF1}%`);
    console.log(`   ├─ Passou:    ${passRate07}/${totalTests} (threshold 0.7)`);

    // Show new format metrics if available
    if (avgCoverage !== null && avgValidity !== null) {
        console.log(`   ├─ Coverage:  ${avgCoverage}% (bugs do reference encontrados)`);
        console.log(`   ├─ Validity:  ${avgValidity}% (sugestões que são bugs reais)`);
    } else {
        // Fallback to old format
        console.log(`   ├─ Precision: ${precision}% (acertos / sugestões feitas)`);
        console.log(`   ├─ Recall:    ${recall}% (bugs encontrados / bugs reais)`);
        console.log(`   ├─ Acertos:   ${stats.totalTP} bugs corretos`);
        console.log(`   ├─ Erros:     ${stats.totalFP} sugestões erradas`);
        console.log(`   ├─ Perdidos:  ${stats.totalFN} bugs não encontrados`);
    }

    console.log(`   └─ Latência:  p50=${p50}  p95=${p95}`);
    console.log('');
});

console.log('─────────────────────────────────────────────────────────────────');
console.log('Score = (Coverage × 0.5) + (Validity × 0.5)');
console.log('Coverage = % dos bugs conhecidos que foram encontrados');
console.log('Validity = % das sugestões que são bugs reais');
console.log('');
