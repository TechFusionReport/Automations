# Intake gate evaluation - Phase 1

Standalone, read-only evaluation of short titles and summaries for TechFusion Report's Technology, Entertainment, and Productivity coverage. Uses Node 18+ built-in fetch, no dependencies, and only your existing local Ollama service with `qwen3:4b-instruct` already available. It does not download models or change service settings.

## Run

Get the existing local Ollama base URL from the owner/operator or your existing local configuration. Set `OLLAMA_URL` in the current shell; substitute the placeholder privately. Never commit its real value or private input data.

PowerShell:

```powershell
$env:OLLAMA_URL = '<LOCAL_OLLAMA_BASE_URL>'
node scripts/intake-gate-eval/intake-gate-eval.js scripts/intake-gate-eval/sample-labeled.csv
```

POSIX shell:

```sh
export OLLAMA_URL='<LOCAL_OLLAMA_BASE_URL>'
node scripts/intake-gate-eval/intake-gate-eval.js /path/to/private-labeled.csv
```

Use an HTTP(S) origin with no credentials, path, query, or fragment. Only configure a trusted local Ollama service; the harness sends the input text to that configured service. No paid or cloud model API is used.

`sample-labeled.csv` contains **10 entirely synthetic examples**, five yes and five no. Every title is explicitly marked SYNTHETIC SAMPLE. Replace these with your own 30-50 privately held labeled examples for a meaningful evaluation. Required header: `title,summary,label`. Labels must be exactly `yes` or `no`; title and summary must be nonempty. Quoted commas, doubled quotation marks, embedded newlines, CRLF, and a UTF-8 BOM are supported. Labels never enter the model prompt.

## Read the output

One separate warm-up request runs first. Its elapsed time is labeled warm-up / cold-start time, excluded from scored rows and latency percentiles. It only measures a cold start if the model was actually unloaded; the harness never forces an unload or changes keep-alive settings.

Each scored CSV row prints elapsed request latency in milliseconds, including response decoding and validation. Requests are sequential. Accuracy is correct predictions divided by all labeled rows. The confusion matrix has actual labels as rows and predictions as columns: actual yes/predicted yes is a true positive; actual no/predicted yes is a false positive; actual yes/predicted no is a false negative. Error lists show titles only. p50 and p95 use nearest-rank percentiles of scored request latencies.

Temperature zero reduces sampling variation; it does not guarantee identical results across model or runtime versions. The fixed instruction prefix comes before JSON-encoded item data to permit prefix caching. Output is schema-constrained and validated again by the harness. Missing configuration, invalid CSV, unreachable service, timeout (180 seconds per request), HTTP errors, or invalid model output cause a nonzero exit. A failed run does not report aggregate accuracy or silently skip rows. Endpoint values and service response bodies are not printed.

The owner chooses the pass bar after reviewing results, including the false positives and false negatives. Synthetic-sample accuracy is not evidence of production readiness. This script does not enforce an accuracy threshold.

No n8n integration, Notion access, live workflow changes, Docker changes, Ollama reconfiguration, keep-alive changes, port opening, or deployment is included.
