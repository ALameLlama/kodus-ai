#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'output.json'), 'utf-8'));
const results = data.results.results;

// ============================================================================
// SECTION 1: Per-test breakdown for EVERY result
// ============================================================================
console.log('');
console.log('='.repeat(100));
console.log('  SECTION 1: FULL TEST-BY-TEST BREAKDOWN (ALL MODELS)');
console.log('='.repeat(100));

const modelTestData = {}; // provider -> [{test, components, combinedScore}]

results.forEach((result, idx) => {
    const provider = result.provider?.id || result.provider || 'unknown';
    const testDesc = result.testCase?.description || `test-${idx}`;
    const components = result.gradingResult?.componentResults || [];
    const overallScore = result.score;

    if (!modelTestData[provider]) modelTestData[provider] = [];

    const testEntry = {
        testDesc,
        overallScore,
        components: [],
        judgeGemini: null,
        judgeGpt: null,
        parseResult: null,
        lineMetrics: null,
    };

    for (const c of components) {
        const type = c.assertion?.type || '(no-assertion)';
        const metric = c.assertion?.metric || '';
        const score = c.score;
        const pass = c.pass;
        const reason = (c.reason || '').substring(0, 120);

        const entry = { type, metric, score, pass, reason };
        testEntry.components.push(entry);

        if (type === 'llm-rubric' && metric.includes('gemini')) {
            testEntry.judgeGemini = { score, pass, reason };
        } else if (type === 'llm-rubric' && metric.includes('gpt')) {
            testEntry.judgeGpt = { score, pass, reason };
        } else if (reason.includes('PARSE_')) {
            testEntry.parseResult = { score, pass, reason };
        } else if (reason.includes('LINE_METRICS')) {
            testEntry.lineMetrics = { score, pass, reason };
        }
    }

    modelTestData[provider].push(testEntry);
});

// Print per-model, per-test
for (const [provider, tests] of Object.entries(modelTestData)) {
    console.log('');
    console.log('-'.repeat(100));
    console.log(`  MODEL: ${provider}  (${tests.length} tests)`);
    console.log('-'.repeat(100));

    tests.forEach((t, i) => {
        console.log(`\n  Test ${i + 1}: ${t.testDesc}`);
        console.log(`    Overall score: ${t.overallScore}`);
        console.log(`    Components (${t.components.length}):`);
        t.components.forEach((c, j) => {
            const passStr = c.pass ? 'PASS' : 'FAIL';
            console.log(`      [${j}] type=${c.type} metric=${c.metric || '-'} score=${c.score} ${passStr}`);
            console.log(`          reason: ${c.reason}`);
        });

        // Show combined score calculation
        const judgeScores = [];
        if (t.judgeGemini) judgeScores.push({ name: 'judge-gemini', score: t.judgeGemini.score });
        if (t.judgeGpt) judgeScores.push({ name: 'judge-gpt', score: t.judgeGpt.score });

        if (judgeScores.length > 0) {
            const avg = judgeScores.reduce((a, b) => a + b.score, 0) / judgeScores.length;
            const scoreStrs = judgeScores.map(j => `${j.name}=${j.score}`).join(' + ');
            console.log(`    -> Judge scores: ${scoreStrs} => avg=${avg.toFixed(4)} (${judgeScores.length} judge(s))`);
        } else {
            console.log(`    -> No judge scores found`);
        }
    });
}

// ============================================================================
// SECTION 2: GPT-5-MINI deep dive - ALL individual scores per test from both judges
// ============================================================================
console.log('\n');
console.log('='.repeat(100));
console.log('  SECTION 2: GPT-5-MINI DEEP DIVE');
console.log('='.repeat(100));

