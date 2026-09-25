# PestLaunch Call Intelligence Prototype Plan

## 1. Purpose

Build and deploy a small but working semi-autonomous agent workflow that can be demonstrated in the PestLaunch interview.

The prototype should directly reflect the product direction described by Landon: centralize business data, improve call intelligence, and gradually move from analytics into AI agents that can perform useful work across sales, retention, collections, upsells, reactivation, and operations.

This prototype does **not** attempt to reproduce PestLaunch. It demonstrates one architecture pattern that can later support those larger workflows.

## 2. Success definition

The primary interview demo must reliably complete this path:

```
Upload a pest-control call recording
        ↓
Store recording
        ↓
Transcribe with speaker-aware output when available
        ↓
Classify the call and extract business signals
        ↓
Show evidence for the classification
        ↓
Generate a recommended business action
        ↓
Require human approval for customer/business-impacting action
        ↓
Apply the approved action to demo customer/pipeline state
        ↓
Record the complete action history
```

The prototype succeeds if this flow works consistently on a deployed URL and can be explained clearly in a short interview demonstration.

## 3. Product principles

### 3.1 Narrow before broad
Only one workflow must be excellent for the interview. Do not spend the initial build window on a broad dashboard, multiple unrelated agents, or a full CRM.

### 3.2 AI proposes; deterministic code governs
Models interpret unstructured call data and return structured analysis. Application code determines which actions are permitted, whether approval is required, and how state changes are executed.

### 3.3 Human approval by default
Any customer-facing or materially business-changing action remains approval-gated in the prototype.

### 3.4 Evidence over unexplained scores
When the agent flags a call as a cancellation risk, complaint, upsell opportunity, etc., preserve short transcript evidence supporting the result.

### 3.5 Provider-neutral ingestion
The interview demo uses manual audio upload, but the backend exposes an ingestion boundary so a phone provider can later send completed recordings without changing the downstream workflow.

### 3.6 Reliability over feature count
Once the core path is working, remaining time should be spent on fallbacks, error states, validation, demo data, deployment, and rehearsal.

---

## 4. Core workflow

### Stage A — Call ingestion

Initial inputs:

- drag-and-drop/upload from the web app
- provider-neutral backend ingestion endpoint for future phone-system integration

Suggested endpoint:

`POST /api/calls/ingest`

For the interview build, this endpoint does not need a live Twilio, Dialpad, RingCentral, or CRM integration.

Persist:

- call ID
- caller/demo customer reference
- audio object/storage path
- processing status
- timestamps
- error state

### Stage B — Transcription

Primary model:

**Gemini 3.5 Transcribe**

Fallback path:

1. Gemini 3.5 Transcribe
2. Gemini 3.8 Flash using direct audio understanding/transcription
3. configurable compatible Flash multimodal fallback if required

Desired output:

- full transcript
- speaker-separated segments when supported
- timestamps when supported
- model used
- attempt metadata

The provider layer must expose a normalized internal transcript format so downstream analysis does not care which model produced it.

Example normalized shape:

```ts
type Transcript = {
  text: string
  segments: Array<{
    speaker: string
    startMs?: number
    endMs?: number
    text: string
  }>
  modelUsed: string
}
```

### Stage C — Structured reasoning and classification

Reasoning route:

1. **Gemini 3.8 Flash**
2. **Gemini 3.7 Flash**
3. **Gemini 3.6 Flash**
4. **Gemini 3.5 Flash**
5. optional **Gemini 3.5 Flash Lite** last-resort path for low-cost retry/schema repair

Fallback should occur for:

- rate/quota errors
- provider 5xx failures
- timeout
- malformed or schema-invalid structured output

Do not create unbounded retry loops.

### Stage D — Deterministic policy engine

The model does not directly mutate CRM/customer state.

It produces structured analysis. A deterministic policy engine converts that analysis into one or more proposed actions.

Examples:

```
IF cancellation_risk = true
THEN propose CREATE_RETENTION_FOLLOWUP
AND priority = HIGH
AND requires_approval = true
```

```
IF call_type = NEW_LEAD
AND confidence >= configured threshold
AND follow_up_required = true
THEN propose CREATE_SALES_FOLLOWUP
```

```
IF upsell_opportunity = true
THEN propose CREATE_UPSELL_TASK
```

### Stage E — Approval and execution

Action lifecycle:

```
PENDING
  -> APPROVED | REJECTED
  -> EXECUTING
  -> COMPLETED | FAILED
```

