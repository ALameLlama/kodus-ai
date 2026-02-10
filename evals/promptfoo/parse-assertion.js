/**
 * Production parser assertion.
 * Uses the same parsing logic as LLMResponseProcessor.processResponse() to validate
 * that the model output is parseable in production.
 */
const { processResponse, validateSchema } = require('./parse-output');

module.exports = (output, context) => {
    const result = processResponse(output);

    if (!result) {
        return {
            pass: false,
            score: 0,
            reason: 'PARSE_FAIL: Production parser returned null (unparseable output)',
        };
    }

    if (!result.codeSuggestions || result.codeSuggestions.length === 0) {
        return {
            pass: false,
            score: 0,
            reason: 'PARSE_FAIL: No codeSuggestions in parsed output',
        };
    }

    const { valid, errors } = validateSchema(result.codeSuggestions);

    if (!valid) {
        return {
            pass: false,
            score: 0.5,
            reason: 'PARSE_PARTIAL: Schema validation errors: ' + errors.join('; '),
        };
    }

    return {
        pass: true,
        score: 1,
        reason: 'PARSE_OK: ' + result.codeSuggestions.length + ' suggestions parsed and validated',
    };
};
