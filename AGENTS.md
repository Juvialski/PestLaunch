# AGENTS.md

## Mission

Build the PestLaunch Call Intelligence interview prototype described in `docs/PROTOTYPE_PLAN.md`. Read `docs/CURRENT_HANDOFF.md` for the latest live repository, Supabase, Render, and next-phase state before implementation.

## Current priority

Deliver the narrow end-to-end workflow first:

```
audio upload
-> transcription
-> structured analysis
-> deterministic action proposal
-> human approval
-> demo state change
-> audit trail
```

The prototype is time-boxed. Do not expand scope without explicit instruction.

## Model routing

### Transcription
1. Gemini 3.5 Transcribe
2. Gemini 3.8 Flash multimodal fallback
3. compatible Flash multimodal fallback only if needed

### Reasoning
1. Gemini 3.5 Flash-Lite with `thinking_level: high`
2. Gemini 3.5 Flash fallback with `thinking_level: high`

Prefer the Flash-Lite route for the interview demo to reduce latency and avoid exhausting the higher-tier Flash rate limits before a result is produced.

Do not hard-code model logic throughout the codebase. Centralize provider/model routing.

## Engineering rules

- Read `docs/CURRENT_HANDOFF.md` and `docs/PROTOTYPE_PLAN.md` before implementation.
- Keep secrets server-side.
- Validate AI structured output before using it.
- AI analysis may propose actions; deterministic application code controls execution.
- Customer-facing or material business actions require human approval in the prototype.
- Use bounded retries and model fallbacks. Never retry indefinitely.
- After fallbacks are exhausted, surface `NEEDS_REVIEW`.
- Preserve model-used and attempt/error metadata.
- Prefer simple code over agent-framework complexity.
- Do not add LangChain, CrewAI, n8n, a vector database, or phone-provider integration unless explicitly requested.
- Use synthetic call recordings for demo/test data.
- Keep the UI simple and fast to understand.
- Do not build a full CRM.

## Validation

Use proportional validation focused on the changed surface. Once the main path is working, prioritize end-to-end reliability over broad speculative testing. Do not scan `node_modules`, deploy broad final-review subagents, or repeatedly rerun the full validation suite unless a relevant change requires it.

For provider/API transport fixes, after mocked tests are stable, prefer one bounded real smoke test locally when the required local credentials and dependencies are already available. Do not burn quota with repeated experiments.

Do not make a temporary PR deployment a default merge prerequisite. When a bounded fix has strong local validation and the normal deployment tracks `main`, it is acceptable to merge with exact-head protection, verify the existing deployment immediately afterward, and hotfix if the real environment exposes a problem.
