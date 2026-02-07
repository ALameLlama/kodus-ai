#!/usr/bin/env node
/**
 * Bias Analysis Script for GPT-5.2 Judge
 *
 * Analyzes eval results to determine whether the GPT-5.2 judge
 * shows bias toward GPT models vs other model families.
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'results', 'output.json');
const data = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
const results = data.results.results;

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function extractScoresFromReason(reason) {
  const coverageMatch = reason.match(/coverage_score\s*=\s*[\d\/]+\s*=\s*([\d.]+)/);
  const validityMatch = reason.match(/validity_score\s*=\s*[\d\/]+\s*=\s*([\d.]+)/);
  const finalMatch = reason.match(/final_score\s*=\s*[\d.*+\s]+=\s*([\d.]+)/);

  // Also extract raw counts for validity e.g. "validity_score = 2/3"
  const validityFraction = reason.match(/validity_score\s*=\s*(\d+)\/(\d+)/);
  const coverageFraction = reason.match(/coverage_score\s*=\s*(\d+)\/(\d+)/);

  return {
    coverage: coverageMatch ? parseFloat(coverageMatch[1]) : null,
    validity: validityMatch ? parseFloat(validityMatch[1]) : null,
    final: finalMatch ? parseFloat(finalMatch[1]) : null,
    validityValid: validityFraction ? parseInt(validityFraction[1]) : null,
    validityTotal: validityFraction ? parseInt(validityFraction[2]) : null,
    coverageFound: coverageFraction ? parseInt(coverageFraction[1]) : null,
    coverageTotal: coverageFraction ? parseInt(coverageFraction[2]) : null,
  };
}

function extractSuggestionCount(parseReason) {
  const match = parseReason.match(/(\d+)\s+suggestions?\s+parsed/);
  return match ? parseInt(match[1]) : 0;
}

function isParseError(parseReason) {
  return parseReason.includes('PARSE_FAIL');
}

function getModelFamily(providerId) {
  if (providerId.includes('gpt')) return 'GPT';
  if (providerId.includes('claude')) return 'Claude';
  if (providerId.includes('gemini')) return 'Gemini';
  if (providerId.includes('glm')) return 'GLM';
  if (providerId.includes('kimi')) return 'Kimi';
  return 'Other';
}

function shortName(providerId) {
  // Return a shorter readable name
  if (providerId.includes('gpt-5.2')) return 'GPT-5.2';
  if (providerId.includes('gpt-5-mini')) return 'GPT-5-mini';
  if (providerId.includes('claude-sonnet')) return 'Claude-Sonnet-4.5';
  if (providerId.includes('gemini-2.5-pro')) return 'Gemini-2.5-Pro';
  if (providerId.includes('gemini-3-flash')) return 'Gemini-3-Flash';
  if (providerId.includes('gemini-3-pro')) return 'Gemini-3-Pro';
  if (providerId.includes('glm-4.7')) return 'GLM-4.7';
  if (providerId.includes('kimi-k2.5')) return 'Kimi-K2.5';
  return providerId;
}

function padRight(str, len) {
  str = String(str);
  return str.length >= len ? str.substring(0, len) : str + ' '.repeat(len - str.length);
}

function padLeft(str, len) {
  str = String(str);
  return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}

// ──────────────────────────────────────────────────────
// Parse all results
// ──────────────────────────────────────────────────────

const parsed = results.map(r => {
  const components = r.gradingResult?.componentResults || [];
  const parseComp = components[0] || { reason: '', score: 0 };
  const llmComp = components[1] || { reason: '', score: 0 };
  const lineComp = components[2] || { reason: '', score: 0 };

  const scores = extractScoresFromReason(llmComp.reason || '');
  const suggestionCount = extractSuggestionCount(parseComp.reason || '');
  const parseError = isParseError(parseComp.reason || '');

  // Extract line metrics
  const lineMatch = (lineComp?.reason || '').match(/line_acc=([\d.]+)/);
  const lineAcc = lineMatch ? parseFloat(lineMatch[1]) : null;

  // Extract individual suggestion validity assessments
  const validityDetails = [];
  const validitySection = (llmComp.reason || '').split(/Suggestion validity/i)[1] || '';
  const suggestionAssessments = validitySection.match(/\d+\)\s+(VALID|INVALID|BORDERLINE)[.:]?[^\n]*/g) || [];
  suggestionAssessments.forEach(a => {
    const statusMatch = a.match(/^(\d+)\)\s+(VALID|INVALID|BORDERLINE)/);
    if (statusMatch) {
      validityDetails.push({
        index: parseInt(statusMatch[1]),
        status: statusMatch[2],
        text: a.trim()
      });
    }
  });

  return {
    provider: r.provider.id,
    shortName: shortName(r.provider.id),
    family: getModelFamily(r.provider.id),
    testIdx: r.testIdx,
    testDesc: r.testCase?.description || `Test ${r.testIdx}`,
    overallScore: r.gradingResult.score,
    llmScore: llmComp.score,
    llmReason: llmComp.reason || '',
    coverage: scores.coverage,
    validity: scores.validity,
    finalScore: scores.final,
    validityValid: scores.validityValid,
    validityTotal: scores.validityTotal,
    coverageFound: scores.coverageFound,
    coverageTotal: scores.coverageTotal,
    suggestionCount,
    parseError,
    lineAcc,
    validityDetails,
    isGPT: getModelFamily(r.provider.id) === 'GPT',
  };
});

