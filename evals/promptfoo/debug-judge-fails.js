/**
 * Debug script to investigate Gemini judge (google:gemini-2.5-pro) JSON extraction
 * failures in promptfoo eval results.
 *
 * Analyzes each test result's componentResults to find:
 * - Missing judge assertions (fewer than 2 llm-rubric results)
 * - "Could not extract JSON" errors
 * - Components with error-like content
 * - Components missing assertion.metric
 */

const fs = require('fs');
const path = require('path');

const outputPath = path.join(__dirname, 'results', 'output.json');
const data = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));

const results = data.results.results;

console.log('='.repeat(100));
console.log('PROMPTFOO JUDGE FAILURE DEBUG REPORT');
console.log('='.repeat(100));
console.log(`Total test results: ${results.length}`);
console.log();

// ──────────────────────────────────────────────────────────────────────────────
// Pass 1: Gather stats and identify problematic results
// ──────────────────────────────────────────────────────────────────────────────

let totalJsonExtractionErrors = 0;
let totalMissingJudge = 0;
let totalComponentsWithoutMetric = 0;
let totalErrorLikeReasons = 0;

const failedResults = [];

// Track per-provider and per-judge stats
const providerJudgeStats = {}; // provider -> { judge-gemini: {ok, fail, errors}, judge-gpt: {ok, fail, errors} }
const judgeErrorsByProvider = {}; // provider -> [{description, components, ...}]

