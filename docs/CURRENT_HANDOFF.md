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

Current live `main`:

`5c6c92001293850d82e5b903539f2675bdf5735f`

P1 through P4, UI-R1 through UI-R4, and ALERT-R1 are merged. ALERT-R1 was delivered as PR #10, `ALERT-R1: Automatic high-risk email escalation via Brevo`, and is deployed on the existing Render service.

P3 itself was merged as:

`819f71a0750fe123868be37e00d56c96b6508742`

P1, P2, and P3 are merged. P2 was delivered as PR #2, `P2: Gemini transcription and call intelligence`, with merged baseline `e0a8e5b7321c5226e23640e1f2487873febc00f2`.

P3 was delivered as PR #3, `P3: Deterministic actions and human approval`, from `codex/p3-deterministic-actions`. P3 head was `d927bbae93a24b3b51c4f6c1e8a6023a87379734`, and the merged P3 main is `819f71a0750fe123868be37e00d56c96b6508742`. It completes deterministic action proposals, human decisions, fixed synthetic demo mutations, and persisted call activity without a new database migration or Gemini calls in P3.

The earlier P3 handoff had no open PRs. See the latest phase section below for current UI-R3 delivery status.

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

Current interview route:

1. `gemini-3.5-flash-lite` with `thinking_level: "high"`
2. `gemini-3.5-flash` with `thinking_level: "high"` as the bounded fallback

The earlier 3.8 → 3.7 → 3.6 → 3.5 chain was replaced after a deployed retention test exhausted four analysis attempts with `RATE_LIMIT` after transcription had already succeeded. The shorter Flash-Lite-first route is intended to reduce latency and avoid wasting time across several rate-limited model tiers. Routing and model identifiers remain centralized in `server/geminiService.ts`.

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

P4 was merged through PR #4, `P4: Demo hardening and interview readiness`.

P4 baseline: `4101edce5901f16a2ee6185ef2e268462cb0e5d0`

P4 merge SHA: `d978a8ca7921e46e18437aa5ad2434dd644560e2`

After the merge, `AGENTS.md` was also updated to prefer one bounded real local provider smoke test when credentials are already available and to avoid making temporary PR deployments a default merge prerequisite.

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
- No analyzed synthetic backup call existed at merge time. The corrected provider path was merged so the existing main-tracking Render service could deploy it directly; post-merge hosted verification remains the next check rather than a pre-merge blocker.

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
- PR #4 was merged with exact-head protection after the user explicitly chose merge-first/post-deploy verification instead of creating a temporary branch deployment.
- The existing Render service tracks `main` and auto-deploys main commits. Use that normal deployment for the remaining hosted retention verification; do not create another Render service.

## 17. Post-merge P4 verification — 2026-09-25

### Main and Render deployment

- Live `origin/main`: `2a6742ee6b59f600a97d79a22835e2a73dcaf9dc`.
- The existing Render Web Service `PestLaunch` is the only PestLaunch service, tracks `main`, and has auto-deploy enabled. Its latest deploy is `live` at `2a6742ee6b59f600a97d79a22835e2a73dcaf9dc`.
- No new Render service or preview deployment was created.

### Real local Gemini smoke test

- The checkout did not contain a file named `.env`; the ignored root `.env.txt` contained the required variable names. It was loaded locally through dotenv without displaying values.
- One real `createGeminiService().transcribe()` operation sent `demo/recordings/retention-risk.wav` inline. The provider accepted it, `gemini-3.5-transcribe` completed on attempt 1, and the implementation returned only after its own `CallTranscriptSchema` validation passed.
- The one-off inspection wrapper then incorrectly ran the schema against the whole return value including extra `attemptCount` metadata. That wrapper check failed before it printed or retained the transcript. This was a smoke-script mistake, not a provider failure; no second local transcription request was made. Local reasoning was therefore not run.

### Hosted retention workflow

