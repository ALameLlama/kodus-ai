#!/usr/bin/env npx ts-node

/**
 * Export LangSmith dataset to Promptfoo format
 */

import * as dotenv from 'dotenv';
import { Client } from 'langsmith';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const DATASET_ID = 'eb7a4983-a789-4cf7-8901-bc039c3a9372';
const OUTPUT_FILE = path.join(__dirname, 'datasets', 'typescript-codereview.json');

async function exportDataset() {
    const client = new Client();

    console.log('Fetching examples from LangSmith...');

    const examples: any[] = [];

    for await (const example of client.listExamples({ datasetId: DATASET_ID })) {
        examples.push({
            vars: example.inputs,
            assert: example.outputs ? [
                {
                    type: 'javascript',
                    value: `JSON.stringify(output).includes('codeSuggestions')`,
                },
            ] : undefined,
            metadata: {
                langsmithId: example.id,
                expectedOutput: example.outputs,
            },
        });
    }

    console.log(`Found ${examples.length} examples`);

    // Write to file
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(examples, null, 2));
    console.log(`Exported to ${OUTPUT_FILE}`);
}

exportDataset().catch(console.error);
