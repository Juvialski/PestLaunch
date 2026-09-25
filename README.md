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

## P1: Foundation and audio ingestion

This phase implements manual audio upload, private storage, call-record persistence, and basic status display. Transcription and reasoning remain for the next phase.

### Local setup

Requirements: Node.js 22 or newer and an existing Supabase project.

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the Supabase project. Keep the secret key server-side; do not put it in a `VITE_` variable.
3. Sign in to the Supabase CLI, link the project, apply the migration, and create the configured private bucket:

   ```powershell
   npx.cmd supabase login
   npx.cmd supabase link --project-ref <project-ref>
   npx.cmd supabase db push
   npx.cmd supabase seed buckets --linked
   ```

   The migration creates the five prototype tables and their RLS protections. The bucket is `call-recordings`, private, limited to 25 MiB, and restricted to the supported audio MIME types.
4. Run `npm.cmd run dev` and open the Vite URL printed in the terminal.

The API requires Supabase configuration at startup and exits with a clear message if it is missing. The interview prototype has no authentication, so use synthetic recordings only. The browser communicates with the app API and never receives a Supabase secret key.

Current API:

- `POST /api/calls/ingest` — upload one MP3, WAV, M4A, or WebM recording (maximum 25 MiB).
- `GET /api/calls` — list the 50 most recent calls.
- `GET /api/calls/:id` — retrieve one call record.

Audio is uploaded before its `calls` row is inserted. If row creation fails, the API attempts to remove the stored object and returns an error instead of claiming success.

Available scripts:

- `npm.cmd run dev` — run the API and Vite development server.
- `npm.cmd test` — run focused audio-ingestion API tests.
- `npm.cmd run typecheck` — check client, server, and test TypeScript.
- `npm.cmd run lint` — run ESLint.
- `npm.cmd run build` — typecheck and create the production client and server build.
- `npm.cmd start` — serve the production build on `PORT` (default `3000`).

`render.yaml` defines a single Render Node web service. Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the service environment before deploying.

## Planning

See [docs/PROTOTYPE_PLAN.md](docs/PROTOTYPE_PLAN.md).

## Time constraint

The first deployed demo is being built under an approximately 18-hour implementation window. Reliability of the main demo path has priority over additional features.
