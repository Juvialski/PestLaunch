# Current Handoff — PestLaunch Call Intelligence

Last updated: 2026-09-25

This file is the authoritative short-term handoff for the interview prototype. Read it together with `AGENTS.md` and `docs/PROTOTYPE_PLAN.md`. Live repository and deployment state override older chat context.

## 1. Goal

Build a small, reliable PestLaunch interview demo showing this progression:

```
call recording
-> transcription
-> structured call intelligence
-> business signal detection
-> proposed action
-> human approval
-> demo customer/pipeline mutation
-> audit trail
```

The prototype intentionally focuses on the weak call-classification area described in Landon's Loom and demonstrates the architecture for later PestLaunch agents such as sales follow-up, retention, collections, upsells, and reactivation.

Do not attempt to rebuild the full PestLaunch product.

## 2. Current repository state

Repository:

`Juvialski/PestLaunch`

Main before the P2 implementation branch:

`927e39d883462e7348f2351c72ee3ecc71236576`

P1 is merged. P2 is implemented on `codex/p2-gemini-call-intelligence` and is delivered as one PR.

P1 was merged as:

`P1: Bootstrap app and audio ingestion foundation`

P1 provides:

- React + TypeScript + Vite frontend
- Node/Express backend
- one-process Render-compatible deployment
- validated MP3/WAV/M4A/WebM upload
- 25 MiB application upload limit
- private Supabase Storage design
- `POST /api/calls/ingest`
- `GET /api/calls`
- `GET /api/calls/:id`
- recent-call inbox UI
- Supabase persistence
- storage cleanup if call-row persistence fails
- focused ingestion tests

At the time P1 was merged, Gemini processing was intentionally deferred.

P2 adds explicit synchronous processing, persisted transcript and analysis detail, signed private-audio playback, and the call-detail workspace. No P2 schema migration was added or applied.

## 3. Live deployment

Production/demo URL:

https://pestlaunch.onrender.com

Render is a **Web Service**, not a Static Site.

Current architecture:

```
Browser
  -> Render Node/Express app
      -> Gemini API
      -> Supabase Postgres + private Storage
```

Do not create another Render service.

### Render build correction

The repository's original Render build command was:

`npm ci && npm run build`

That failed on Render with missing `vite/client` and `node` type definitions because production installation omitted devDependencies.

The live service was successfully deployed using:

`npm ci --include=dev && npm run build`

Start command:

`npm start`

`render.yaml` now matches the working live build command.

Do not hard-code `PORT`; Render supplies it.

## 4. Live Supabase

Project:

- name: `PestLaunch`
- ref: `vbgfzgpogqnursqisnti`
- URL: `https://vbgfzgpogqnursqisnti.supabase.co`
- region: `ap-south-1`
- status: ACTIVE_HEALTHY

Live public tables:

- `demo_customers`
- `calls`
- `transcripts`
- `call_analysis`
- `agent_actions`

RLS is enabled on all five tables. The prototype intentionally does not expose anonymous browser database access; the Node backend performs privileged operations.

Private Storage bucket:

`call-recordings`

Bucket configuration:

- private
- 25 MiB maximum
- allowed MIME types:
  - `audio/mpeg`
  - `audio/wav`
  - `audio/mp4`
  - `audio/webm`

## 5. Hosted migration state — important

The P1 foundation was applied directly to the hosted Supabase project through the Supabase connector.

Hosted migration history currently includes:

- `20260925022648 foundation`
- `20260925022651 create_call_recordings_bucket`

The repository already contains a foundation migration with a different timestamp:

`supabase/migrations/20260925013847_foundation.sql`

Therefore **do not casually run `supabase db push` against the live PestLaunch project**. The live schema already exists and migration history needs deliberate reconciliation before normal migration-promotion workflows are used.

Do not recreate the P1 schema during P2.

Only introduce a new migration if the next phase genuinely needs a schema change.

## 6. Environment state

The required local environment variables are already configured.

Render also has the required runtime variables.

Required variables:

```
SUPABASE_URL
SUPABASE_SECRET_KEY
SUPABASE_STORAGE_BUCKET=call-recordings
GEMINI_API_KEY
```

`GEMINI_API_KEY` is server-only. Do not expose it through a `VITE_` variable or browser code. `.env.example` and `render.yaml` document it as a server environment variable.

`SUPABASE_SECRET_KEY` is the preferred privileged server credential.

The current architecture does **not** require:

```
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

The backend may retain legacy service-role fallback support, but do not require duplicate credentials when `SUPABASE_SECRET_KEY` is configured.

Never expose privileged Supabase or Gemini keys to Vite/browser code.

## 7. Gemini routing decision

We have limited request quotas on the stronger models, so real API calls must be controlled.

### Transcription

Preference:

1. `gemini-3.5-transcribe`
2. `gemini-3.8-flash` multimodal audio fallback

If the exact API model identifier differs from the dashboard/human-facing name, use the actual callable identifier and centralize it in one provider/config layer.

Speaker labels and timestamps are desirable but not required for a valid transcript.

### Reasoning / classification

Use this order:

1. `gemini-3.8-flash`
2. `gemini-3.7-flash`
3. `gemini-3.6-flash`
4. `gemini-3.5-flash`

Gemini 3.5 Flash Lite is **not** part of the reasoning fallback chain. Routing and model identifiers are centralized in `server/geminiService.ts`.

Use bounded fallbacks for appropriate failures such as quota/rate limit, timeout, model unavailable, temporary provider errors, or invalid structured output.

Never retry indefinitely.

## 8. Critical quota rule

P2 does **not** automatically process calls immediately after upload.

Use an explicit:

`Process call`

action.

Gemini must not run merely because:

- the page refreshed
- a detail screen opened
- the UI polled
- an automated test ran
- the user navigated between views

A successfully analyzed call must not automatically consume Gemini quota again.

Automated tests must mock Gemini.

## 9. P2 implementation: Gemini Transcription + Call Intelligence

P2 implements only:

```
uploaded recording
-> user presses Process call
-> download private audio
-> transcription
-> persist transcript
-> structured classification/analysis
-> persist analysis
-> display call detail intelligence
```

### Implemented endpoints and processing rules

`POST /api/calls/:id/process`

Processing runs synchronously only for this explicit POST:

1. validate/load call
2. avoid accidental duplicate processing
3. status -> `PROCESSING`
4. download private recording
5. transcribe through centralized model router
6. upsert transcript
7. status -> `TRANSCRIBED`
8. analyze transcript
9. validate structured result
10. upsert `call_analysis`
11. status -> `ANALYZED`
12. clear `last_error`

`GET /api/calls/:id` returns the call with its persisted transcript and analysis. `GET /api/calls/:id/audio` redirects to a five-minute signed URL for the private Storage object. The bucket remains private.

A valid analysis already persisted for an `ANALYZED` call is returned without model calls. A valid persisted transcript is reused for retries, so a transcript checkpoint does not consume transcription quota again. Conditional status updates prevent duplicate concurrent processing. Gemini SDK retries are disabled; each configured model is attempted at most once per operation. Model attempt results and normalized failure categories are logged. Transcript `model_used` and `attempt_count`, analysis `model_used`, and `calls.last_error` preserve the available metadata.

P2 required no migration and no hosted Supabase migration command was run.

Known limitation: if the Render process stops during a synchronous run, the call can remain `PROCESSING`. P2 deliberately has no stale-lock expiry or reset endpoint because safely recovering long calls would need a persisted lease policy. An operator must repair that existing call row before retrying.

Exhausted recoverable AI fallbacks:

`NEEDS_REVIEW`

Use `FAILED` for appropriate unrecoverable internal failures.

Synchronous processing is acceptable for the interview prototype. Do not add queues/workers yet.

### Planned call taxonomy

- `NEW_LEAD`
- `BOOKING`
- `SERVICE`
- `COMPLAINT`
- `CANCELLATION`
- `COLLECTIONS`
- `UPSELL`
- `REACTIVATION`
- `INTERNAL`
- `OTHER`

Primary classification should be separate from secondary signals such as:

- new lead
- complaint
- cancellation risk
- upsell opportunity
- reactivation opportunity
- collections issue
- follow-up required

Analysis should also include:

- confidence
- summary
- customer intent
- sentiment
- outcome
- priority
- short transcript-grounded evidence
- proposed/recommended action

Validate model output at runtime before persistence/use, preferably with Zod.

The recommended action in P2 is a **proposal only**.

## 10. P2 call-detail workspace

Do not broadly redesign the current app.

Recent calls are selectable and open a focused detail view.

Left side:

- caller/file details
- private-audio playback
- transcript
- speaker labels/timestamps when available

Right side:

- call type
- confidence
- priority
- summary
- customer intent
- sentiment
- signals
- transcript evidence
- **Proposed action**

For an unprocessed call, the view exposes one obvious `Process call` button. Retry is available for `FAILED` and `NEEDS_REVIEW`; duplicate processing is disabled while `PROCESSING`. An `ANALYZED` call has no action that silently spends Gemini quota again.

Handle these states clearly:

- `UPLOADED`
- `PROCESSING`
- `TRANSCRIBED`
- `ANALYZED`
- `NEEDS_REVIEW`
- `FAILED`

Do not add approval/execution controls in P2.

## 11. Pest-control classifier context

Keep the classifier specifically useful for PestLaunch. It should understand concepts such as:

- pest-control lead/pricing inquiry
- termite treatment
- mosquito service
- rodent service
- recurring service
- booking/rescheduling
- technician complaint
- late technician
- cancellation/retention risk
- collections/payment issue
- upsell
- reactivation
- follow-up requirement

Do not build RAG or a large knowledge system for this phase.

## 12. Explicitly deferred to P3

P3 will add:

```
analysis
-> deterministic policy engine
-> proposed action
-> Approve / Reject
-> demo customer/pipeline/task mutation
-> audit history
```

Do not implement these in P2:

- policy engine
- approval/rejection
- customer-health mutation
- pipeline mutation
- retention-task execution
- outbound customer communication

Also remain out of scope for the interview prototype unless explicitly requested:

- Twilio/Dialpad/RingCentral integration
- live transcription
- SMS/email automation
- auth
- n8n
- LangChain
- CrewAI
- vector database
- full CRM
- large dashboard

## 13. Demo scenarios

Prepare synthetic/non-customer recordings only.

Primary interview scenario:

Existing customer complains that technicians have repeatedly been late and says they are considering cancellation.

Expected result:

- primary classification: `COMPLAINT` or `CANCELLATION`, depending on wording
- `cancellationRisk = true`
- high priority
- retention follow-up proposed
- short evidence directly from transcript

Secondary scenarios:

1. Prospect asks about termite treatment/pricing but does not book -> new lead/follow-up.
2. Existing customer asks about mosquito treatment -> upsell opportunity.

## 14. Efficiency rules

This project is under a tight interview deadline.

For future Codex phases:

- inspect only relevant repository surfaces
- do not scan `node_modules`
- do not redo broad repository research
- do not deploy broad subagents for final review
- do not repeatedly rerun the entire validation suite
- mock Gemini in automated tests
- minimize live Gemini calls
- prefer one bounded PR per phase
- stop when the requested PR is opened
- prioritize a dependable interview path over speculative architecture

## 15. Next-chat instruction

A new ChatGPT chat should read, in order:

1. `AGENTS.md`
2. this file: `docs/CURRENT_HANDOFF.md`
3. `docs/PROTOTYPE_PLAN.md`
4. relevant current code/live PR state

Then continue with **P3 — deterministic proposal, human approval, demo execution, and audit trail**.

Do not repeat P2 or require the user to paste the full historical chat again. Keep P3 limited to deterministic policy, explicit approve/reject, simulated state changes, and audit history. Keep external messaging, authentication, phone providers, and CRM integrations deferred.