const gpt5miniTests = modelTestData['openai:gpt-5-mini'] || [];
if (gpt5miniTests.length === 0) {
    console.log('  WARNING: No results found for openai:gpt-5-mini');
    console.log('  Available providers:', Object.keys(modelTestData).join(', '));
} else {
    let totalGeminiScore = 0, totalGptScore = 0;
    let geminiCount = 0, gptCount = 0;
    let bothCount = 0, onlyGeminiCount = 0, onlyGptCount = 0, neitherCount = 0;

    console.log(`\n  Total tests: ${gpt5miniTests.length}\n`);

    gpt5miniTests.forEach((t, i) => {
        const hasGemini = t.judgeGemini !== null;
        const hasGpt = t.judgeGpt !== null;

        console.log(`  Test ${i + 1}: ${t.testDesc}`);
        console.log(`    Gemini: ${hasGemini ? `score=${t.judgeGemini.score} ${t.judgeGemini.pass ? 'PASS' : 'FAIL'}` : 'MISSING'}`);
        console.log(`    GPT:    ${hasGpt ? `score=${t.judgeGpt.score} ${t.judgeGpt.pass ? 'PASS' : 'FAIL'}` : 'MISSING'}`);

        if (hasGemini) {
            console.log(`    Gemini reason: ${t.judgeGemini.reason}`);
        }
        if (hasGpt) {
            console.log(`    GPT reason:    ${t.judgeGpt.reason}`);
        }

        // Compute combined for this test
        const scores = [];
        if (hasGemini) { scores.push(t.judgeGemini.score); totalGeminiScore += t.judgeGemini.score; geminiCount++; }
        if (hasGpt) { scores.push(t.judgeGpt.score); totalGptScore += t.judgeGpt.score; gptCount++; }

        if (hasGemini && hasGpt) bothCount++;
        else if (hasGemini && !hasGpt) onlyGeminiCount++;
        else if (!hasGemini && hasGpt) onlyGptCount++;
        else neitherCount++;

        const combined = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
        console.log(`    Combined: ${combined.toFixed(4)} (from ${scores.length} judge(s))`);
        console.log('');
    });

    console.log('  --- GPT-5-MINI SUMMARY ---');
    console.log(`  Avg Gemini score: ${geminiCount > 0 ? (totalGeminiScore / geminiCount).toFixed(4) : 'N/A'} (from ${geminiCount} tests)`);
    console.log(`  Avg GPT score:    ${gptCount > 0 ? (totalGptScore / gptCount).toFixed(4) : 'N/A'} (from ${gptCount} tests)`);
    console.log(`  Tests with BOTH judges:  ${bothCount}`);
    console.log(`  Tests with ONLY Gemini:  ${onlyGeminiCount}`);
    console.log(`  Tests with ONLY GPT:     ${onlyGptCount}`);
    console.log(`  Tests with NEITHER:      ${neitherCount}`);
}

// ============================================================================
// SECTION 3: Check for missing judges inflating scores (per model)
// ============================================================================
console.log('\n');
console.log('='.repeat(100));
console.log('  SECTION 3: JUDGE COVERAGE PER MODEL (missing judge detection)');
console.log('='.repeat(100));
console.log('');

const modelJudgeCoverage = {};

for (const [provider, tests] of Object.entries(modelTestData)) {
    const stats = {
        total: tests.length,
        bothJudges: 0,
        onlyGemini: 0,
        onlyGpt: 0,
        neither: 0,
        scoresWhenBoth: [],
        scoresWhenOnlyOne: [],
        geminiScoresAll: [],
        gptScoresAll: [],
    };

    tests.forEach(t => {
        const hasGemini = t.judgeGemini !== null;
        const hasGpt = t.judgeGpt !== null;

        if (hasGemini) stats.geminiScoresAll.push(t.judgeGemini.score);
        if (hasGpt) stats.gptScoresAll.push(t.judgeGpt.score);

        if (hasGemini && hasGpt) {
            stats.bothJudges++;
            const avg = (t.judgeGemini.score + t.judgeGpt.score) / 2;
            stats.scoresWhenBoth.push(avg);
        } else if (hasGemini || hasGpt) {
            if (hasGemini) stats.onlyGemini++;
            else stats.onlyGpt++;
            const singleScore = hasGemini ? t.judgeGemini.score : t.judgeGpt.score;
            stats.scoresWhenOnlyOne.push(singleScore);
        } else {
            stats.neither++;
        }
    });

    modelJudgeCoverage[provider] = stats;
}

