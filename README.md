# PestLaunch Call Intelligence Prototype

Interview-focused proof of concept for a semi-autonomous call intelligence workflow inspired by the current PestLaunch sales workflow.

## Prototype goal

Demonstrate one reliable end-to-end automation:

```
Call recording
  -> transcription
  -> structured call analysis
  -> business signal detection
  -> deterministic action proposal
  -> human approval
  -> simulated CRM/pipeline update
  -> audit trail
```

The prototype is intentionally narrow. It is designed to show how PestLaunch can turn phone-call data into useful operational actions without attempting to rebuild the full PestLaunch product.

## Primary use case

The first workflow targets call classification and follow-up automation because the existing PestLaunch sales area already contains call logs but call-type identification is an area that can be improved.

The prototype will detect situations such as:

- new leads
- booking/rescheduling
- service questions
- complaints
- cancellation/retention risk
- collections/payment issues
- upsell opportunities
- reactivation opportunities
- internal/vendor calls
- unclear/other calls

## AI model routing

### Transcription
1. Gemini 3.5 Transcribe
2. Gemini 3.8 Flash multimodal audio fallback
3. next compatible Flash multimodal fallback if required

### Reasoning / classification
1. Gemini 3.8 Flash
2. Gemini 3.7 Flash
3. Gemini 3.6 Flash
4. Gemini 3.5 Flash
5. Gemini 3.5 Flash Lite only as a last-resort low-cost/schema-repair path if useful

Fallbacks are for quota exhaustion, transient provider errors, timeouts, or invalid structured output. The workflow must not retry indefinitely.

## Stack

- React + TypeScript + Vite
- Node.js + TypeScript API
- Supabase Postgres + Storage
- Gemini API
- Render deployment

## Planning

See [docs/PROTOTYPE_PLAN.md](docs/PROTOTYPE_PLAN.md).

## Time constraint

The first deployed demo is being built under an approximately 18-hour implementation window. Reliability of the main demo path has priority over additional features.