// Group by testIdx
const byTest = new Map();
parsed.forEach(p => {
  if (!byTest.has(p.testIdx)) byTest.set(p.testIdx, []);
  byTest.get(p.testIdx).push(p);
});

// Group by provider
const byProvider = new Map();
parsed.forEach(p => {
  if (!byProvider.has(p.shortName)) byProvider.set(p.shortName, []);
  byProvider.get(p.shortName).push(p);
});

const SEP = '═'.repeat(120);
const THIN_SEP = '─'.repeat(120);

// ──────────────────────────────────────────────────────
// SECTION 1: Side-by-side comparison per test case
// ──────────────────────────────────────────────────────

console.log('\n' + SEP);
console.log('  SECTION 1: SIDE-BY-SIDE MODEL COMPARISON PER TEST CASE');
console.log(SEP + '\n');

for (const [testIdx, testResults] of byTest) {
  console.log(THIN_SEP);
  console.log(`TEST ${testIdx}: ${testResults[0].testDesc}`);
  console.log(THIN_SEP);

  // Sort: GPT models first, then others
  const sorted = [...testResults].sort((a, b) => {
    if (a.isGPT && !b.isGPT) return -1;
    if (!a.isGPT && b.isGPT) return 1;
    return a.shortName.localeCompare(b.shortName);
  });

  for (const r of sorted) {
    const gptTag = r.isGPT ? ' [GPT MODEL]' : '';
    console.log(`\n  ► ${r.shortName}${gptTag}`);
    console.log(`    Coverage: ${r.coverage !== null ? r.coverage.toFixed(2) : 'N/A'} (${r.coverageFound}/${r.coverageTotal} bugs found)`);
    console.log(`    Validity: ${r.validity !== null ? r.validity.toFixed(2) : 'N/A'} (${r.validityValid}/${r.validityTotal} valid)`);
    console.log(`    Final LLM Score: ${r.finalScore !== null ? r.finalScore.toFixed(2) : 'N/A'}`);
    console.log(`    Suggestions: ${r.suggestionCount}  |  Parse Error: ${r.parseError ? 'YES' : 'No'}  |  Line Acc: ${r.lineAcc !== null ? r.lineAcc.toFixed(3) : 'N/A'}`);

    // Show validity details
    if (r.validityDetails.length > 0) {
      console.log('    Validity breakdown:');
      r.validityDetails.forEach(v => {
        const marker = v.status === 'VALID' ? '  ✓' : v.status === 'INVALID' ? '  ✗' : '  ~';
        console.log(`      ${marker} ${v.text.substring(0, 110)}`);
      });
    }
  }

  // Highlight discrepancies
  const validityScores = sorted.map(r => r.validity).filter(v => v !== null);
  const minValidity = Math.min(...validityScores);
  const maxValidity = Math.max(...validityScores);
  if (maxValidity - minValidity > 0.01) {
    console.log('\n  *** VALIDITY DISCREPANCY DETECTED ***');
    const gptResults = sorted.filter(r => r.isGPT && r.validity !== null);
    const nonGptResults = sorted.filter(r => !r.isGPT && r.validity !== null);
    const avgGptValidity = gptResults.length > 0
      ? gptResults.reduce((s, r) => s + r.validity, 0) / gptResults.length
      : null;
    const avgNonGptValidity = nonGptResults.length > 0
      ? nonGptResults.reduce((s, r) => s + r.validity, 0) / nonGptResults.length
      : null;

    if (avgGptValidity !== null && avgNonGptValidity !== null) {
      const diff = avgGptValidity - avgNonGptValidity;
      console.log(`    GPT avg validity: ${avgGptValidity.toFixed(3)}  |  Non-GPT avg validity: ${avgNonGptValidity.toFixed(3)}  |  Diff: ${diff > 0 ? '+' : ''}${diff.toFixed(3)}`);
    }
  }
  console.log('');
}

