# P3 Deterministic Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Extend the merged P2 call workflow with deterministic, approval-gated demo actions and a persisted activity timeline without adding a database migration or Gemini calls in P3.

**Architecture:** Keep policy and action payload validation in small shared/server modules. Use the existing `agent_actions` primary key for deterministic proposal IDs, compare-and-set status updates for decisions/execution, and fixed synthetic customer IDs for demo mutations. Enrich the existing call detail response and workspace rather than creating a new product area.

**Tech Stack:** Node 22+, TypeScript, Express 5, Supabase JS, Zod, React, Vite, `node:test`, Supertest.

**Spec:** User-provided P3 requirements in the current task; repository constraints in `AGENTS.md`, `docs/CURRENT_HANDOFF.md`, and `docs/PROTOTYPE_PLAN.md`.

## Global Constraints

- Start from merged P2 commit `e0a8e5b7321c5226e23640e1f2487873febc00f2` on `codex/p3-deterministic-actions`.
- P3 proposal, decision, execution, reset, and timeline paths make zero Gemini calls.
- No `supabase db push`, schema recreation, or convenience migration.
- Never execute `analysis.recommendedAction.type` or client-provided actions/patches.
- Only fixed synthetic demo customer IDs may be reset or mutated.
- Keep P2 explicit-processing and quota protections unchanged.
- Run focused tests during development; run `npm test`, `npm run lint`, and `npm run build` once after the implementation is stable.

## Review Focus

- Conflicting or malicious model action names: action type must come only from the policy allowlist.
- Simultaneous proposal requests: the deterministic primary key must leave one logical action row.
- Simultaneous approve/reject requests: conditional transitions must permit only one terminal path and one execution claim.
- Failed deterministic execution: preserve approval and permit only an idempotent retry of the same stored action.
- Reset input and linked customer IDs: requests must never mutate or delete non-fixture customer/call/action records.

---

### Task 1: Action contracts and deterministic policy

**Files:**
- Create: `src/shared/actions.ts`
- Create: `server/demoFixtures.ts`
- Create: `server/actionPolicy.ts`
- Test: `tests/action-policy.test.ts`

**Interfaces:**
- `AgentActionType`, `AgentActionStatus`, `AgentActionPayloadSchema`, and `DemoCustomerSchema` are shared runtime-validated contracts.
- `proposeDeterministicAction(analysis, customer)` returns one validated payload or `null`.
- `DEMO_CUSTOMERS` and `DEMO_CUSTOMER_IDS` define exactly three synthetic fixtures.

- [x] Write tests for cancellation precedence, collections, new lead, reactivation, upsell, no-action, and a conflicting `recommendedAction.type`.
- [x] Run `npx.cmd tsx --test tests/action-policy.test.ts`; it failed at module load because the policy module was absent.
- [x] Implement strict payload schemas, fixed fixture identities, deterministic priority/reason/title mapping, and expected customer changes only for the retention persona and termite lead.
- [x] Run the focused policy test; all 11 cases pass.

### Task 2: Proposal, decision, execution, and demo endpoints

**Files:**
- Create: `server/actionsRouter.ts`
- Modify: `server/index.ts`
- Create: `tests/action-api.test.ts`

**Interfaces:**
- Mount `POST /api/calls/:id/actions/propose`, `POST /api/actions/:id/approve`, `POST /api/actions/:id/reject`, `GET /api/demo/customers`, and `POST /api/demo/reset`.
- The router accepts Supabase only; it has no Gemini dependency.
- Proposal IDs are deterministic UUIDs derived from the call ID and allowlisted action type. Duplicate-key responses reload the existing row.
- Approval and rejection use conditional status updates; execution claims `APPROVED` or retryable `FAILED` with a status predicate before any customer update.

- [x] Add injected-Supabase route tests for no-analysis/no-action behavior, repeat/concurrent proposals, approval-before-mutation, rejection, arbitrary request rejection, completed idempotency, concurrent approval, failure and safe retry, no Gemini calls, and reset isolation.
- [x] Run `npx.cmd tsx --test tests/action-api.test.ts`; it failed at module load because the router was absent.
- [x] Implement strict stored-row validation, allowlisted deterministic execution, fixed-ID fixture reset/listing, and bounded error recording without changing the foundation schema.
- [x] Run the focused API test; all 14 cases pass.

### Task 3: Persisted call-detail context and timeline

**Files:**
- Modify: `server/callsRouter.ts`
- Create: `src/shared/actionTimeline.ts`
- Modify: `src/shared/calls.ts` only if a reusable call-detail type belongs there
- Test: `tests/action-timeline.test.ts`

**Interfaces:**
- `GET /api/calls/:id` returns validated linked customer data and validated action rows alongside the existing call, transcript, and analysis.
- `buildCallTimeline(detail)` derives timestamped events only from persisted call/intelligence/action/customer state.

- [x] Test recording, transcript, classification, risk, proposal, approval, rejection/no-mutation, execution, and failure timeline events from persisted fixtures.
- [x] Run the focused timeline test; it failed at module load because the helper was absent.
- [x] Extend the existing detail loader and implement a pure, chronologically sorted timeline projection.
- [x] Run focused detail/timeline checks, including no Gemini calls on GET.

### Task 4: Upload association and call-detail controls

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`

**Interfaces:**
- The upload form lists only returned synthetic demo customers and submits the selected `demo_customer_id`.
- An explicit reset control calls `POST /api/demo/reset` and reloads the fixture list.
- Successful P2 processing requests a deterministic proposal; already analyzed calls can generate one without reprocessing.
- The call detail view separates AI intelligence, deterministic action, current customer state, and persisted timeline.
- Approve/Reject controls are disabled during requests and refresh the detail from the API afterward.

- [x] Add customer list/reset loading, upload association, proposal request state, and approval/rejection handling to the existing workspace.
- [x] Render proposal reason, priority, expected effect, status, resulting customer state, and timeline without treating AI `recommendedAction.type` as executable.
- [x] Add narrow styles that retain the existing responsive two-panel workspace.
- [x] Run TypeScript and focused API tests after the UI wiring.

### Task 5: Handoff, README, and final validation

**Files:**
- Modify: `docs/CURRENT_HANDOFF.md`
- Modify: `README.md`

- [x] Record merged P2 baseline, P3 action policy/lifecycle/endpoints/reset/idempotency, zero-Gemini behavior, migration state, actual validation, and bounded P4 direction.
- [x] Update README API and interview workflow notes without broad product changes.
- [x] Run `npm test`, `npm run lint`, and `npm run build` once after implementation is stable; `npm test` passed 48/48, lint passed, and build passed.
- [ ] Commit, push `codex/p3-deterministic-actions`, open one PR titled `P3: Deterministic actions and human approval`, and stop after it is open.