- The fixed demo records were reset and verified. Jordan started `HEALTHY` / `WON`; Taylor `NEW`; Morgan `HEALTHY` / `WON`.
- Hosted call ID: `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd`, linked to Jordan Example (`demo_customer_id` `a1000000-0000-4000-8000-000000000001`). The fresh synthetic WAV was uploaded once through the deployed `/api/calls/ingest` endpoint after the controlled browser file chooser did not open. Processing and approval were then performed in the deployed UI.
- One **Process call** request completed. Transcript persisted with `model_used = gemini-3.5-transcribe`, `attempt_count = 1`; the text describes repeated technician lateness, possible cancellation, and a request for follow-up.
- Validated analysis persisted with `model_used = gemini-3.6-flash`, `call_type = COMPLAINT`, `cancellationRisk = true`, `complaint = true`, `followUpRequired = true`, `priority = HIGH`, and three transcript-grounded evidence quotes.
- The reasoning router received HTTP 429 rate-limit responses from `gemini-3.8-flash` and `gemini-3.7-flash`, then succeeded on `gemini-3.6-flash`. The configured bounded fallback chain worked; analysis took about two minutes. Allow that time if processing from a cold or rate-limited provider state.
- Deterministic `CREATE_RETENTION_FOLLOWUP` action `c924c6b9-82f4-547e-9bb8-aad9c1633cf5` was `PENDING` with Jordan still `HEALTHY` / `WON`. One approval completed the action and changed Jordan to `AT_RISK` / `WON`.
- Refreshing and reopening the call preserved transcript, analysis, completed action, Jordan's state, and the full persisted activity timeline. The action row and execution timestamp remained unchanged. Render logs showed no additional Gemini model attempts after the refresh/reopen.
- This is the persisted analyzed interview backup. Do not process or approve this call again.

### Remaining notes and readiness

- The controlled browser did not open its native file chooser; upload was verified through the same deployed ingestion endpoint used by the UI. The hosted process, analysis, proposal, approval, mutation, and post-refresh persistence were verified in the UI.
- The saved call has an empty optional `caller_name` and a valid `demo_customer_id`. UI-R1 uses the linked synthetic customer's name in the inbox and detail header when the caller name is blank; a call with neither name nor customer link remains `Unassigned call`. Stored call data is unchanged.
- The first inbox load showed its retryable load error once; **Try again** loaded the existing calls, and the post-processing refresh loaded normally.
- No database migration was created or applied, and `supabase db push` was not run.
- P1, P2, and P3 remain complete. P4 is now interview-ready. Recommended state: feature freeze and interview rehearsal.

## 18. UI-R1 — Loom-guided interview demo UI overhaul — 2026-09-25

### Scope and reference

- Starting `origin/main`: `94b59150d49994cfc8289deaff0fdfbe71a2aa36`.
- Reference Loom: https://www.loom.com/share/a58559d925244c279c1b8bbaee437dba
- Scope is frontend presentation of the verified interview workflow. P5 and backend/product expansion remain deferred.
- The Loom's visible client-list screen uses a persistent light navigation rail, one clear page title, compact white work rows, restrained borders, and direct primary actions. UI-R1 adapts the hierarchy and density to one call inbox and a selected-call workspace; it does not copy the multi-client navigation or financial/consulting modules.

### Main UI changes

- Replaced the leaf placeholder with the supplied PestLaunch logo and removed the Interview demo header badge.
- Reframed the landing view as a call inbox beside a selected-call review workspace.
- Made recording upload a deliberate, collapsible four-step flow with clear optional caller/customer fields and a visible linked-customer summary.
- When `caller_name` is blank, the linked synthetic customer's name labels the inbox row and call detail. If the customer list fails to load, a linked row remains labeled `Linked customer` until its selected detail resolves the name; calls without a customer link remain `Unassigned call`.
- The upload form exposes a read-only retry for the synthetic customer list when that lookup fails; it does not reset customer data.
- Added a call workflow progress strip, more prominent analysis summary and signal badges, separate transcript and evidence panels, and a distinct deterministic action/approval panel.
- Made approval state, persisted action result, current customer state, and activity timeline visible as separate parts of the reviewed call.
- Refined loading, retryable error, empty-list, and responsive layout treatments without changing processing or action handlers.

