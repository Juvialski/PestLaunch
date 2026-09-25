# P3 Execution Ledger

- Base verified: `origin/main` at `e0a8e5b7321c5226e23640e1f2487873febc00f2`; PR #2 merged; no open PRs.
- Branch: `codex/p3-deterministic-actions`.
- Baseline working tree was clean. No dependency installation, migration command, or Gemini request was run.
- Preflight: mapped only the P2 call router, AI boundary, shared call contracts, call-detail UI/styles, P2 processing tests, foundation migration, and API/readme handoff.
- Task 1: action schemas, fixed personas, deterministic policy complete. `tests/action-policy.test.ts`: 11 passing.
- Task 2: proposal/decision/execution/reset APIs complete. `tests/action-api.test.ts`: 14 passing; covers no Gemini calls, retries, concurrency, and reset isolation.
- Task 3: persisted call-detail extension and timeline projection complete. `tests/action-timeline.test.ts`: 3 passing; P2 call-detail/processing tests also pass.
- Task 4: upload customer selector/reset, automatic post-process proposal, analyzed-call proposal control, approval panel, customer result and timeline UI complete. Client and server/test TypeScript checks pass.
- Final validation: `npm test` 48/48; `npm run lint` pass; `npm run build` pass. No live Render/hosted Supabase end-to-end verification was run.

Ruling: use one deterministic action ID per call instead of per call and action type — the product contract allows one primary action per call, and a call-only primary key prevents concurrent requests after analysis changes from creating two logical proposals — cost if wrong: an updated analysis cannot replace the original proposal; it remains available as the immutable first action record.

Ruling: treat validated `COLLECTIONS` and `REACTIVATION` call types as their respective policy signals when the secondary boolean is false — the taxonomy still identifies a relevant task, and human approval remains mandatory — cost if wrong: a mistaken primary classification can create a pending proposal, but cannot execute without approval.

Ruling: cap approved deterministic execution attempts at three — this bounds synchronous retry behavior while covering a first failure and two explicit retries — cost if wrong: a persistent transient failure needs a future operator recovery path after the action reaches the retry limit.

Pending: commit/push and open the one requested P3 PR.