for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const provider = result.provider?.id || result.provider?.label || 'unknown';
    const description = result.testCase?.description || `test-${i}`;
    const components = result.gradingResult?.componentResults || [];

    // Initialize provider stats
    if (!providerJudgeStats[provider]) {
        providerJudgeStats[provider] = {
            'judge-gemini': { ok: 0, fail: 0, jsonError: 0, missing: 0, total: 0 },
            'judge-gpt': { ok: 0, fail: 0, jsonError: 0, missing: 0, total: 0 },
        };
    }
    if (!judgeErrorsByProvider[provider]) {
        judgeErrorsByProvider[provider] = [];
    }

    // Classify each component
    const llmRubricResults = [];
    const nonLlmResults = [];
    const errorComponents = [];
    const missingMetricComponents = [];

    for (const comp of components) {
        const isLlmRubric = comp.assertion?.type === 'llm-rubric';
        const metric = comp.assertion?.metric;
        const reason = comp.reason || '';
        const hasJsonError = reason.includes('Could not extract JSON');
        const hasErrorContent = reason.toLowerCase().includes('error') ||
                                reason.includes('PARSE_FAIL') ||
                                reason.includes('timeout') ||
                                reason.includes('TIMEOUT');

        if (isLlmRubric) {
            llmRubricResults.push({
                metric,
                pass: comp.pass,
                score: comp.score,
                reason,
                tokensUsed: comp.tokensUsed,
                assertion: comp.assertion,
            });
        } else if (hasJsonError) {
            // This is a component WITHOUT assertion but WITH "Could not extract JSON"
            // This means promptfoo failed to parse the judge response
            errorComponents.push({
                type: 'JSON_EXTRACTION_FAILURE',
                pass: comp.pass,
                score: comp.score,
                reason,
                tokensUsed: comp.tokensUsed,
                hasAssertion: !!comp.assertion,
                assertionType: comp.assertion?.type,
                assertionMetric: comp.assertion?.metric,
            });
            totalJsonExtractionErrors++;
        } else if (!comp.assertion && hasErrorContent) {
            // Non-assertion component with error-like content
            nonLlmResults.push({
                type: 'ERROR_LIKE',
                pass: comp.pass,
                score: comp.score,
                reason,
            });
            totalErrorLikeReasons++;
        } else if (!comp.assertion) {
            // Non-assertion component (e.g., PARSE_OK, LINE_METRICS)
            nonLlmResults.push({
                type: 'NON_ASSERTION',
                pass: comp.pass,
                score: comp.score,
                reason,
            });
        }

        // Check for missing metric on assertion-bearing components
        if (comp.assertion && !comp.assertion.metric) {
            missingMetricComponents.push(comp);
            totalComponentsWithoutMetric++;
        }
    }

    // Count judge results by metric
    const judgeGeminiResults = llmRubricResults.filter(r => r.metric === 'judge-gemini');
    const judgeGptResults = llmRubricResults.filter(r => r.metric === 'judge-gpt');

    // Check for the "Could not extract JSON" pattern specifically:
    // These appear as components WITHOUT assertion field but WITH the JSON extraction error
    const jsonExtractionFailures = errorComponents.filter(e => e.type === 'JSON_EXTRACTION_FAILURE');

    // Update provider stats
    if (judgeGeminiResults.length > 0) {
        providerJudgeStats[provider]['judge-gemini'].total += judgeGeminiResults.length;
        for (const r of judgeGeminiResults) {
            if (r.pass) providerJudgeStats[provider]['judge-gemini'].ok++;
            else providerJudgeStats[provider]['judge-gemini'].fail++;
        }
    }
    if (judgeGptResults.length > 0) {
        providerJudgeStats[provider]['judge-gpt'].total += judgeGptResults.length;
        for (const r of judgeGptResults) {
            if (r.pass) providerJudgeStats[provider]['judge-gpt'].ok++;
            else providerJudgeStats[provider]['judge-gpt'].fail++;
        }
    }

    // Determine if this result has judge issues
    const hasJsonExtractionError = jsonExtractionFailures.length > 0;
    const missingGemini = judgeGeminiResults.length === 0;
    const missingGpt = judgeGptResults.length === 0;
    const hasFewLlmRubric = llmRubricResults.length < 2;

    if (hasJsonExtractionError) {
        providerJudgeStats[provider]['judge-gemini'].jsonError += jsonExtractionFailures.length;
    }
    if (missingGemini) {
        providerJudgeStats[provider]['judge-gemini'].missing++;
        totalMissingJudge++;
    }
    if (missingGpt) {
        providerJudgeStats[provider]['judge-gpt'].missing++;
        totalMissingJudge++;
    }

    if (hasJsonExtractionError || hasFewLlmRubric || missingMetricComponents.length > 0) {
        failedResults.push({
            index: i,
            provider,
            description,
            components,
            llmRubricResults,
            judgeGeminiResults,
            judgeGptResults,
            jsonExtractionFailures,
            nonLlmResults,
            missingMetricComponents,
            errorField: result.error,
            namedScores: result.gradingResult?.namedScores,
            topLevelScore: result.gradingResult?.score,
        });
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Pass 2: Print summary statistics
// ──────────────────────────────────────────────────────────────────────────────

console.log('-'.repeat(100));
console.log('SUMMARY STATISTICS');
console.log('-'.repeat(100));
console.log(`Total JSON extraction errors:        ${totalJsonExtractionErrors}`);
console.log(`Total missing judge assertions:       ${totalMissingJudge}`);
console.log(`Total components without metric:      ${totalComponentsWithoutMetric}`);
console.log(`Total error-like non-assertion comps:  ${totalErrorLikeReasons}`);
console.log(`Total failed/problematic results:     ${failedResults.length}`);
console.log();

// ──────────────────────────────────────────────────────────────────────────────
// Pass 3: Per-provider judge stats
// ──────────────────────────────────────────────────────────────────────────────

console.log('-'.repeat(100));
console.log('PER-PROVIDER JUDGE STATISTICS');
console.log('-'.repeat(100));

for (const [provider, stats] of Object.entries(providerJudgeStats)) {
    console.log(`\n  Provider: ${provider}`);
    for (const [judge, s] of Object.entries(stats)) {
        console.log(`    ${judge}:`);
        console.log(`      Total llm-rubric results: ${s.total}`);
        console.log(`      Passed: ${s.ok}`);
        console.log(`      Failed: ${s.fail}`);
        console.log(`      JSON extraction errors (missing assertion): ${s.jsonError}`);
        console.log(`      Missing entirely: ${s.missing}`);
    }
}
console.log();

// ──────────────────────────────────────────────────────────────────────────────
// Pass 4: Detailed failure analysis
// ──────────────────────────────────────────────────────────────────────────────

console.log('='.repeat(100));
console.log('DETAILED FAILURE ANALYSIS');
console.log('='.repeat(100));

for (const fail of failedResults) {
    console.log();
    console.log('#'.repeat(100));
    console.log(`Result #${fail.index}`);
    console.log(`  Provider:     ${fail.provider}`);
    console.log(`  Description:  ${fail.description}`);
    console.log(`  Top-level error field: ${fail.errorField ? fail.errorField.substring(0, 200) : 'NONE'}`);
    console.log(`  Named scores: ${JSON.stringify(fail.namedScores)}`);
    console.log(`  Overall score: ${fail.topLevelScore}`);
    console.log(`  Total components: ${fail.components.length}`);
    console.log(`  LLM-rubric components: ${fail.llmRubricResults.length}`);
    console.log(`  Judge-gemini results: ${fail.judgeGeminiResults.length}`);
    console.log(`  Judge-gpt results: ${fail.judgeGptResults.length}`);
    console.log(`  JSON extraction failures: ${fail.jsonExtractionFailures.length}`);
    console.log();

    // Print ALL component results
    console.log('  ALL COMPONENT RESULTS:');
    console.log('  ' + '-'.repeat(96));

    for (let ci = 0; ci < fail.components.length; ci++) {
        const comp = fail.components[ci];
        const type = comp.assertion?.type || '(no assertion)';
        const metric = comp.assertion?.metric || '(no metric)';
        const reason = (comp.reason || '').substring(0, 200);
        const providerId = comp.assertion?.provider?.id || '(no provider)';

        console.log(`  Component [${ci}]:`);
        console.log(`    Type:     ${type}`);
        console.log(`    Metric:   ${metric}`);
        console.log(`    Provider: ${providerId}`);
        console.log(`    Pass:     ${comp.pass}`);
        console.log(`    Score:    ${comp.score}`);
        console.log(`    Reason:   ${reason}`);

        if (comp.tokensUsed) {
            console.log(`    Tokens:   prompt=${comp.tokensUsed.prompt}, completion=${comp.tokensUsed.completion}, total=${comp.tokensUsed.total}, reasoning=${comp.tokensUsed.completionDetails?.reasoning || 0}`);
        }

        if (comp.error) {
            console.log(`    ERROR:    ${JSON.stringify(comp.error).substring(0, 200)}`);
        }

        console.log();
    }

    // Highlight the JSON extraction failure specifically
    if (fail.jsonExtractionFailures.length > 0) {
        console.log('  >>> JSON EXTRACTION FAILURE DETAILS:');
        for (const jf of fail.jsonExtractionFailures) {
            console.log(`    Has assertion object: ${jf.hasAssertion}`);
            console.log(`    Assertion type:       ${jf.assertionType || 'NONE'}`);
            console.log(`    Assertion metric:     ${jf.assertionMetric || 'NONE'}`);
            console.log(`    Score:                ${jf.score}`);
            console.log(`    Tokens used:          prompt=${jf.tokensUsed?.prompt}, completion=${jf.tokensUsed?.completion}, total=${jf.tokensUsed?.total}, reasoning=${jf.tokensUsed?.completionDetails?.reasoning || 0}`);
        }
    }

    console.log();
}

// ──────────────────────────────────────────────────────────────────────────────
// Pass 5: Pattern analysis - what do the JSON extraction failures look like?
// ──────────────────────────────────────────────────────────────────────────────

console.log('='.repeat(100));
console.log('PATTERN ANALYSIS: JSON EXTRACTION FAILURES');
console.log('='.repeat(100));
console.log();

// Collect all JSON extraction failure token stats
const jsonFailTokenStats = [];
for (const fail of failedResults) {
    for (const jf of fail.jsonExtractionFailures) {
        if (jf.tokensUsed) {
            jsonFailTokenStats.push({
                provider: fail.provider,
                description: fail.description,
                prompt: jf.tokensUsed.prompt,
                completion: jf.tokensUsed.completion,
                total: jf.tokensUsed.total,
                reasoning: jf.tokensUsed.completionDetails?.reasoning || 0,
                numRequests: jf.tokensUsed.numRequests,
            });
        }
    }
}

if (jsonFailTokenStats.length > 0) {
    console.log('Token usage for JSON extraction failures (these are the Gemini judge calls that failed):');
    console.log('-'.repeat(100));
    console.log(
        'Provider'.padEnd(40) +
        'Prompt'.padStart(8) +
        'Compl'.padStart(8) +
        'Reason'.padStart(8) +
        'Total'.padStart(8) +
        'Reqs'.padStart(6) +
        '  Description'
    );
    console.log('-'.repeat(100));

    for (const stat of jsonFailTokenStats) {
        console.log(
            stat.provider.padEnd(40) +
            String(stat.prompt).padStart(8) +
            String(stat.completion).padStart(8) +
            String(stat.reasoning).padStart(8) +
            String(stat.total).padStart(8) +
            String(stat.numRequests).padStart(6) +
            '  ' + stat.description.substring(0, 50)
        );
    }

    console.log();
    const avgCompletion = jsonFailTokenStats.reduce((s, t) => s + t.completion, 0) / jsonFailTokenStats.length;
    const avgReasoning = jsonFailTokenStats.reduce((s, t) => s + t.reasoning, 0) / jsonFailTokenStats.length;
    const avgTotal = jsonFailTokenStats.reduce((s, t) => s + t.total, 0) / jsonFailTokenStats.length;
    const minCompletion = Math.min(...jsonFailTokenStats.map(t => t.completion));
    const maxCompletion = Math.max(...jsonFailTokenStats.map(t => t.completion));

    console.log('Token statistics for failed Gemini judge calls:');
    console.log(`  Count:            ${jsonFailTokenStats.length}`);
    console.log(`  Avg completion:   ${avgCompletion.toFixed(0)}`);
    console.log(`  Min completion:   ${minCompletion}`);
    console.log(`  Max completion:   ${maxCompletion}`);
    console.log(`  Avg reasoning:    ${avgReasoning.toFixed(0)}`);
    console.log(`  Avg total:        ${avgTotal.toFixed(0)}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Pass 6: Compare successful vs failed Gemini judge token usage
// ──────────────────────────────────────────────────────────────────────────────

console.log();
console.log('='.repeat(100));
console.log('COMPARISON: SUCCESSFUL vs FAILED GEMINI JUDGE TOKEN USAGE');
console.log('='.repeat(100));
console.log();

const successfulGeminiTokens = [];
const failedGeminiTokens = [];

for (const result of results) {
    const components = result.gradingResult?.componentResults || [];
    for (const comp of components) {
        if (comp.assertion?.metric === 'judge-gemini' && comp.assertion?.type === 'llm-rubric') {
            successfulGeminiTokens.push({
                completion: comp.tokensUsed?.completion || 0,
                reasoning: comp.tokensUsed?.completionDetails?.reasoning || 0,
                total: comp.tokensUsed?.total || 0,
                pass: comp.pass,
                score: comp.score,
            });
        }
    }
    // Also find the JSON extraction failures (no assertion field)
    for (const comp of components) {
        if (!comp.assertion && comp.reason === 'Could not extract JSON from llm-rubric response') {
            failedGeminiTokens.push({
                completion: comp.tokensUsed?.completion || 0,
                reasoning: comp.tokensUsed?.completionDetails?.reasoning || 0,
                total: comp.tokensUsed?.total || 0,
            });
        }
    }
}

console.log('Successful Gemini judge calls (has assertion.metric = judge-gemini):');
if (successfulGeminiTokens.length > 0) {
    const avgComp = successfulGeminiTokens.reduce((s, t) => s + t.completion, 0) / successfulGeminiTokens.length;
    const avgReason = successfulGeminiTokens.reduce((s, t) => s + t.reasoning, 0) / successfulGeminiTokens.length;
    console.log(`  Count:          ${successfulGeminiTokens.length}`);
    console.log(`  Avg completion: ${avgComp.toFixed(0)}`);
    console.log(`  Avg reasoning:  ${avgReason.toFixed(0)}`);
    console.log(`  Completions:    [${successfulGeminiTokens.map(t => t.completion).join(', ')}]`);
} else {
    console.log('  (none found)');
}

console.log();
console.log('Failed Gemini judge calls (no assertion, "Could not extract JSON"):');
if (failedGeminiTokens.length > 0) {
    const avgComp = failedGeminiTokens.reduce((s, t) => s + t.completion, 0) / failedGeminiTokens.length;
    const avgReason = failedGeminiTokens.reduce((s, t) => s + t.reasoning, 0) / failedGeminiTokens.length;
    console.log(`  Count:          ${failedGeminiTokens.length}`);
    console.log(`  Avg completion: ${avgComp.toFixed(0)}`);
    console.log(`  Avg reasoning:  ${avgReason.toFixed(0)}`);
    console.log(`  Completions:    [${failedGeminiTokens.map(t => t.completion).join(', ')}]`);
    console.log(`  Reasoning:      [${failedGeminiTokens.map(t => t.reasoning).join(', ')}]`);
} else {
    console.log('  (none found)');
}

// ──────────────────────────────────────────────────────────────────────────────
// Pass 7: Determine which judge is failing - position analysis
// ──────────────────────────────────────────────────────────────────────────────

console.log();
console.log('='.repeat(100));
console.log('POSITION ANALYSIS: Where do JSON extraction failures appear in componentResults?');
console.log('='.repeat(100));
console.log();

for (const fail of failedResults) {
    if (fail.jsonExtractionFailures.length === 0) continue;

    const components = fail.components;
    console.log(`Result #${fail.index} (${fail.provider}) - ${fail.description}:`);

    for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci];
        const label = comp.assertion?.metric || (comp.reason?.includes('Could not extract JSON') ? '** JSON_FAIL **' : comp.reason?.substring(0, 30) || 'unknown');
        console.log(`  [${ci}] ${label} (pass=${comp.pass}, score=${comp.score})`);
    }
    console.log();
}