### Behavior and validation

- Backend behavior: unchanged. Gemini routing, analysis schemas, deterministic proposals, approval rules, API endpoints, idempotency, customer mutations, and persisted timeline were not modified.
- Database: no migration; `supabase db push` was not run.
- `npx tsc -p tsconfig.app.json --noEmit --pretty false`: passed.
- `npm test`: 53 passed, 0 failed.
- `npm run lint`: passed.
- `npm run build`: passed.
- Code review found and resolved the runbook disclosure, linked-customer fallback, accessible call-row name, and critical metadata legibility issues. Re-review found no remaining Critical or Important findings.
- Built app inspected in Codex's in-app browser at `http://localhost:3000/`. The verified call `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd` was opened read-only; the existing `NEEDS_REVIEW` call was also inspected without retrying it. No Process, Retry, Approve, or Reset action was triggered.
- The Loom was opened, played, and scrubbed in Codex's in-app browser; its public preview frame was visually inspected and its transcript used only as supporting context.

### Remaining visual limits

- Codex browser `Page.captureScreenshot` timed out on Loom, the deployed app, and localhost. No browser screenshots could be captured. Browser-rendered accessibility state was checked for the selected analyzed call, upload form, and `NEEDS_REVIEW` state.
- Pixel-level certification at 1440×900, 1366×768, and 1280px, and a mobile screenshot check remain unavailable in this environment.
- The inbox summary endpoint does not carry per-call classification or priority. Those details appear in the selected-call workspace without adding backend requests or changing the endpoint.
- A few secondary helper and empty-state captions remain more compact than the primary workflow text.

## 19. UI-R2 — Deployed visual QA and realistic-call polish — 2026-09-25

### Production and reference review

- Starting `origin/main`: `393383bf7a9df61d117dd46843eba74ab30e65a0`.
- Render's existing `PestLaunch` web service was confirmed live on that exact commit at https://pestlaunch.onrender.com. No service or preview deployment was created.
- Compared the deployed UI once more with the reference Loom. The call inbox and selected-call workspace retain the reference's clear page title, readable work list, compact status treatments, and direct primary action while fitting the narrower call-review workflow.
- Opened the verified backup call `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd` read-only. It showed linked Jordan Example, Analyzed / Complaint / HIGH / Cancellation risk, the summary and signals, transcript and evidence, completed retention follow-up, human approval, AT_RISK customer state, and the full activity timeline. No Process, Approve, Reject, or Reset action was triggered.
- Checked the deployed UI at 1440×900, 1366×768, 1280×800, and 390×844. No horizontal overflow appeared; the mobile layout stacks the inbox and call details vertically.

### External realistic-call sample

- Downloaded the public sample from https://chris-gordon-founder.github.io/websiteaudio/Pest%20Control.mp3 (895,895 bytes), uploaded through the normal UI as `External Pest Control Sample`, and left it unlinked from synthetic customers.
- Call ID: `21621eaa-0215-4d5f-88c6-c79977e4fd3b`.
- Ran one live Process call operation. Transcription used `gemini-3.5-transcribe`; analysis used `gemini-3.8-flash`.
- The result was `BOOKING`, 95% confidence, LOW priority, Positive sentiment, and Resolved outcome, with a New lead signal. The short summary described a new caller booking a roach service appointment for the next day. The transcript was about 1:51 across 13 speaker segments and displayed four evidence quotes. No model recommendation was returned, and deterministic policy found no applicable follow-up; no action was approved or executed. The timeline showed recording received, transcription completed, and call classified.

### Issue found and UI fix

