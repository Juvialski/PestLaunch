# PestLaunch Call Intelligence Prototype

Interview-focused proof of concept for a semi-autonomous call intelligence workflow inspired by the current PestLaunch sales workflow.

Live demo: https://pestlaunch.onrender.com

Current implementation handoff: [docs/CURRENT_HANDOFF.md](docs/CURRENT_HANDOFF.md)

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

Fallbacks are for quota exhaustion, transient provider errors, timeouts, or invalid structured output. The workflow must not retry indefinitely.

## Stack

- React + TypeScript + Vite
- Node.js + TypeScript API
- Supabase Postgres + Storage
- Gemini API
- Render deployment

## P1: Foundation and audio ingestion

P1 implemented manual audio upload, private storage, call-record persistence, and basic status display.

## P2: Gemini transcription and call intelligence

P2 adds a focused call-detail workspace and this explicit processing path:

```text
select uploaded call -> Process call -> transcript -> validated analysis -> persisted intelligence
```

Opening, selecting, refreshing, or loading a call never invokes Gemini. Only `POST /api/calls/:id/process` starts processing. A valid analyzed call returns its saved result; retries reuse a valid saved transcript. Gemini fallbacks are bounded and logged. Exhausted recoverable AI failures become `NEEDS_REVIEW`; storage and application failures become `FAILED`. Proposed actions are display-only in P2.

## P3: Deterministic actions and human approval

P3 consumes saved, validated P2 analysis. Application policy chooses at most one action per call in this order: retention risk, collections, new lead follow-up, reactivation, then upsell. The model's `recommendedAction.type` is displayed only as context and is never executed.

Every action requires human approval. Approval conditionally claims deterministic execution; rejection records the decision without changing a customer. Retention approval can mark the fixed synthetic retention customer `AT_RISK`; termite-lead approval can move the fixed lead to `QUALIFIED`; the completed action row itself represents upsell, collections, and reactivation tasks.

Proposal IDs are deterministic per call and reuse the existing `agent_actions` primary key. Repeated/concurrent proposals return the same action; conditional state transitions prevent duplicate execution. Failed approved execution retains its error and approval, and can be retried up to three times. Fixed synthetic fixtures are initialized/reset by an explicit action that never deletes calls or action history. P3 makes no Gemini calls and requires no database migration.

### Local setup

Requirements: Node.js 22 or newer and an existing Supabase project.

1. Install dependencies with `npm ci`.
2. Copy `.env.example` to `.env` and set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `GEMINI_API_KEY`. Keep both privileged Supabase and Gemini keys server-side; never put either in a `VITE_` variable.
3. The live PestLaunch Supabase project is already initialized with the five prototype tables and the private `call-recordings` bucket. **Do not run `supabase db push` against the live project without first reading `docs/CURRENT_HANDOFF.md`**, because hosted migration history was created directly and does not currently match the repository migration filename.
4. Run `npm.cmd run dev` and open the Vite URL printed in the terminal.

The API requires Supabase configuration at startup and exits with a clear message if it is missing. The interview prototype has no authentication, so use synthetic recordings only. The browser communicates with the app API and never receives a Supabase secret key.

Current API:

- `POST /api/calls/ingest` — upload one MP3, WAV, M4A, or WebM recording (maximum 25 MiB).
- `GET /api/calls` — list the 50 most recent calls.
- `GET /api/calls/:id` — retrieve a call with its persisted transcript and analysis.
- `GET /api/calls/:id/audio` — redirect to a short-lived signed URL for the private recording.
- `POST /api/calls/:id/process` — explicitly transcribe and analyze one call.
- `POST /api/calls/:id/actions/propose` — create or return the deterministic proposal from saved analysis without Gemini.
- `POST /api/actions/:id/approve` — approve and execute the allowlisted demo effect.
- `POST /api/actions/:id/reject` — reject a pending proposal without a business-state mutation.
- `GET /api/demo/customers` — list only the fixed synthetic demo personas.
- `POST /api/demo/reset` — initialize/reset those personas without deleting calls or action history.

Call detail now includes the linked demo customer and persisted action history. Its activity timeline is derived from saved call, transcript, analysis, decision, and execution records.

Audio is uploaded before its `calls` row is inserted. If row creation fails, the API attempts to remove the stored object and returns an error instead of claiming success.

Available scripts:

- `npm.cmd run dev` — run the API and Vite development server.
- `npm.cmd test` — run audio-ingestion, P2 processing, P3 policy/action API, and persisted-timeline tests (AI is injected in tests).
- `npm.cmd run typecheck` — check client, server, and test TypeScript.
- `npm.cmd run lint` — run ESLint.
- `npm.cmd run build` — typecheck and create the production client and server build.
- `npm.cmd start` — serve the production build on `PORT` (default `3000`).

`render.yaml` defines one Render Node web service. Its build command is `npm ci --include=dev && npm run build`, and its start command remains `npm start`. Runtime configuration uses `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`, and the server-only `GEMINI_API_KEY`.

The Gemini model routing lives in `server/geminiService.ts`. Transcription uses `gemini-3.5-transcribe` then `gemini-3.8-flash`; reasoning uses `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, and `gemini-3.5-flash`. Model attempts do not repeat automatically.

P2 and P3 required no migration. Do not run `supabase db push` against the hosted project. The next bounded phase is **P4: Demo hardening and interview readiness**; do not broaden the product automatically.

## Planning

See [docs/PROTOTYPE_PLAN.md](docs/PROTOTYPE_PLAN.md).

## Time constraint

The first deployed demo is being built under an approximately 18-hour implementation window. Reliability of the main demo path has priority over additional features.