// ──────────────────────────────────────────────────────
// SECTION 2: Pattern Analysis
// ──────────────────────────────────────────────────────

console.log('\n' + SEP);
console.log('  SECTION 2: BIAS PATTERN ANALYSIS');
console.log(SEP + '\n');

// 2a. Per-test GPT vs Non-GPT validity comparison
console.log('2a) GPT vs Non-GPT Validity Scores Per Test\n');

console.log(
  padRight('Test', 6) +
  padRight('GPT avg validity', 20) +
  padRight('Non-GPT avg validity', 24) +
  padRight('Delta', 10) +
  'Bias Direction'
);
console.log(THIN_SEP);

const perTestBias = [];
for (const [testIdx, testResults] of byTest) {
  const gpt = testResults.filter(r => r.isGPT && r.validity !== null);
  const nonGpt = testResults.filter(r => !r.isGPT && r.validity !== null);

  const avgGpt = gpt.length > 0 ? gpt.reduce((s, r) => s + r.validity, 0) / gpt.length : null;
  const avgNonGpt = nonGpt.length > 0 ? nonGpt.reduce((s, r) => s + r.validity, 0) / nonGpt.length : null;

  if (avgGpt !== null && avgNonGpt !== null) {
    const delta = avgGpt - avgNonGpt;
    perTestBias.push(delta);
    const direction = delta > 0.05 ? 'GPT FAVORED' : delta < -0.05 ? 'Non-GPT FAVORED' : 'NEUTRAL';
    console.log(
      padRight(testIdx, 6) +
      padRight(avgGpt.toFixed(3), 20) +
      padRight(avgNonGpt.toFixed(3), 24) +
      padRight((delta > 0 ? '+' : '') + delta.toFixed(3), 10) +
      direction
    );
  }
}

const overallBias = perTestBias.length > 0
  ? perTestBias.reduce((s, v) => s + v, 0) / perTestBias.length
  : 0;
console.log(THIN_SEP);
console.log(`Overall avg delta (GPT - Non-GPT validity): ${overallBias > 0 ? '+' : ''}${overallBias.toFixed(4)}\n`);

// 2b. Same analysis for coverage
console.log('2b) GPT vs Non-GPT Coverage Scores Per Test\n');

console.log(
  padRight('Test', 6) +
  padRight('GPT avg coverage', 20) +
  padRight('Non-GPT avg coverage', 24) +
  padRight('Delta', 10) +
  'Direction'
);
console.log(THIN_SEP);