- In the no-action result, the progress strip incorrectly marked Human review as the active step even though no action existed to approve.
- `buildCallWorkflowSteps` now marks Human review active only for a saved `PENDING` action. Pending, completed, and resolved action states retain their existing progress treatment. This is frontend-only; backend policy, API behavior, Gemini processing, approvals, execution, and persistence are unchanged.
- Added focused coverage for no-action, pending, and completed progress states.
- No database migration was created, and `supabase db push` was not run.

### Validation and remaining limits

- `npm test` — 56 passed, 0 failed.
- `npm run lint` — passed.
- `npm run build` — passed, including type checks and Vite production build.
- Inspected the built static UI locally at 1366×768. The local checkout has no `SUPABASE_URL`, so its API-backed recent-call data could not be loaded in that preview; the data-backed visual review was completed against the live deployment instead.
- A full transcript naturally pushes the timeline below the first mobile viewport. The no-action panel also leaves the `Generate action proposal` control available after the policy reports that no action applies; repeating that check does not create an action.

## 20. UI-R3 — No-action outcome and compact copy — 2026-09-25

### Design decision

- Call-detail responses now include a derived `actionPolicyState`. The field is also present in the call-detail payload returned after processing. No new database state or migration was added.
- `server/actionPolicy.ts` resolves saved action history first. With no saved action, it calls the existing deterministic policy only when the persisted analysis is valid and its evidence is grounded in the saved transcript; the validated linked customer is supplied to the same policy function.
- States are `NOT_READY`, `ACTION_AVAILABLE`, `PENDING_ACTION`, `APPROVED_ACTION`, `EXECUTING_ACTION`, `COMPLETED_ACTION`, `REJECTED_ACTION`, `FAILED_ACTION`, and `NO_ACTION_REQUIRED`.
- The proposal control appears only for `ACTION_AVAILABLE`. A `NO_PERMITTED_ACTION` result updates the current UI immediately; reopening the call derives the same state from saved analysis, transcript, customer, and action history.
- A pending action marks Human review active. Saved decisions complete Human review. A no-action result marks Human review as not required and Outcome complete.
- The no-action panel says “No follow-up action required” and explains the resolved case or lack of a permitted follow-up. Empty customer-state copy is omitted when there is no linked customer and no saved action.
- The app header now keeps the PestLaunch brand and Call Intelligence title while dropping the repeated product caption, workspace eyebrow, and tagline. Approval, action effect, and audit-history copy remain.

### Validation

- `npm test` — 61 passed, 0 failed.
- `npm run lint` — passed.
- `npm run build` — passed, including type checks and Vite production build.
- No database migration was created and `supabase db push` was not run. The walkthrough still uses the same calls and approval path, so the runbook was not changed.

### Browser verification

- Inspected the local UI in Codex's browser using the two existing hosted calls through a temporary GET-only preview proxy. The local workspace has no Supabase credentials; the preview derived policy state with the UI-R3 server policy code. The proxy rejected non-GET requests and was removed afterward.
- `21621eaa-0215-4d5f-88c6-c79977e4fd3b` showed BOOKING, 95% confidence, LOW priority, and RESOLVED. The UI showed “No follow-up action required,” Human review “Not required,” and a completed Outcome step, with no proposal CTA or unrelated empty customer-state message.
- `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd` retained its completed retention follow-up, approval and execution history, AT_RISK customer state, and completed workflow steps.
- Neither call was reprocessed or approved. This verifies the local UI against current persisted hosted records; no UI-R3 Render deployment was performed. Mobile browser verification remains outstanding.

## 21. UI-R4 — Source transcript and manual review — 2026-09-25

### Scope and design

