/**
 * Line accuracy assertion - deterministic IoU comparison.
 * Uses the production parser to extract suggestions, then compares
 * line ranges with reference bugs using Intersection over Union.
 */
const { processResponse } = require('./parse-output');

module.exports = (output, context) => {
    const refBugs = JSON.parse(context.vars.referenceBugs || '[]');
    if (refBugs.length === 0) {
        return { pass: true, score: 1, reason: 'LINE_METRICS: line_acc=1.000 avg_iou=1.000 exact_match=1.000 within3=1.000 matched=0/0' };
    }

    // Parse model output using production parser
    const result = processResponse(output);
    if (!result || !result.codeSuggestions) {
        return { pass: false, score: 0, reason: 'LINE_METRICS: line_acc=0.000 avg_iou=0.000 exact_match=0.000 within3=0.000 matched=0/' + refBugs.length + ' (parse error)' };
    }
    const suggestions = result.codeSuggestions;

    // IoU for two line ranges
    function lineIoU(ref, pred) {
        const intStart = Math.max(ref.start, pred.start);
        const intEnd = Math.min(ref.end, pred.end);
        const intersection = Math.max(0, intEnd - intStart + 1);
        const unionStart = Math.min(ref.start, pred.start);
        const unionEnd = Math.max(ref.end, pred.end);
        const union = unionEnd - unionStart + 1;
        return union > 0 ? intersection / union : 0;
    }

    function normalizeFile(f) {
        return (f || '').replace(/^\.\//, '');
    }

    // Greedy 1:1 matching: each ref bug matches best suggestion (same file + highest IoU)
    const usedSuggestions = new Set();
    const ious = [];
    const matchedSuggestions = []; // track which suggestion matched each ref

    for (const ref of refBugs) {
        let bestIoU = 0;
        let bestIdx = -1;

        for (let i = 0; i < suggestions.length; i++) {
            if (usedSuggestions.has(i)) continue;
            const s = suggestions[i];

            if (normalizeFile(ref.relevantFile) !== normalizeFile(s.relevantFile)) continue;

            const iou = lineIoU(
                { start: ref.relevantLinesStart, end: ref.relevantLinesEnd },
                { start: s.relevantLinesStart || 0, end: s.relevantLinesEnd || 0 }
            );

            if (iou > bestIoU) {
                bestIoU = iou;
                bestIdx = i;
            }
        }

        if (bestIdx >= 0) {
            usedSuggestions.add(bestIdx);
            matchedSuggestions.push(suggestions[bestIdx]);
        } else {
            matchedSuggestions.push(null);
        }
        ious.push(bestIoU);
    }

    // Compute metrics
    const matchedIoUs = ious.filter(v => v > 0);
    const lineAcc = ious.reduce((a, b) => a + b, 0) / ious.length;
    const avgIoU = matchedIoUs.length > 0 ? matchedIoUs.reduce((a, b) => a + b, 0) / matchedIoUs.length : 0;

    let exactMatch = 0;
    let within3 = 0;

    for (let i = 0; i < refBugs.length; i++) {
        const matched = matchedSuggestions[i];
        if (!matched) continue;
        const ref = refBugs[i];

        if (matched.relevantLinesStart === ref.relevantLinesStart && matched.relevantLinesEnd === ref.relevantLinesEnd) {
            exactMatch++;
        }

        const startDiff = Math.abs((matched.relevantLinesStart || 0) - ref.relevantLinesStart);
        const endDiff = Math.abs((matched.relevantLinesEnd || 0) - ref.relevantLinesEnd);
        if (startDiff <= 3 && endDiff <= 3) {
            within3++;
        }
    }

    const exactMatchRate = exactMatch / refBugs.length;
    const within3Rate = within3 / refBugs.length;
    const matchedCount = matchedIoUs.length;

    const reason = 'LINE_METRICS: line_acc=' + lineAcc.toFixed(3) + ' avg_iou=' + avgIoU.toFixed(3) + ' exact_match=' + exactMatchRate.toFixed(3) + ' within3=' + within3Rate.toFixed(3) + ' matched=' + matchedCount + '/' + refBugs.length;

    return { pass: lineAcc >= 0.3, score: lineAcc, reason: reason };
};