const perTestCoverageBias = [];
for (const [testIdx, testResults] of byTest) {
  const gpt = testResults.filter(r => r.isGPT && r.coverage !== null);
  const nonGpt = testResults.filter(r => !r.isGPT && r.coverage !== null);

  const avgGpt = gpt.length > 0 ? gpt.reduce((s, r) => s + r.coverage, 0) / gpt.length : null;
  const avgNonGpt = nonGpt.length > 0 ? nonGpt.reduce((s, r) => s + r.coverage, 0) / nonGpt.length : null;

  if (avgGpt !== null && avgNonGpt !== null) {
    const delta = avgGpt - avgNonGpt;
    perTestCoverageBias.push(delta);
    const direction = delta > 0.05 ? 'GPT HIGHER' : delta < -0.05 ? 'Non-GPT HIGHER' : 'SIMILAR';
    console.log(
      padRight(testIdx, 6) +
      padRight(avgGpt.toFixed(3), 20) +
      padRight(avgNonGpt.toFixed(3), 24) +
      padRight((delta > 0 ? '+' : '') + delta.toFixed(3), 10) +
      direction
    );
  }
}

const overallCovBias = perTestCoverageBias.length > 0
  ? perTestCoverageBias.reduce((s, v) => s + v, 0) / perTestCoverageBias.length
  : 0;
console.log(THIN_SEP);
console.log(`Overall avg delta (GPT - Non-GPT coverage): ${overallCovBias > 0 ? '+' : ''}${overallCovBias.toFixed(4)}\n`);

// 2c. Suggestion count analysis - do GPT models make more/fewer suggestions?
console.log('2c) Suggestion Count Analysis\n');

console.log(
  padRight('Test', 6) +
  padRight('GPT avg suggestions', 22) +
  padRight('Non-GPT avg suggestions', 26) +
  padRight('Ref Bugs', 10)
);
console.log(THIN_SEP);

for (const [testIdx, testResults] of byTest) {
  const gpt = testResults.filter(r => r.isGPT);
  const nonGpt = testResults.filter(r => !r.isGPT);

  const avgGpt = gpt.length > 0 ? gpt.reduce((s, r) => s + r.suggestionCount, 0) / gpt.length : 0;
  const avgNonGpt = nonGpt.length > 0 ? nonGpt.reduce((s, r) => s + r.suggestionCount, 0) / nonGpt.length : 0;
  const refBugs = testResults[0].coverageTotal || '?';

  console.log(
    padRight(testIdx, 6) +
    padRight(avgGpt.toFixed(1), 22) +
    padRight(avgNonGpt.toFixed(1), 26) +
    padRight(refBugs, 10)
  );
}
console.log('');

// 2d. INVALID suggestions analysis - where does the judge mark INVALID?
console.log('2d) INVALID Suggestion Analysis by Model Family\n');

const invalidByFamily = {};
const totalByFamily = {};

parsed.forEach(p => {
  if (!invalidByFamily[p.family]) { invalidByFamily[p.family] = 0; totalByFamily[p.family] = 0; }
  p.validityDetails.forEach(v => {
    totalByFamily[p.family]++;
    if (v.status === 'INVALID') invalidByFamily[p.family]++;
  });
});

console.log(padRight('Family', 12) + padRight('Total Suggestions', 20) + padRight('INVALID', 10) + padRight('INVALID %', 12));
console.log(THIN_SEP);
for (const family of Object.keys(totalByFamily).sort()) {
  const total = totalByFamily[family];
  const invalid = invalidByFamily[family];
  const pct = total > 0 ? ((invalid / total) * 100).toFixed(1) : 'N/A';
  console.log(padRight(family, 12) + padRight(total, 20) + padRight(invalid, 10) + padRight(pct + '%', 12));
}
console.log('');

// 2e. Deep dive: cases where GPT model got VALID but non-GPT got INVALID for conceptually similar issues
console.log('2e) Detailed Validity Reasoning Comparison (Full Judge Reasoning)\n');