// Print summary table
console.log('  Model                                         | Total | Both | Gemini | GPT  | Neither | Avg(Both) | Avg(Single) | BIAS?');
console.log('  ' + '-'.repeat(120));

const sortedModels = Object.entries(modelJudgeCoverage).sort((a, b) => {
    const aTotal = avg(a[1].scoresWhenBoth.concat(a[1].scoresWhenOnlyOne));
    const bTotal = avg(b[1].scoresWhenBoth.concat(b[1].scoresWhenOnlyOne));
    return (bTotal || 0) - (aTotal || 0);
});

function avg(arr) {
    if (!arr || arr.length === 0) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

sortedModels.forEach(([provider, s]) => {
    const shortName = provider.substring(0, 47).padEnd(47);
    const avgBoth = s.scoresWhenBoth.length > 0 ? avg(s.scoresWhenBoth).toFixed(4) : 'N/A   ';
    const avgSingle = s.scoresWhenOnlyOne.length > 0 ? avg(s.scoresWhenOnlyOne).toFixed(4) : 'N/A   ';
    const bias = (s.onlyGemini + s.onlyGpt > 0) ? ' <<<' : '';
    console.log(`  ${shortName} | ${String(s.total).padStart(5)} | ${String(s.bothJudges).padStart(4)} | ${String(s.onlyGemini).padStart(6)} | ${String(s.onlyGpt).padStart(4)} | ${String(s.neither).padStart(7)} | ${avgBoth}  | ${avgSingle}    |${bias}`);
});

// ============================================================================
// SECTION 4: Score distribution comparison - per model, Gemini vs GPT
// ============================================================================
console.log('\n');
console.log('='.repeat(100));
console.log('  SECTION 4: GEMINI vs GPT SCORE COMPARISON PER MODEL');
console.log('='.repeat(100));
console.log('');

for (const [provider, s] of sortedModels) {
    const geminiAvg = avg(s.geminiScoresAll);
    const gptAvg = avg(s.gptScoresAll);
    const diff = (geminiAvg !== null && gptAvg !== null) ? geminiAvg - gptAvg : null;
    const diffStr = diff !== null ? (diff > 0 ? `+${diff.toFixed(4)} Gemini higher` : `${diff.toFixed(4)} GPT higher`) : 'N/A';

    const shortName = provider.substring(0, 47).padEnd(47);
    console.log(`  ${shortName} | Gemini avg: ${geminiAvg !== null ? geminiAvg.toFixed(4) : 'N/A'} (n=${s.geminiScoresAll.length}) | GPT avg: ${gptAvg !== null ? gptAvg.toFixed(4) : 'N/A'} (n=${s.gptScoresAll.length}) | Diff: ${diffStr}`);
}

// ============================================================================
// SECTION 5: FINAL RANKING RECONSTRUCTION (how combined score is computed)
// ============================================================================
console.log('\n');
console.log('='.repeat(100));
console.log('  SECTION 5: RECONSTRUCTED RANKING (combined = avg of judge scores per test, then avg across tests)');
console.log('='.repeat(100));
console.log('');

const ranking = [];
for (const [provider, tests] of Object.entries(modelTestData)) {
    const combinedScores = [];
    tests.forEach(t => {
        const judgeScores = [];
        if (t.judgeGemini) judgeScores.push(t.judgeGemini.score);
        if (t.judgeGpt) judgeScores.push(t.judgeGpt.score);
        if (judgeScores.length > 0) {
            combinedScores.push(judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length);
        }
    });

    const overallAvg = combinedScores.length > 0 ? combinedScores.reduce((a, b) => a + b, 0) / combinedScores.length : 0;
    ranking.push({ provider, overallAvg, combinedScores, numTests: tests.length });
}

ranking.sort((a, b) => b.overallAvg - a.overallAvg);

ranking.forEach((r, i) => {
    const medal = i === 0 ? '#1' : i === 1 ? '#2' : i === 2 ? '#3' : `#${i + 1}`;
    const shortName = r.provider.substring(0, 47).padEnd(47);
    console.log(`  ${medal.padStart(3)} ${shortName} | Combined Avg: ${(r.overallAvg * 100).toFixed(2)}% | Tests: ${r.numTests}`);
    // Show individual test combined scores
    console.log(`       Per-test combined scores: [${r.combinedScores.map(s => (s * 100).toFixed(1)).join(', ')}]`);
});

// ============================================================================
// SECTION 6: SMOKING GUN - check for scores > 1.0 from judges
// ============================================================================
console.log('\n');
console.log('='.repeat(100));
console.log('  SECTION 6: ANOMALOUS SCORES (judge scores > 1.0 or < 0.0)');
console.log('='.repeat(100));
console.log('');

let anomalyCount = 0;
for (const [provider, tests] of Object.entries(modelTestData)) {
    tests.forEach((t, i) => {
        if (t.judgeGemini && (t.judgeGemini.score > 1.0 || t.judgeGemini.score < 0.0)) {
            console.log(`  ANOMALY: ${provider} test ${i + 1} (${t.testDesc})`);
            console.log(`    judge-gemini score = ${t.judgeGemini.score} (expected 0.0-1.0)`);
            console.log(`    reason: ${t.judgeGemini.reason}`);
            anomalyCount++;
        }
        if (t.judgeGpt && (t.judgeGpt.score > 1.0 || t.judgeGpt.score < 0.0)) {
            console.log(`  ANOMALY: ${provider} test ${i + 1} (${t.testDesc})`);
            console.log(`    judge-gpt score = ${t.judgeGpt.score} (expected 0.0-1.0)`);
            console.log(`    reason: ${t.judgeGpt.reason}`);
            anomalyCount++;
        }
    });
}

if (anomalyCount === 0) {
    console.log('  No anomalous scores found. All judge scores are in [0.0, 1.0] range.');
} else {
    console.log(`\n  Total anomalies: ${anomalyCount}`);
}

// ============================================================================
// SECTION 7: Check how promptfoo computes the overall "score" per test
// ============================================================================
console.log('\n');
console.log('='.repeat(100));
console.log('  SECTION 7: PROMPTFOO SCORE VERIFICATION (compare result.score vs component computation)');
console.log('='.repeat(100));
console.log('');

for (const [provider, tests] of Object.entries(modelTestData)) {
    tests.forEach((t, i) => {
        // Try to reconstruct the promptfoo score from components
        const allScores = t.components.map(c => c.score).filter(s => s != null);
        const avgAllComponents = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;

        const diff = Math.abs(t.overallScore - avgAllComponents);
        if (diff > 0.001) {
            console.log(`  ${provider} test ${i + 1}: result.score=${t.overallScore} vs avg(all components)=${avgAllComponents.toFixed(6)} DIFF=${diff.toFixed(6)}`);
        }
    });
}
console.log('  (Only showing mismatches > 0.001)\n');

// ============================================================================
// SECTION 8: ROOT CAUSE - "Could not extract JSON" failures for Gemini judge
// ============================================================================
console.log('');
console.log('='.repeat(100));
console.log('  SECTION 8: ROOT CAUSE - Gemini judge "Could not extract JSON" failures');
console.log('='.repeat(100));
console.log('');
console.log('  When the Gemini judge fails to return valid JSON, promptfoo records the component');
console.log('  WITHOUT assertion.type or assertion.metric, so it becomes invisible to the scoring');
console.log('  logic in analyze-results.js. The combined score for that test is then computed from');
console.log('  ONLY the GPT judge, rather than averaging both judges.\n');

const geminiFailures = {};
for (const [provider, tests] of Object.entries(modelTestData)) {
    let failCount = 0;
    tests.forEach((t, i) => {
        const hasJsonExtractFail = t.components.some(c => (c.reason || '').includes('Could not extract JSON'));
        if (hasJsonExtractFail) {
            failCount++;
        }
    });
    geminiFailures[provider] = failCount;
}

console.log('  Model                                         | Gemini JSON failures | Impact');
console.log('  ' + '-'.repeat(90));
const sortedFailures = Object.entries(geminiFailures).sort((a, b) => a[1] - b[1]);
sortedFailures.forEach(([provider, count]) => {
    const shortName = provider.substring(0, 47).padEnd(47);
    const impact = count === 0 ? 'None - both judges always score' :
        `${count}/15 tests scored by GPT-only (potential inflation)`;
    console.log(`  ${shortName} | ${String(count).padStart(20)} | ${impact}`);
});

console.log('');
console.log('  KEY INSIGHT:');
console.log('  GPT-5-mini has only 3 Gemini failures (fewest among models with failures).');
console.log('  But this does NOT explain why it ranks #1. Let us compare what happens when');
console.log('  we ONLY count tests where BOTH judges scored.\n');

// Recompute ranking using ONLY tests where both judges scored
console.log('  --- CORRECTED RANKING (only tests with BOTH judges) ---\n');
const correctedRanking = [];
for (const [provider, tests] of Object.entries(modelTestData)) {
    const bothJudgeScores = [];
    const allScores = [];
    tests.forEach(t => {
        const judgeScores = [];
        if (t.judgeGemini) judgeScores.push(t.judgeGemini.score);
        if (t.judgeGpt) judgeScores.push(t.judgeGpt.score);
        if (judgeScores.length === 2) {
            bothJudgeScores.push((judgeScores[0] + judgeScores[1]) / 2);
        }
        if (judgeScores.length > 0) {
            allScores.push(judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length);
        }
    });

    const correctedAvg = bothJudgeScores.length > 0 ? bothJudgeScores.reduce((a, b) => a + b, 0) / bothJudgeScores.length : 0;
    const originalAvg = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
    correctedRanking.push({ provider, correctedAvg, originalAvg, bothCount: bothJudgeScores.length });
}

correctedRanking.sort((a, b) => b.correctedAvg - a.correctedAvg);
correctedRanking.forEach((r, i) => {
    const medal = `#${i + 1}`;
    const shortName = r.provider.substring(0, 47).padEnd(47);
    const change = r.correctedAvg > r.originalAvg ? 'UP' : r.correctedAvg < r.originalAvg ? 'DOWN' : 'SAME';
    console.log(`  ${medal.padStart(3)} ${shortName} | Corrected: ${(r.correctedAvg * 100).toFixed(2)}% (n=${r.bothCount}) | Original: ${(r.originalAvg * 100).toFixed(2)}% | ${change}`);
});

// Final diagnosis
console.log('');
console.log('='.repeat(100));
console.log('  DIAGNOSIS: WHY GPT-5-MINI RANKS #1');
console.log('='.repeat(100));
console.log('');
console.log('  1. GEMINI JUDGE IS A LENIENT GRADER: Across ALL models, Gemini judge scores');
console.log('     are systematically higher than GPT judge scores (Section 4 shows Gemini');
console.log('     is always higher, by +0.22 to +0.65 points).');
console.log('');
console.log('  2. GEMINI JUDGE FAILURES ("Could not extract JSON"): The Gemini judge fails');
console.log('     to return valid JSON on some tests. When it fails, only the GPT judge score');
console.log('     is used. Since GPT scores lower, models with MORE Gemini failures get');
console.log('     penalized (their avg is dragged down by GPT-only tests).');
console.log('');
console.log('  3. GPT-5-MINI HAS FEW GEMINI FAILURES: With only 3/15 Gemini failures,');
console.log('     GPT-5-mini retains the high Gemini scores on 12/15 tests. Combined with');
console.log('     decent GPT scores, it gets inflated above models that have more failures.');
console.log('');
console.log('  4. ACTUAL PERFORMANCE: When considering only tests where BOTH judges scored,');
console.log('     the ranking may shift. The corrected ranking above shows the true picture.');
console.log('');
console.log('  ROOT CAUSE SUMMARY: The ranking is skewed by (a) Gemini judge being');
console.log('  systematically more lenient than GPT judge, and (b) Gemini judge failing');
console.log('  non-uniformly across models, creating an uneven playing field.');
console.log('');