// ──────────────────────────────────────────────────────────────────────────────
// DIAGNOSIS
// ──────────────────────────────────────────────────────────────────────────────

console.log();
console.log('='.repeat(100));
console.log('DIAGNOSIS');
console.log('='.repeat(100));
console.log();

// Check if the pattern is: position 1 is always the JSON fail (where judge-gemini should be)
const positionCounts = {};
for (const fail of failedResults) {
    for (let ci = 0; ci < fail.components.length; ci++) {
        const comp = fail.components[ci];
        if (!comp.assertion && comp.reason === 'Could not extract JSON from llm-rubric response') {
            positionCounts[ci] = (positionCounts[ci] || 0) + 1;
        }
    }
}

console.log('JSON extraction failures by position in componentResults array:');
for (const [pos, count] of Object.entries(positionCounts)) {
    console.log(`  Position ${pos}: ${count} occurrences`);
}
console.log();

// Check the overall error field pattern
const errorFieldValues = {};
for (const fail of failedResults) {
    const errVal = fail.errorField || '(no error field)';
    const short = errVal.substring(0, 60);
    errorFieldValues[short] = (errorFieldValues[short] || 0) + 1;
}

console.log('Top-level result.error field values:');
for (const [val, count] of Object.entries(errorFieldValues)) {
    console.log(`  "${val}": ${count} times`);
}
console.log();

