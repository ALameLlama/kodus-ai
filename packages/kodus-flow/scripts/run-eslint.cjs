const { spawnSync } = require('child_process');
const path = require('path');

const node = process.execPath;
const eslintPkg = require.resolve('eslint/package.json');
const eslintBin = path.join(path.dirname(eslintPkg), 'bin', 'eslint.js');
const args = [
    '--max-old-space-size=4096',
    eslintBin,
    'src/**/*.{ts,tsx}',
    'tests/**/*.{ts,tsx}',
    ...process.argv.slice(2),
];

const result = spawnSync(node, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
