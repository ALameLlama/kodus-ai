const skipLint =
    process.env.SKIP_LINT === '1' ||
    process.env.SKIP_LINT === 'true' ||
    process.env.SKIP_LINT === 'yes';

if (skipLint) {
    console.log('Skipping lint (SKIP_LINT=1).');
    process.exit(0);
}

require('./run-eslint.cjs');