// Check: are there cases where BOTH judges failed?
let bothFailed = 0;
let onlyGeminiFailed = 0;
let onlyGptFailed = 0;

for (const fail of failedResults) {
    const hasGemini = fail.judgeGeminiResults.length > 0;
    const hasGpt = fail.judgeGptResults.length > 0;
    const jsonFails = fail.jsonExtractionFailures.length;

    if (!hasGemini && !hasGpt && jsonFails >= 2) bothFailed++;
    else if (!hasGemini && hasGpt && jsonFails >= 1) onlyGeminiFailed++;
    else if (hasGemini && !hasGpt && jsonFails >= 1) onlyGptFailed++;
}

console.log('Judge failure distribution:');
console.log(`  Only Gemini failed (GPT succeeded): ${onlyGeminiFailed}`);
console.log(`  Only GPT failed (Gemini succeeded): ${onlyGptFailed}`);
console.log(`  Both judges failed:                 ${bothFailed}`);
console.log();

// Final hypothesis
console.log('HYPOTHESIS:');
if (failedGeminiTokens.length > 0) {
    const avgCompletion = failedGeminiTokens.reduce((s, t) => s + t.completion, 0) / failedGeminiTokens.length;
    const hasReasoning = failedGeminiTokens.some(t => t.reasoning > 0);

    if (avgCompletion > 0 && avgCompletion < 500) {
        console.log('  (a) The Gemini judge IS responding (tokens used), but with SHORT completions');
        console.log(`      (avg ${avgCompletion.toFixed(0)} completion tokens).`);
        console.log('      This suggests the Gemini judge is returning text that promptfoo');
        console.log('      cannot parse as JSON (option c). The response likely contains the');
        console.log('      score evaluation in plain text instead of the expected JSON format');
        console.log('      {reason, pass, score}.');
    } else if (avgCompletion === 0) {
        console.log('  (b) The Gemini judge returned 0 completion tokens - likely a timeout or');
        console.log('      API error (option b).');
    } else {
        console.log('  (c) The Gemini judge IS responding with substantial output but promptfoo');
        console.log('      still cannot extract JSON from the response.');
    }

    if (hasReasoning) {
        console.log(`  NOTE: Some failed calls show reasoning tokens, indicating the model`);
        console.log(`      is "thinking" but its final output is not parseable as JSON.`);
    }
}