for (const [testIdx, testResults] of byTest) {
  console.log(THIN_SEP);
  console.log(`TEST ${testIdx}: ${testResults[0].testDesc}`);
  console.log(THIN_SEP);

  // Sort: GPT first
  const sorted = [...testResults].sort((a, b) => {
    if (a.isGPT && !b.isGPT) return -1;
    if (!a.isGPT && b.isGPT) return 1;
    return a.shortName.localeCompare(b.shortName);
  });

  for (const r of sorted) {
    const gptTag = r.isGPT ? ' [GPT]' : '';
    console.log(`\n  ═══ ${r.shortName}${gptTag} ═══`);

    // Print validity section of judge reasoning
    const parts = r.llmReason.split(/\n/);
    const validityStart = parts.findIndex(l => /suggestion validity/i.test(l));
    const coverageStart = parts.findIndex(l => /coverage/i.test(l) && /score/i.test(l) && l.includes('='));

    if (validityStart >= 0) {
      const endIdx = coverageStart > validityStart ? coverageStart : parts.length;
      const validityLines = parts.slice(validityStart, endIdx);
      console.log('  ' + validityLines.join('\n  '));
    }

    console.log(`  -> Scores: coverage=${r.coverage}, validity=${r.validity}, final=${r.finalScore}`);
  }
  console.log('');
}

// ──────────────────────────────────────────────────────
// SECTION 3: Summary Table
// ──────────────────────────────────────────────────────

console.log('\n' + SEP);
console.log('  SECTION 3: SUMMARY TABLE');
console.log(SEP + '\n');

// Sort providers: GPT first
const providerOrder = [...byProvider.keys()].sort((a, b) => {
  const aIsGPT = a.includes('GPT');
  const bIsGPT = b.includes('GPT');
  if (aIsGPT && !bIsGPT) return -1;
  if (!aIsGPT && bIsGPT) return 1;
  return a.localeCompare(b);
});

const header =
  padRight('Model', 20) +
  padRight('Family', 8) +
  padRight('Avg Cov', 10) +
  padRight('Avg Val', 10) +
  padRight('Avg Score', 12) +
  padRight('Avg #Sugg', 12) +
  padRight('Parse Err', 12) +
  padRight('Line Acc', 10) +
  'Tests';

console.log(header);
console.log(THIN_SEP);

for (const name of providerOrder) {
  const entries = byProvider.get(name);
  const family = entries[0].family;

  const validCov = entries.filter(e => e.coverage !== null);
  const validVal = entries.filter(e => e.validity !== null);
  const validLine = entries.filter(e => e.lineAcc !== null);

  const avgCov = validCov.length > 0 ? validCov.reduce((s, e) => s + e.coverage, 0) / validCov.length : null;
  const avgVal = validVal.length > 0 ? validVal.reduce((s, e) => s + e.validity, 0) / validVal.length : null;
  const avgScore = entries.reduce((s, e) => s + (e.finalScore || 0), 0) / entries.length;
  const avgSugg = entries.reduce((s, e) => s + e.suggestionCount, 0) / entries.length;
  const parseErrors = entries.filter(e => e.parseError).length;
  const avgLine = validLine.length > 0 ? validLine.reduce((s, e) => s + e.lineAcc, 0) / validLine.length : null;

  const isGPT = family === 'GPT';
  const marker = isGPT ? ' *' : '';

  console.log(
    padRight(name + marker, 20) +
    padRight(family, 8) +
    padRight(avgCov !== null ? avgCov.toFixed(3) : 'N/A', 10) +
    padRight(avgVal !== null ? avgVal.toFixed(3) : 'N/A', 10) +
    padRight(avgScore.toFixed(3), 12) +
    padRight(avgSugg.toFixed(1), 12) +
    padRight(parseErrors + '/' + entries.length, 12) +
    padRight(avgLine !== null ? avgLine.toFixed(3) : 'N/A', 10) +
    entries.length
  );
}

