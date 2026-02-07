#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Accept --lang argument: tsjs, python, java, ruby, all (default: all)
const langArg = process.argv.find(a => a.startsWith('--lang='));
const lang = langArg ? langArg.split('=')[1] : 'all';

const DATASETS = {
    tsjs: 'tsjs.jsonl',
    python: 'python.jsonl',
    java: 'java.jsonl',
    ruby: 'ruby.jsonl',
};

const files = lang === 'all'
    ? Object.values(DATASETS)
    : DATASETS[lang]
        ? [DATASETS[lang]]
        : (() => { console.error(`Unknown lang: ${lang}. Options: ${Object.keys(DATASETS).join(', ')}, all`); process.exit(1); })();

const outputFile = path.join(__dirname, 'datasets', 'codereview-tests.json');

const lines = files.flatMap(file => {
    const filePath = path.join(__dirname, 'datasets', file);
    if (!fs.existsSync(filePath)) {
        console.warn(`Warning: ${file} not found, skipping`);
        return [];
    }
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
});

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

    const codeSuggestions = outputs.codeSuggestions || [];

    // Extract PR summary from pullRequest.body (same as LangSmith eval)
    const prSummary = inputs.pullRequest?.body || '';

    // Extract reference bugs with line info for the line accuracy assertion
    const referenceBugs = codeSuggestions.map(s => ({
        relevantFile: s.relevantFile,
        relevantLinesStart: s.relevantLinesStart,
        relevantLinesEnd: s.relevantLinesEnd,
    }));

    return {
        description: `Example ${index + 1}: ${inputs.filePath || 'unknown'}`,
        vars: {
            // Variables matching the exact Kodus prompt user template
            fileContent: escapeTemplatePatterns(inputs.fileContent || ''),
            patchWithLinesStr: escapeTemplatePatterns(inputs.patchWithLinesStr || ''),
            prSummary: escapeTemplatePatterns(prSummary),
            // Reference data for assertions (not used in prompt template)
            referenceBugs: JSON.stringify(referenceBugs),
            referenceCodeSuggestions: JSON.stringify(codeSuggestions, null, 2),
        },
        assert: [
            // Production parser check - uses same logic as LLMResponseProcessor.processResponse()
            {
                type: 'javascript',
                value: 'file://parse-assertion.js',
            },
            // Dual LLM judge (Sonnet + GPT) - calls APIs directly, bypasses llm-rubric
            {
                type: 'javascript',
                value: 'file://judge-assertion.js',
            },
            // Line accuracy assertion - deterministic IoU comparison
            {
                type: 'javascript',
                value: 'file://line-accuracy-assertion.js',
            }
        ]
    };
});

fs.writeFileSync(outputFile, JSON.stringify(tests, null, 2));
console.log(`Converted ${tests.length} examples to ${outputFile}`);