- Starting `origin/main`: `856cd2b8c68a0a31880201aa3136210df1b5b720`.
- Kept the existing PestLaunch brand and compact Recent calls inbox. Removed repeated workflow captions, the five-step progress strip, model/provider callouts, and the footer tagline so the call review reads as a feature inside PestLaunch.
- On laptop/desktop widths, the selected-call workspace places the original recording and Source transcript beside AI findings. The transcript preserves speaker labels, supplied timestamps, and text; the recording remains directly above it.
- AI summary, sentiment, outcome, and signals remain separate from Evidence from transcript and the deterministic Follow-up decision. Evidence quotes show their speaker. A small Compare with source transcript link returns to the transcript; no timestamp matching or fuzzy jump behavior was added.
- Small screens stack the source column before AI findings. The inbox remains compact and receives no transcript preview.

### Behavior and validation

- Frontend-only. Gemini routing and prompts, API behavior, schemas, action policy, approval rules, customer mutations, and persistence are unchanged.
- Browser review used the persisted booking/no-action call `21621eaa-0215-4d5f-88c6-c79977e4fd3b` and completed retention call `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd`. Neither call was reprocessed or approved.
- Gemini calls: 0. Database migration: none. `supabase db push`: not run. Jev: not integrated.
- Local in-app browser rendering at approximately 1290×910 showed the source/AI columns without horizontal overflow. The browser exposes no viewport override, so exact 1440×900, 1366×768, and mobile screenshot checks could not be performed; the responsive stack is configured below 1080px.
- `npm test` — 58 passed, 0 failed. `npm run lint` — passed. `npm run build` — passed, including type checks and Vite production build.

## 22. ALERT-R1 — Automatic high-risk email escalation via Brevo — 2026-09-25

### Scope and behavior

- Starting `origin/main`: `a786a65b1d0029fcc2b7dbcc48dc77b094a196db` (UI-R4). Work is isolated on `codex/alert-r1-brevo`.
- The synchronous Process-call path dispatches an internal alert only after the transcript is persisted, analysis is schema-validated and evidence-grounded, and the analysis row is saved. A deterministic application rule sends only for `HIGH` or `URGENT`; Gemini does not call Brevo.
- `server/brevoService.ts` sends transactional email using server-side `fetch` to Brevo `/v3/smtp/email`, with a bounded request timeout and no automatic/background retry. Each normalized configured recipient is sent separately.
- Recipients come only from `HIGH_RISK_ALERT_RECIPIENTS`; entries are trimmed, lowercased, deduplicated, and invalid addresses are skipped. There is no public recipient field. Call-detail responses omit recipient addresses.
- The email contains the caller/customer name, classification, priority, sentiment, summary, risk signals, up to three evidence quotes, the deterministic recommended action if applicable, approval status, call ID, and app link. It omits the full transcript and does not claim the action executed.
- One `call_notifications` row per `(call_id, notification_type, recipient)` is the send claim. Existing rows suppress later sends for that recipient, including repeat/recovery Process requests. Provider failures are persisted as `FAILED`; they do not change an otherwise successful call from `ANALYZED` or block the action proposal. Repeated Process requests for already-ANALYZED calls do not backfill or resend alerts.
- Notification presentation is limited to HIGH/URGENT findings. It distinguishes sent, partial, pending, failed, not configured, and historical analyzed calls with no alert record. The existing UI-R4 source transcript and human-approved action structure remain intact. Timeline alert events are separate from action proposal/approval/execution events.
- The deterministic action policy, action API, approval checks, and synthetic customer mutation semantics are unchanged. Jev is not integrated.

### Persistence and hosted state

- Migration file: `supabase/migrations/20260925130430_call_notifications.sql`.
- The migration was applied to the hosted Supabase project through the Supabase connector and appears in hosted migration history as `20260925130430_call_notifications`. The table has RLS enabled, no `anon`/`authenticated` privileges, and `service_role` has only `SELECT`, `INSERT`, and `UPDATE` access. Privilege verification returned service-role access enabled and anon/authenticated select disabled.
- The unique key is `(call_id, notification_type, recipient)` with `notification_type = HIGH_RISK_ALERT`. Allowed statuses are `PENDING`, `SENT`, and `FAILED`; provider IDs, attempt count, safe errors, creation time, and send time are retained.