The first prototype executes against demo customer/pipeline/task state, not a live PestLaunch CRM.

Every action should record:

- proposed payload
- reason
- approval requirement
- approval/rejection
- execution result
- timestamps
- errors if any

---

## 5. Call taxonomy

Use a small primary taxonomy:

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

Primary call type is separate from secondary signals.

A single call may therefore be:

```
call_type = COMPLAINT
cancellation_risk = true
follow_up_required = true
priority = HIGH
```

This is preferable to forcing all business meaning into one label.

---

## 6. Structured analysis contract

Target internal shape:

```ts
type CallAnalysis = {
  callType:
    | "NEW_LEAD"
    | "BOOKING"
    | "SERVICE"
    | "COMPLAINT"
    | "CANCELLATION"
    | "COLLECTIONS"
    | "UPSELL"
    | "REACTIVATION"
    | "INTERNAL"
    | "OTHER"

  confidence: number
  summary: string
  customerIntent: string
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "MIXED"
  outcome: "RESOLVED" | "UNRESOLVED" | "FOLLOW_UP_REQUIRED" | "UNKNOWN"

  signals: {
    newLead: boolean
    complaint: boolean
    cancellationRisk: boolean
    upsellOpportunity: boolean
    reactivationOpportunity: boolean
    collectionsIssue: boolean
    followUpRequired: boolean
  }

  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT"

  recommendedAction: {
    type: string
    reason: string
    requiresApproval: boolean
  } | null

  evidence: Array<{
    speaker?: string
    quote: string
  }>
}
```

Validate model output in application code before it can reach the policy engine.

---

## 7. Model-router behavior

Implement model routing behind internal interfaces rather than scattering model names throughout the app.

Suggested logical interfaces:

```ts
transcribeCall(audio): Promise<Transcript>
analyzeCall(transcript): Promise<CallAnalysis>
```

Each attempt should persist or log:

- selected model
- attempt number
- start/end time
- success/failure
- normalized error category

Recommended failure categories:

- `QUOTA`
- `RATE_LIMIT`
- `TIMEOUT`
- `PROVIDER_ERROR`
- `INVALID_OUTPUT`
- `UNSUPPORTED_INPUT`

After reasonable fallbacks are exhausted, mark the call `NEEDS_REVIEW` instead of pretending automation succeeded.

---

## 8. Demo UI

### 8.1 Call Intelligence Inbox

Primary screen:

- prominent upload control
- recent calls
- primary classification
- confidence
- key signal
- processing/action status

Keep the interface intentionally simple.

Example rows:

```
Sarah Johnson
NEW LEAD · 96%
Follow-up needed

John Smith
COMPLAINT · 94%
Cancellation risk · High priority

Mike Adams
SERVICE · 97%
No action needed
```

### 8.2 Call detail

Desktop layout:

**Left**
- audio player
- speaker-labelled transcript
- timestamps when available

**Right**
- call type
- confidence
- summary
- customer intent
- signals
- evidence
- recommended action
- Approve / Reject controls

### 8.3 Activity timeline

Display the automation lifecycle:

```
Recording received
Transcription completed
Call classified
Retention risk detected
Action proposed
Action approved
Retention task created
```

### 8.4 Processing details

Keep implementation detail out of the primary UI, but provide a compact expandable area showing:

- transcription model used
- reasoning model used
- fallback attempts
- errors/retries if any

This can demonstrate robustness without cluttering the main experience.

---

## 9. Demo business state

Do not build a full CRM.

Create enough state to demonstrate that the agent actually performs work.

### Demo customer

Suggested fields:

- name
- customer/lead type
- health status
- pipeline stage
- assigned user
- open tasks

### Demo lead pipeline

```
NEW
-> CONTACTED
-> QUALIFIED
-> SCHEDULED
-> WON | LOST
```

Approved agent actions should visibly modify this state.

Examples:

- create sales follow-up
- create retention case
- create upsell task
- move demo lead to Qualified
- mark customer health as At Risk

---

## 10. Minimal persistence model

Initial tables:

### `calls`
- id
- caller_name / demo_customer_id
- audio_path
- status
- duration
- last_error
- created_at
- updated_at

### `transcripts`
- id
- call_id
- text
- segments_json
- model_used
- attempt_count
- created_at

### `call_analysis`
- id
- call_id
- call_type
- confidence
- summary
- analysis_json
- model_used
- created_at

### `agent_actions`
- id
- call_id
- action_type
- payload_json
- status
- requires_approval
- error_message
- created_at
- approved_at
- executed_at