console.log('\n(* = GPT model, judged by GPT-5.2)\n');

// ──────────────────────────────────────────────────────
// SECTION 4: Statistical Summary & Conclusion
// ──────────────────────────────────────────────────────

console.log(SEP);
console.log('  SECTION 4: STATISTICAL SUMMARY & BIAS ASSESSMENT');
console.log(SEP + '\n');

// Aggregate GPT vs non-GPT
const gptAll = parsed.filter(p => p.isGPT);
const nonGptAll = parsed.filter(p => !p.isGPT);

const gptValidities = gptAll.filter(p => p.validity !== null).map(p => p.validity);
const nonGptValidities = nonGptAll.filter(p => p.validity !== null).map(p => p.validity);
const gptCoverages = gptAll.filter(p => p.coverage !== null).map(p => p.coverage);
const nonGptCoverages = nonGptAll.filter(p => p.coverage !== null).map(p => p.coverage);

const avg = arr => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
const stddev = arr => {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
};

console.log('Aggregate GPT vs Non-GPT Comparison:');
console.log(THIN_SEP);
console.log(`GPT Models (n=${gptAll.length}):`);
console.log(`  Avg Validity:  ${avg(gptValidities)?.toFixed(4)} (std: ${stddev(gptValidities).toFixed(4)})`);
console.log(`  Avg Coverage:  ${avg(gptCoverages)?.toFixed(4)} (std: ${stddev(gptCoverages).toFixed(4)})`);
console.log(`  Avg Suggestions: ${avg(gptAll.map(p => p.suggestionCount))?.toFixed(2)}`);
console.log(`  Parse Errors: ${gptAll.filter(p => p.parseError).length}/${gptAll.length}`);
console.log('');

console.log(`Non-GPT Models (n=${nonGptAll.length}):`);
console.log(`  Avg Validity:  ${avg(nonGptValidities)?.toFixed(4)} (std: ${stddev(nonGptValidities).toFixed(4)})`);
console.log(`  Avg Coverage:  ${avg(nonGptCoverages)?.toFixed(4)} (std: ${stddev(nonGptCoverages).toFixed(4)})`);
console.log(`  Avg Suggestions: ${avg(nonGptAll.map(p => p.suggestionCount))?.toFixed(2)}`);
console.log(`  Parse Errors: ${nonGptAll.filter(p => p.parseError).length}/${nonGptAll.length}`);
console.log('');

const valDiff = avg(gptValidities) - avg(nonGptValidities);
const covDiff = avg(gptCoverages) - avg(nonGptCoverages);

console.log('Deltas (GPT minus Non-GPT):');
console.log(`  Validity Delta:  ${valDiff > 0 ? '+' : ''}${valDiff?.toFixed(4)}`);
console.log(`  Coverage Delta:  ${covDiff > 0 ? '+' : ''}${covDiff?.toFixed(4)}`);
console.log('');

// Simple t-test approximation (Welch's)
function welchTTest(arr1, arr2) {
  const n1 = arr1.length, n2 = arr2.length;
  if (n1 < 2 || n2 < 2) return { t: NaN, df: NaN, significant: false };
  const m1 = avg(arr1), m2 = avg(arr2);
  const s1 = stddev(arr1), s2 = stddev(arr2);
  const se = Math.sqrt((s1 * s1) / n1 + (s2 * s2) / n2);
  if (se === 0) return { t: 0, df: n1 + n2 - 2, significant: false };
  const t = (m1 - m2) / se;
  const df = ((s1 * s1 / n1 + s2 * s2 / n2) ** 2) /
    ((s1 * s1 / n1) ** 2 / (n1 - 1) + (s2 * s2 / n2) ** 2 / (n2 - 1));
  // Rough significance: |t| > 2.0 for moderate df ~ p < 0.05 (two-tailed)
  const significant = Math.abs(t) > 2.0;
  return { t, df, significant };
}