### Verification and production status

- Focused mocked verification: Brevo service 7/7, notification/presentation/timeline 10/10, and processing/action/ingestion integration 41/41 passed.
- `npm test` — 76 passed, 0 failed. `npm run lint` — passed. `npm run build` — passed, including app/server/test type checks, server compilation, and the Vite production build.
- The earlier local Brevo sandbox request returned HTTP 401. Production initially reproduced HTTP 401 until Brevo API IP blocking was disabled for the Render request path.
- Production was then re-verified with a fresh synthetic retention call: `2c9eb855-22f5-467a-a971-3388d2ffeae8`. It transcribed with `gemini-3.5-transcribe`, analyzed as `COMPLAINT` / `HIGH` with `gemini-3.8-flash`, and the HIGH-risk Brevo notification persisted as `SENT` with a provider message ID and send timestamp.
- The configured recipient confirmed receipt of the real email. The call remained `ANALYZED`, the deterministic action stayed available for human approval, and the notification recipient itself is omitted from public call-detail responses.
- The saved high-risk backup `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd` remains read-only historical evidence and should not be reprocessed. The saved LOW booking call `21621eaa-0215-4d5f-88c6-c79977e4fd3b` remains the no-alert regression case.
- Required Render/local server variables: `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, and `HIGH_RISK_ALERT_RECIPIENTS`. Use only verified internal recipients in server configuration.
- Temporary GitHub Actions smoke workflows were used only for deployed verification. Their historical red runs were test-harness failures (401 before the Brevo security change, then an overbroad `@` assertion); a final read-only production verification passed without sending another email.

## 23. FINAL-R1 — Automatic processing and interview readiness — 2026-09-25

### Starting point and behavior

- Starting `origin/main`: `756f8b54643a25d1b6b8784ced6cb1217858a7ea` (ALERT-R1). Implementation branch: `codex/final-r1-automatic-processing`.
- A successful upload selects the returned call and starts the existing `POST /api/calls/:id/process` once. The upload endpoint remains a persistence boundary; Gemini processing is not moved into multipart ingestion.
- Processing requests are coordinated per call. Reopening an analyzed call does not process it; historical `UPLOADED` calls are not auto-processed on page load. Manual processing/retry remains for `UPLOADED`, `FAILED`, and `NEEDS_REVIEW` recovery. A fresh-upload or explicit recovery request continues the deterministic proposal/no-action step even if the user changes the selected call while processing.
- The shared progress UI maps persisted call, transcript, analysis, and action-policy state to stage labels. `UPLOADED` shows the saved recording while processing starts; `PROCESSING` without a transcript shows transcription; `TRANSCRIBED` shows analysis; saved analysis with unresolved workflow shows workflow rules; resolved action/no-action state becomes a compact Ready for review message. FAILED and NEEDS_REVIEW show that the recording is saved and expose retry where the existing endpoint permits it.
- While processing is pending, the browser performs sequential read-only `GET /api/calls/:id` polls at 1.5-second intervals, bounded to 120 attempts. Polls carry the selected-call generation so a stale request cannot cancel a newer view. Polling stops at terminal status, on call selection/unmount, or after the bound. A transient/timeout notice offers a read-only Refresh status action, and FAILED/NEEDS_REVIEW identifies the stage needing attention. Polling never invokes Gemini, sends email, proposes an action, or executes one.
- Recent-call list refreshes are request-ordered so an earlier response cannot overwrite a newer processing status.

### Call-detail presentation

- Source Transcript and AI findings/evidence remain side by side. Recommended response now starts on a full-width row after that comparison; pending approval, completed result, and no-action states use the same section.
- Pending actions keep Approve follow-up primary and Reject secondary. Completed history distinguishes recorded outcome from current customer status. LOW/no-action calls show No follow-up action required without approval controls or high-risk alert treatment.
- Activity is a connected vertical chronology with event names, optional detail, and secondary timestamps. Mobile keeps the same vertical order without horizontal timeline scrolling.
- Deterministic action policy, action types, approval, customer mutations, action idempotency, and ALERT-R1 notification idempotency are unchanged. No migration, `supabase db push`, provider, or queue/worker changes were made. Jev is not integrated.

### Browser and hosted-call verification

- Hosted fixtures were selected and inspected read-only: completed retention `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd`, LOW booking `21621eaa-0215-4d5f-88c6-c79977e4fd3b`, and SENT Brevo alert `2c9eb855-22f5-467a-a971-3388d2ffeae8`. No fixture was reprocessed, approved, or resent.
- The hosted SENT-alert call currently has no saved action proposal. The pending-action layout and active progress stages were therefore inspected against local in-memory mock responses; the mock server was removed afterward. No production or provider requests were made for visual QA.
- Local browser layout checks: 1440×900, 1366×768, 1280×800, and 390×844. Document widths stayed within each viewport; recommendation and timeline begin below the source/AI comparison, and mobile stacks both sections.

### Validation

- `npm test` — 95 passed, 0 failed.
- `npm run lint` — passed.
- `npm run build` — passed, including app/server/test type checks and Vite production build.
- Gemini calls: 0. Brevo sends: 0. Database migration: none. Jev: not integrated.
- Prototype limitation remains: processing is synchronous on the existing server. If the server stops during a run, a call can remain `PROCESSING`; this phase adds bounded read-only polling but no background worker or stale-lock recovery policy.

## 24. FINAL-R2 — AI customer response draft — 2026-09-26

### Behavior and persistence

- After the persisted transcript and validated analysis produce a deterministic `CREATE_RETENTION_FOLLOWUP`, the first successful action insert triggers one customer-draft request using `gemini-3.5-flash-lite` with high thinking. The draft request uses only the caller/customer name, transcript, analysis summary/intent/outcome and relevant signals, and deterministic action reason. It has no model fallback.
- The validated `subject`, `body`, and `modelUsed` are saved as `customerCommunication` inside the existing `agent_actions.payload_json`. No new table or database migration is needed.
- Existing or duplicate proposals return the saved action without another draft request. Reopening a call reads the persisted draft. Draft errors or invalid output leave the deterministic action usable and approval-gated.
- The Recommended response panel marks the draft for review before sending and copies `Subject: ...` plus the body. PestLaunch has no customer-send control; automatic Brevo email remains an internal HIGH/URGENT escalation only.

### Interview story

Gemini understands the call → deterministic policy decides the operational action → Gemini drafts the human-facing communication → a human remains responsible for sending it.

### Verification

- `npm test` — 103 passed, 0 failed. `npm run lint` — passed. `npm run build` — passed.
- Automated Gemini coverage uses a fake Interactions client and made zero provider requests.
- One live smoke used the FINAL-R2 local server against the configured Supabase project. Synthetic call `93e4d86b-ee1d-49db-88aa-27945728ec94` was transcribed once with `gemini-3.5-transcribe`, analyzed once with `gemini-3.5-flash-lite`, and drafted once with `gemini-3.5-flash-lite` at high thinking. It persisted as `COMPLAINT` / `HIGH` with cancellation risk and a pending, approval-required `CREATE_RETENTION_FOLLOWUP` action containing the draft subject, body, and model name.
- Local browser review showed the draft in Recommended response, **Copy email** displayed **Copied**, and refresh/reopen loaded the same saved draft. The local smoke had no configured `HIGH_RISK_ALERT_RECIPIENTS`; zero notification rows were created and no customer email was sent.
- The existing Render service remains on pre-FINAL-R2 code. Its call-detail API currently returns HTTP 503 `CALL_INTELLIGENCE_UNAVAILABLE` for this new action payload because the deployed strict schema predates `customerCommunication`. Verify the call through Render after FINAL-R2 is merged/deployed. No Render deploy or merge was triggered for this PR.
- Migration: none. Jev: not integrated.
