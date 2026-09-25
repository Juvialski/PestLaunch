# AGENTS.md

## Mission

Build the PestLaunch Call Intelligence interview prototype described in `docs/PROTOTYPE_PLAN.md`.

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
1. Gemini 3.8 Flash
2. Gemini 3.7 Flash
3. Gemini 3.6 Flash
4. Gemini 3.5 Flash
5. Gemini 3.5 Flash Lite only as an optional final low-cost/schema-repair path

Do not hard-code model logic throughout the codebase. Centralize provider/model routing.

## Engineering rules

- Read `docs/PROTOTYPE_PLAN.md` before implementation.
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

Use proportional validation focused on the changed surface. Once the main path is working, prioritize end-to-end reliability over broad speculative testing.
