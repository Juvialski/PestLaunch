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

Current live `main` after the P3 merge and handoff reconciliation:

`c656f2d7b3730aabc34dd23c51b5d5b983f22c8b`

P3 itself was merged as:

`819f71a0750fe123868be37e00d56c96b6508742`

P1, P2, and P3 are merged. P2 was delivered as PR #2, `P2: Gemini transcription and call intelligence`, with merged baseline `e0a8e5b7321c5226e23640e1f2487873febc00f2`.

P3 was delivered as PR #3, `P3: Deterministic actions and human approval`, from `codex/p3-deterministic-actions`. P3 head was `d927bbae93a24b3b51c4f6c1e8a6023a87379734`, and the merged P3 main is `819f71a0750fe123868be37e00d56c96b6508742`. It completes deterministic action proposals, human decisions, fixed synthetic demo mutations, and persisted call activity without a new database migration or Gemini calls in P3.

Open PRs at this handoff: none.

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

Do not recreate the P1 schema. P2 and P3 required no schema migrations.
No P3 migration was created or applied, and `supabase db push` was not run for P3.

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

## 12. P3 implementation: Deterministic actions and human approval

P3 starts from merged P2 main at `e0a8e5b7321c5226e23640e1f2487873febc00f2` and completes the interview flow:

```
persisted validated P2 analysis
-> deterministic allowlisted proposal
-> human Approve / Reject
-> bounded demo customer update or completed task record
-> call activity timeline from persisted state
```

P3 action types:

- `CREATE_RETENTION_FOLLOWUP`
- `CREATE_SALES_FOLLOWUP`
- `CREATE_UPSELL_TASK`
- `CREATE_COLLECTIONS_FOLLOWUP`
- `CREATE_REACTIVATION_FOLLOWUP`

The policy produces at most one primary action per call, in this precedence:

1. cancellation risk or `CANCELLATION` call type -> retention follow-up (`HIGH` priority)
2. collections issue or `COLLECTIONS` call type -> collections follow-up
3. new-lead signal or `NEW_LEAD` call type together with follow-up required -> sales follow-up
4. reactivation opportunity or `REACTIVATION` call type -> reactivation follow-up
5. upsell opportunity -> upsell task

P2 `recommendedAction.type` remains AI context only. It is never read as an executable command. Proposal titles, reasons, priorities, target effects, and action types are created by application code and validated against strict Zod schemas.

### P3 API and lifecycle

- `POST /api/calls/:id/actions/propose` validates the persisted analysis and grounded transcript, runs the policy, and persists a `PENDING` action with `requires_approval = true`. It makes no Gemini request.
- `POST /api/actions/:id/approve` conditionally advances `PENDING -> APPROVED -> EXECUTING -> COMPLETED`. Only the execution claim can apply the fixed demo mutation.
- `POST /api/actions/:id/reject` conditionally advances `PENDING -> REJECTED`, records a payload decision timestamp, and performs no customer mutation.
- `GET /api/demo/customers` returns only the fixed synthetic customer IDs.
- `POST /api/demo/reset` upserts only those fixed personas to their known starting values; it does not delete calls or action history and accepts no caller-supplied IDs or patches.
- `GET /api/calls/:id` now includes the linked customer and validated action history. It remains read-only.

The action ID is deterministic per call and uses the existing `agent_actions.id` primary key. Existing rows are returned on repeated or concurrent proposal requests, so a call has one logical primary action even if its analysis later changes. Approval/rejection and execution use conditional status updates. Failed approved execution keeps the approval and error metadata and can be retried safely up to three execution attempts. Rejected actions cannot execute; completed actions are idempotent.

### P3 demo effects

- Retention customer: starts `HEALTHY` / `WON`; approved retention follow-up sets health to `AT_RISK`.
- Termite lead: starts at pipeline `NEW`; approved sales follow-up may set it to `QUALIFIED`.
- Mosquito customer: starts `HEALTHY` / `WON`; the completed upsell action itself represents the created task, with no customer-field mutation.

The personas use fixed IDs and visibly synthetic names. Other linked records can receive a task action, but execution updates customer fields only for the fixed retention customer and termite lead. Timeline events are projected from saved call, transcript, analysis, action, and execution timestamps. Rejection records “No business state changed.”

P3 makes zero Gemini calls for proposals, decisions, execution, reset, and timeline. Focused route tests inject a fake AI boundary and observe zero transcription/analysis calls. P2’s explicit processing and quota protections remain unchanged.

P3 created no database migration and did not run `supabase db push`.

### P3 validation actually run

- `npm test` — 48 passed, 0 failed.
- `npm run lint` — passed.
- `npm run build` — passed, including client/server/test type checks, server compilation, and the Vite production build.
- No live Render deployment or hosted Supabase end-to-end verification was run in P3; that belongs to P4 interview readiness.

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

## 15. Next direction at the P3 handoff: P4 Demo hardening and interview readiness

A new ChatGPT chat should read, in order:

1. `AGENTS.md`
2. this file: `docs/CURRENT_HANDOFF.md`
3. `docs/PROTOTYPE_PLAN.md`
4. relevant current code/live PR state

P3 completes the core interview architecture. The next phase is **P4 — Demo hardening and interview readiness**, limited to:

- synthetic recordings and fixture reliability
- deployed end-to-end verification
- critical bugs and clear error states
- stale `PROCESSING` recovery only if it threatens the demo
- minor UX polish and demo reset reliability
- interview walkthrough and rehearsal

These were the next-phase instructions at the P3 handoff. P4 execution results are appended in §16. Do not repeat P1/P2/P3 or require the user to paste the historical chat again. Keep external messaging, authentication, phone providers, and CRM integrations deferred.

## 16. P4 — Demo Hardening and Interview Readiness

P4 branch: `codex/p4-demo-hardening`

Exact P4 baseline: `4101edce5901f16a2ee6185ef2e268462cb0e5d0`

### Deployed state verified

- The existing Render Web Service `PestLaunch` remains the only service; it serves `https://pestlaunch.onrender.com`, tracks `main`, and uses the existing build/start commands. No deployment configuration was changed and no deploy was triggered for P4.
- Render reports the live deploy at `4101edce5901f16a2ee6185ef2e268462cb0e5d0`, the requested P4 baseline. Hosted P3 reset and customer endpoints respond.
- The hosted reset API and UI both returned the three fixed synthetic customers at their expected starting values. The customer selector exposed Jordan, Taylor, and Morgan. After reset, the uploaded call remained in the inbox; reset preserved call history.

### Primary retention scenario result

- Three synthetic WAV fixtures were generated locally with Windows Speech; no real customer audio or cloud TTS was used.
- `demo/recordings/retention-risk.wav` was uploaded once through the hosted ingestion endpoint and linked to the fixed Jordan Example customer. The deployed UI customer selector was separately confirmed to select Jordan Example.
- One deployed **Process call** request was made. The call reached `NEEDS_REVIEW` after about 39 seconds. Render logs show the failure occurred during Gemini Files upload: HTTP 404 with an empty provider message, before any transcription or reasoning model ran.
- Hosted test call ID: `2171e75b-bc29-49f5-8ddc-c76b363462c7`.
- Persisted result: no transcript, analysis, or action; Jordan remains `HEALTHY` / `WON`. The call remains in the hosted inbox as `NEEDS_REVIEW`.
- Live Gemini usage so far: one Files upload attempt from one process request; zero transcription-model calls and zero reasoning-model calls. No retry or secondary live scenario has been run yet.
- Provider investigation isolated the failure to the Gemini Files transport: the upload endpoint returned HTTP 404 before either configured model was invoked. The installed `@google/genai` 2.24.0 API accepts Blob uploads, so the Blob input alone does not explain the failure; the empty provider response did not expose a deeper upstream cause.
- The P4 branch now bypasses that failing Files hop for the small interview fixtures and sends base64 inline audio directly to the Interactions API. The transcription and reasoning model routing, explicit Process-call boundary, transcript checkpoint, and idempotency rules remain unchanged.
- The primary retention WAV is about 1.39 MB and is safely within Gemini's documented small-inline-audio path. The app still accepts recordings up to 25 MiB, while Gemini documents a 20 MB total inline request limit; recordings near the app ceiling are therefore not covered by this P4 transport fix.
- No analyzed synthetic backup call exists yet. Therefore the deployed primary completion criteria and backup-call criterion remain unmet until the corrected branch is hosted and one synthetic retention run succeeds.

### Hardening changes and decisions

- Prevent duplicate display of the same immediate and persisted processing error.
- Show an accessible playback-failure message on audio player errors.
- Classify a 404 from the Gemini file-upload stage as a provider failure instead of a missing model, and give provider failures a useful retry instruction.
- Hide raw `GEMINI_API_KEY` configuration wording from user-facing processing errors; direct the presenter to an administrator.
- Stale `PROCESSING` recovery was not needed. The live call left `PROCESSING` and reached `NEEDS_REVIEW`; no stale row or interruption risk was observed.
- Screenshots from the deployed browser timed out twice, so desktop visual and mobile-width visual certification were not completed. Accessibility state confirmed the deployed upload, customer selection, reset, call, and Process controls.

### Demo material, validation, and remaining limitations

- Scenario scripts and expected classifications: `demo/scenarios.md`.
- Synthetic recordings: `demo/recordings/retention-risk.wav`, `demo/recordings/termite-lead.wav`, and `demo/recordings/mosquito-upsell.wav`.
- Interview walkthrough and backup instructions: `docs/INTERVIEW_DEMO_RUNBOOK.md`. The runbook explicitly flags that a saved analyzed backup is not currently available.
- Post-fix branch validation: `npm test` — 53 passed, 0 failed; `npm run lint` — passed; `npm run build` — passed. This was run once on Node 22 in a temporary branch-only GitHub Actions workflow after the inline-audio correction; the temporary workflow was then removed.
- No migrations were created or applied. `supabase db push` was not run.
- Remaining acceptance blocker: the corrected P4 branch has not been hosted yet. The existing Render service tracks `main`, auto-deploys main commits, and has pull-request previews disabled. It therefore still serves `4101edc` and cannot prove the corrected retention path before merge through the current service configuration.
- Do not merge P4 solely on unit/build validation. The required hosted retention run still needs to persist transcript + analysis, produce the deterministic retention proposal, complete approval/execution, leave Jordan `AT_RISK`, survive refresh without reprocessing, and provide the analyzed backup call.
- P4 code changes remain on the P4 branch. Do not create another Render service merely to bypass this verification constraint.