const valTTest = welchTTest(gptValidities, nonGptValidities);
const covTTest = welchTTest(gptCoverages, nonGptCoverages);

console.log("Welch's t-test (approximate):");
console.log(`  Validity: t=${valTTest.t?.toFixed(3)}, df=${valTTest.df?.toFixed(1)}, ${valTTest.significant ? 'SIGNIFICANT (|t|>2)' : 'NOT significant'}`);
console.log(`  Coverage: t=${covTTest.t?.toFixed(3)}, df=${covTTest.df?.toFixed(1)}, ${covTTest.significant ? 'SIGNIFICANT (|t|>2)' : 'NOT significant'}`);
console.log('');

// Per-model family breakdown
console.log('Per-Family Breakdown:');
console.log(THIN_SEP);
const families = {};
parsed.forEach(p => {
  if (!families[p.family]) families[p.family] = [];
  families[p.family].push(p);
});

for (const [family, entries] of Object.entries(families).sort()) {
  const vals = entries.filter(e => e.validity !== null).map(e => e.validity);
  const covs = entries.filter(e => e.coverage !== null).map(e => e.coverage);
  const suggs = entries.map(e => e.suggestionCount);
  const parseErrs = entries.filter(e => e.parseError).length;

  console.log(`  ${family} (n=${entries.length}):`);
  console.log(`    Validity: avg=${avg(vals)?.toFixed(3)}, std=${stddev(vals).toFixed(3)}`);
  console.log(`    Coverage: avg=${avg(covs)?.toFixed(3)}, std=${stddev(covs).toFixed(3)}`);
  console.log(`    Suggestions: avg=${avg(suggs)?.toFixed(1)}`);
  console.log(`    Parse Errors: ${parseErrs}`);
}
console.log('');

// Final assessment
console.log(THIN_SEP);
console.log('BIAS ASSESSMENT:');
console.log(THIN_SEP);

if (Math.abs(valDiff) < 0.05 && !valTTest.significant) {
  console.log('  VALIDITY: No significant bias detected. GPT and non-GPT models receive');
  console.log('  similar validity scores from the judge.');
} else if (valDiff > 0 && valTTest.significant) {
  console.log('  VALIDITY: POTENTIAL BIAS DETECTED - GPT models receive significantly higher');
  console.log(`  validity scores (delta: +${valDiff.toFixed(4)}, t=${valTTest.t.toFixed(3)}).`);
  console.log('  This COULD indicate judge bias toward GPT models, OR that GPT models');
  console.log('  genuinely produce more valid suggestions. Check the reasoning above.');
} else if (valDiff > 0) {
  console.log(`  VALIDITY: GPT models score slightly higher (delta: +${valDiff.toFixed(4)}) but the`);
  console.log('  difference is NOT statistically significant. No clear bias signal.');
} else if (valDiff < 0 && valTTest.significant) {
  console.log('  VALIDITY: Non-GPT models actually score HIGHER than GPT models.');
  console.log('  No evidence of pro-GPT bias.');
} else {
  console.log(`  VALIDITY: Non-GPT models score slightly higher (delta: ${valDiff.toFixed(4)}).`);
  console.log('  No evidence of pro-GPT bias.');
}

console.log('');

if (Math.abs(covDiff) < 0.05 && !covTTest.significant) {
  console.log('  COVERAGE: No significant bias detected in coverage scoring.');
} else if (covDiff > 0 && covTTest.significant) {
  console.log(`  COVERAGE: GPT models achieve higher coverage (delta: +${covDiff.toFixed(4)}).`);
  console.log('  Coverage is more objective (did the model find the bugs?), so this');
  console.log('  likely reflects genuine performance differences, not bias.');
} else {
  console.log(`  COVERAGE: Delta = ${covDiff > 0 ? '+' : ''}${covDiff.toFixed(4)}, not statistically significant.`);
}

console.log('\n' + SEP + '\n');