### `demo_customers`
- id
- name
- customer_type
- pipeline_stage
- health_status
- assigned_to
- created_at
- updated_at

Use Supabase Storage for uploaded audio.

---

## 11. Initial demo scenarios

Prepare three synthetic/non-customer recordings.

### Scenario A — lead follow-up

Prospect asks about termite treatment and pricing, appears qualified, but does not book.

Expected:

- `NEW_LEAD`
- follow-up required
- propose sales follow-up
- optional move to `QUALIFIED` after approval

### Scenario B — retention risk

Existing customer complains about repeated technician lateness and says they are considering cancellation.

Expected:

- primary type `COMPLAINT` or `CANCELLATION` based on wording
- cancellation risk = true
- priority = HIGH
- propose retention follow-up
- customer health becomes `AT_RISK` after approval

This should be the primary interview demo.

### Scenario C — upsell

Existing customer asks whether the company also provides mosquito treatment.

Expected:

- `UPSELL` or `SERVICE` with upsell signal
- upsell opportunity = true
- propose upsell task

---

## 12. Optional feature if time remains

Generate an employee-facing suggested response or coaching note after classification.

Example:

```
Suggested response — not sent
"I can understand why that would be frustrating..."
```

This must remain clearly labelled as a suggestion and should not automatically contact a customer.

It is optional and must not delay the core workflow.

---

## 13. Technical stack

### Frontend
- React
- TypeScript
- Vite

### Backend
- Node.js
- TypeScript
- simple REST API

### Data
- Supabase Postgres
- Supabase Storage

### AI
- Gemini API through a dedicated routing/provider module

### Deployment
- Render

Avoid for the first prototype unless proven necessary:

- LangChain
- CrewAI
- complex multi-agent frameworks
- vector databases
- live phone-provider OAuth/integration
- n8n
- full CRM implementation
- live SMS/email automation

---

## 14. Security and safety baseline

Even for a demo:

- keep Gemini and Supabase service credentials server-side
- do not expose privileged keys to the browser
- accept only expected audio MIME types and sensible upload sizes
- use synthetic recordings rather than real customer calls
- validate all structured AI output before action generation
- do not let model-generated strings become arbitrary tool/action names
- keep customer-facing actions approval-gated
- record action history for auditability

---

## 15. 18-hour execution budget

| Time | Target |
|---|---|
| 0–1h | repository/bootstrap, architecture, schema, environment config |
| 1–3h | audio upload and Supabase Storage |
| 3–5h | transcription provider + fallback |
| 5–7h | structured analysis + reasoning model router |
| 7–8h | deterministic policy engine |
| 8–10h | approval and action execution |
| 10–12h | inbox and call-detail UI |
| 12–13h | demo customer/pipeline state |
| 13–14h | audit/activity timeline |
| 14–15h | fallback/error handling |
| 15–16h | Render deployment |
| 16–17h | three demo recordings and end-to-end testing |
| 17–18h | critical fixes and interview rehearsal |

### Hard scope rule

At approximately hour 12, stop adding new features.

From that point onward, prioritize:

1. main-path reliability
2. visible error handling
3. fallback behavior
4. deployment
5. demo fixtures
6. interview rehearsal

---

## 16. Interview demonstration target

Ideal walkthrough:

1. Explain that PestLaunch already has call logs but call identification/coaching/automation can go much further.
2. Upload the synthetic cancellation-risk recording.
3. Show transcription and speaker segments.
4. Show `COMPLAINT/CANCELLATION RISK`, confidence, summary, and exact transcript evidence.
5. Show the proposed retention action.
6. Approve it.
7. Show customer health/task state update.
8. Show the audit timeline.
9. Explain that manual upload is only the demo ingestion method; a real phone provider can POST recordings into the same downstream workflow.
10. Explain that the same pattern can later power collections, lead follow-up, upsells, reactivation, and other PestLaunch agents.

The objective is not to claim a full production PestLaunch integration. The objective is to demonstrate a credible, working architecture for turning messy business data into safe, observable agent actions.

---

## 17. Deferred after interview

Possible future work, explicitly outside the first 18-hour build:

- real phone-provider webhook integration
- live transcription
- call coaching/scoring
- CRM-specific connectors
- outbound SMS/email execution
- collection agent
- retention agent
- reactivation agent
- upsell agent
- agent memory across customer history
- client-specific policy configuration
- per-client terminology/custom vocabulary
- production-grade queues/workers
- analytics and evaluation datasets
- human feedback loop for classification quality
