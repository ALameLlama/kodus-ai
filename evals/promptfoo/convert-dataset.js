#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const inputFile = path.join(__dirname, 'datasets', 'dataset_eb7a4983-a789-4cf7-8901-bc039c3a9372.jsonl');
const outputFile = path.join(__dirname, 'datasets', 'codereview-tests.json');

const lines = fs.readFileSync(inputFile, 'utf-8').split('\n').filter(Boolean);

// Escape template patterns to avoid nunjucks interpretation
// Using {% raw %}...{% endraw %} or just escaping the braces
function escapeTemplatePatterns(str) {
    if (!str) return str;
    return str
        .replace(/\{\{/g, '{ {')
        .replace(/\}\}/g, '} }')
        .replace(/\{%/g, '{ %')
        .replace(/%\}/g, '% }');
}

const tests = lines.map((line, index) => {
    const data = JSON.parse(line);
    const inputs = data.inputs?.inputs || data.inputs || {};
    const outputs = data.outputs?.reference_outputs || data.outputs || {};

    // Build expected output as JSON (what we expect the model to produce)
    const expectedOutput = {
        codeSuggestions: outputs.codeSuggestions || []
    };

    // Escape the expected output to avoid template conflicts
    const expectedJson = escapeTemplatePatterns(JSON.stringify(expectedOutput.codeSuggestions, null, 2));

    // Extract PR summary from pullRequest.body (same as LangSmith eval)
    const prSummary = inputs.pullRequest?.body || '';

    return {
        description: `Example ${index + 1}: ${inputs.filePath || 'unknown'}`,
        vars: {
            // Variables matching the exact Kodus prompt user template
            fileContent: escapeTemplatePatterns(inputs.fileContent || ''),
            patchWithLinesStr: escapeTemplatePatterns(inputs.patchWithLinesStr || ''),
            prSummary: escapeTemplatePatterns(prSummary),
        },
        // Expected output for LLM judge comparison
        assert: [
            // Flexible JSON check - extracts JSON from markdown if needed
            {
                type: 'javascript',
                value: `
                    let jsonStr = output;
                    // Try to extract JSON from markdown code blocks
                    const match = output.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/);
                    if (match) jsonStr = match[1].trim();

                    try {
                        const parsed = JSON.parse(jsonStr);
                        if (!parsed.codeSuggestions) {
                            return { pass: false, score: 0, reason: 'Missing codeSuggestions field' };
                        }
                        return { pass: true, score: 1, reason: 'Valid JSON with codeSuggestions' };
                    } catch (e) {
                        return { pass: false, score: 0, reason: 'Invalid JSON: ' + e.message };
                    }
                `,
            },
            {
                type: 'llm-rubric',
                // Pass if score >= 0.7 (same as LangSmith)
                threshold: 0.7,
                value: `You are an expert judge evaluating code review quality.

## Reference bugs (known issues in this code):
${expectedJson}

## Your task:
Evaluate the model's suggestions considering TWO factors:

### 1. Reference Bug Coverage (50% of score)
How many reference bugs did the model find?
- Found with same core issue (even if different lines/explanation) = FOUND
- Missed entirely = MISSED
- coverage_score = found_count / total_reference_bugs

### 2. Suggestion Validity (50% of score)
For EACH model suggestion, be STRICT - only count as VALID if:
- Has a CONCRETE scenario with specific inputs that trigger the bug
- Shows EXACT incorrect behavior (not vague "could cause issues")
- Is REPRODUCIBLE (not dependent on unlikely edge cases)
- Is a REAL bug (not style, not "missing validation", not "could be improved")

Count as INVALID if:
- Vague ("this could cause issues in some cases")
- Speculative ("if user does X, might fail")
- Style/preference ("should use X instead of Y")
- Defensive programming ("missing null check" without proving it can be null)
- Misunderstands the code logic

validity_score = valid_suggestions / total_suggestions (default 1.0 if no suggestions)

### Final Score
score = (coverage_score * 0.5) + (validity_score * 0.5)

IMPORTANT:
- A model that finds DIFFERENT but VALID bugs should NOT be heavily penalized
- Finding additional valid bugs beyond the reference is GOOD, not bad
- Only penalize for suggestions that are clearly wrong or not real bugs

Return the final score (0 to 1).`,
                provider: 'openai:gpt-5.1',
            }
        ]
    };
});

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} examples to ${outputFile}`);
