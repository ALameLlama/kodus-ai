if (!process.env.API_CRYPTO_KEY) {
    process.env.API_CRYPTO_KEY =
        '0000000000000000000000000000000000000000000000000000000000000000';
}

if (!process.env.API_LOG_LEVEL) {
    process.env.API_LOG_LEVEL = 'error';
}
