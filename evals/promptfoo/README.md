# Code Review Evaluation

Benchmark suite for evaluating LLM performance on code review tasks. Uses [promptfoo](https://promptfoo.dev) to run the same production prompt across multiple models and score results with a dual-judge system.

## Models

| Model | Provider |
|---|---|
| Gemini 2.5 Pro | Google |
| Gemini 3 Pro (preview) | Google |
| Gemini 3 Flash (preview) | Google |
| Claude Sonnet 4.5 | Anthropic |
| Claude Haiku 4.5 | Anthropic |
| GPT-5.2 | OpenAI |
| GPT-5 Mini | OpenAI |
| Kimi K2.5 | Moonshot (OpenRouter) |
| GLM 4.7 | Z-AI (OpenRouter) |

## Datasets

80 examples across 4 languages, each with known bugs and reference solutions:

| Dataset | File | Examples |
|---|---|---|
| TypeScript/JavaScript | `datasets/tsjs.jsonl` | 20 |
| Python | `datasets/python.jsonl` | 20 |
| Java | `datasets/java.jsonl` | 20 |
| Ruby | `datasets/ruby.jsonl` | 20 |

## Setup

API keys must be set in the root `.env` file:

```
API_OPEN_AI_API_KEY=sk-...
API_ANTHROPIC_API_KEY=sk-ant-...
API_GOOGLE_AI_API_KEY=AI...
API_OPENROUTER_KEY=sk-or-...
```

The `run-eval.sh` script maps these to promptfoo's expected env var names automatically.

## Running

### By language

```bash
yarn eval:codereview:tsjs      # TypeScript/JavaScript only (20 examples)
yarn eval:codereview:python    # Python only
yarn eval:codereview:java      # Java only
yarn eval:codereview:ruby      # Ruby only
yarn eval:codereview           # All languages (80 examples)
```

### Quick runs

```bash
yarn eval:codereview:light                  # 5 examples, all languages
yarn eval:codereview:light --lang=python    # 5 examples, Python only
```

### Benchmarks (multiple runs)

```bash
yarn eval:codereview:bench                  # 5 examples x 3 repeats, all languages
yarn eval:codereview:bench --lang=java      # 5 examples x 3 repeats, Java only
yarn eval:codereview:bench:full             # all examples x 3 repeats (heavy)
yarn eval:codereview:bench:full --lang=ruby # 20 examples x 3 repeats, Ruby only
```

### Analyze results

```bash
yarn eval:codereview:analyze
```

### Extra promptfoo flags

Any additional flags are forwarded to promptfoo:

```bash
yarn eval:codereview:tsjs --no-cache --filter-first-n 3
yarn eval:codereview:python --filter-providers "openai:gpt-5.2"
```

## Scoring

### Dual LLM Judge (Sonnet + GPT)

Each model's output is evaluated by **two independent judges** (Claude Sonnet 4.5 + GPT-5.2) to reduce single-model bias. The judges call the APIs directly via a custom JavaScript assertion (`judge-assertion.js`), bypassing promptfoo's built-in `llm-rubric`.

Each judge evaluates every suggestion with:
- **Concrete failing input** — a specific input that triggers the bug
- **Expected output** — what should happen
- **Actual output** — what actually happens

Suggestions that can't provide all three are marked **INVALID**.

### Metrics

| Metric | Description |
|---|---|
| **Score** | Average of both judges' final scores |
| **Coverage** | % of known reference bugs found by at least one valid suggestion |
| **Validity** | % of model's suggestions that are real, provable bugs |
| **Line Acc** | Average IoU of predicted vs reference line ranges (unfound = 0) |
| **Avg IoU** | Average IoU only for bugs the model actually found |
| **Exact** | % of predictions with exact line range match |
| **Within 3** | % of predictions within 3 lines of reference start/end |
| **Latency** | p50 and p95 response time |

### Score formula

```
judge_score = (coverage_score * 0.5) + (validity_score * 0.5)
final_score = avg(sonnet_judge_score, gpt_judge_score)
```

A missing/failed judge counts as score 0 to prevent inflation.

## Architecture

```
promptfoo.yaml          # Provider config (models, temperature, etc.)
prompt-loader.js        # Loads the production code review prompt
convert-dataset.js      # Converts .jsonl datasets to promptfoo test format
run-eval.sh             # Entry point: loads env vars, runs convert + eval
parse-output.js         # Production parser replica (same as LLMResponseProcessor)
parse-assertion.js      # Validates model output is parseable by production parser
judge-assertion.js      # Dual LLM judge (Sonnet + GPT) via direct API calls
line-accuracy-assertion.js  # Deterministic IoU line range comparison
analyze-results.js      # Aggregates results into a ranked leaderboard
```

### Data flow

```
.jsonl datasets
    → convert-dataset.js (--lang=X)
    → codereview-tests.json
    → promptfoo eval (9 models x N tests)
    → results/output.json
    → analyze-results.js
    → ranked leaderboard
```

## Example output

```
╔════════════════════════════════════════════════════════════════╗
║       CODE REVIEW EVALUATION RESULTS (Sonnet + GPT)         ║
╚════════════════════════════════════════════════════════════════╝

🥇 claude-sonnet-4-5
   ├─ Score:     79.2% (avg of 2 judges)
   ├─ Passed:    2/2 (threshold 0.7)
   ├─ Coverage:  88% (Sonnet: 100% | GPT: 75%)
   ├─ Validity:  71% (Sonnet: 83% | GPT: 58%)
   ├─ Line Acc:  5.8%
   ├─ Avg IoU:   10.5%
   ├─ Exact:     0.0%
   ├─ Within 3:  0.0%
   └─ Latency:   p50=34.2s  p95=38.8s

─────────────────────────────────────────────────────────────────
Score    = avg(Judge Sonnet score, Judge GPT score)
Coverage = % of known bugs that were found
Validity = % of suggestions that are real bugs
...
```
