const data = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, "results", "output.json"), "utf-8"));
const results = data.results.results;
results.forEach((r, i) => {
    const components = r.gradingResult?.componentResults || [];
    const judge = components.find(c => c.reason && c.reason.includes("JUDGE_METRICS"));
    if (judge) {
        console.log("=== TEST " + (i + 1) + " ===");
        console.log(judge.reason);
        console.log("");
    }
});
