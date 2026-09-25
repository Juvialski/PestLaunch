# PestLaunch interview demo runbook

## Pre-interview check

- Open [pestlaunch.onrender.com](https://pestlaunch.onrender.com).
- Confirm Render has the server-only `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`, and `HIGH_RISK_ALERT_RECIPIENTS` variables. The sender must be verified in Brevo; keep recipients in server configuration, never in the public UI.
- Confirm the notification ledger migration is applied and the Brevo sender and configured internal recipient are ready before the interview.
- Open **Add recording** to reveal the upload form. For the live walkthrough, click **Reset demo records** there. Confirm Jordan Example is `HEALTHY` / `WON`, Taylor Example is `NEW`, and Morgan Example is `HEALTHY` / `WON`.
- Confirm the synthetic retention recording is available at `demo/recordings/retention-risk.wav` and that the upload customer selector offers Jordan Example. Enter `Jordan Example` in the optional caller-name field or select Jordan as the linked synthetic customer; the linked customer name labels the inbox row when the caller name is blank.
- Verified analyzed backup call: `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd`. For the backup path, skip reset if you want to preserve the current `AT_RISK` customer state. The completed backup action is immutable and must not be approved or executed again.
- Confirm no call intended for the demo is stuck in `PROCESSING`.

**ALERT-R1 readiness note (2026-09-25):** Production high-risk email escalation is verified. Fresh call `2c9eb855-22f5-467a-a971-3388d2ffeae8` reached `COMPLAINT` / `HIGH`, Brevo accepted the alert as `SENT`, a provider message ID and send timestamp were persisted, and the configured recipient confirmed receipt. Brevo API IP blocking had to be disabled for the Render request path. Keep the existing analyzed backup read-only; it predates alert delivery and is not the sent-email fixture.

**Readiness note (2026-09-25):** The final interview build uses `gemini-3.5-flash-lite` for analysis with high thinking and `gemini-3.5-flash` as a single high-thinking fallback. This replaces the slower multi-model reasoning cascade after a deployed test hit repeated rate limits. The production Brevo path has been verified separately with a real HIGH-risk alert and inbox receipt.

**FINAL-R2 draft fixture (2026-09-26):** Synthetic call `93e4d86b-ee1d-49db-88aa-27945728ec94` has a persisted transcript, HIGH complaint/cancellation-risk analysis, pending retention action, and one saved `gemini-3.5-flash-lite` customer draft. It remained unapproved and no customer email was sent. The local verification had no configured internal alert recipients. This action payload was written before the FINAL-R2 branch is deployed; use the fixture through Render only after the PR is merged/deployed, because the current Render main does not yet accept the extended action payload schema.

## Recommended live walkthrough

1. Explain that manual upload is the prototype's call-ingestion boundary and processing starts automatically after upload.
2. Upload a fresh copy of `demo/recordings/retention-risk.wav` and select Jordan Example.
3. Show the saved recording selected immediately and the stage-based progress: recording uploaded, transcription, analysis, and workflow rules. There is no AI percentage.
4. Show the saved transcript.
5. Show the complaint or cancellation-risk classification and high priority.
6. Point to the transcript evidence supporting the cancellation risk.
7. Show **High-risk escalation — Sent to configured contacts** and check the internal inbox for the PestLaunch alert.
8. Explain that the email is an internal alert sent after validated analysis. It includes a short summary and supporting evidence, omits the full transcript, and does not execute the proposed business action.
9. Show the deterministic retention action and its customer response draft. Explain that the draft is created once with `gemini-3.5-flash-lite` after the first retention action is saved, then read from the action payload on refresh.
10. Read the draft against the transcript evidence. Point out **Review before sending** and use **Copy email** to copy `Subject: ...` plus the body.
11. Explain the two separate boundaries: the automatic Brevo message is an internal escalation; the customer draft is never sent by PestLaunch and remains for a human to review and send separately.
12. Show that Jordan is still `HEALTHY` while the business action awaits approval.
13. Click **Approve follow-up**.
14. Show Jordan change to `AT_RISK`, the retention follow-up reach `COMPLETED`, and the saved customer draft remain visible and copyable beside the recorded outcome.
15. Walk through the connected activity timeline, including the separate high-risk alert event.
16. Explain that refresh/reopen reads saved transcript, analysis, alert, action, and draft state without rerunning Gemini, regenerating the draft, or sending a duplicate alert.
17. Explain that the same deterministic pattern can later support leads, collections, upsells, and reactivation; customer communications remain outside this phase.

## Processing and workflow boundary

- Current prototype: browser upload → the frontend automatically starts the existing idempotent processing request.
- Progress reflects persisted stages; Gemini work uses an indeterminate active stage, not a percentage.
- HIGH/URGENT internal escalation is automatic after validated analysis. A material business action still waits for human approval.
- For a new retention action, one optional Gemini call creates a customer email draft in the action payload. It is shown for human review and can be copied; there is no customer-send control or automatic customer email.
- Future production: recording ingestion → backend event or queue → background processing. No queue or worker is part of this prototype.
- Jev is not integrated.

Reset only restores the three fixed synthetic customer starting values. It keeps calls and action history. Start each rehearsal with a fresh upload so the prior call's action remains immutable.

## UI-R1 presentation walkthrough

The call inbox and selected-call review now share one workspace. Open the analyzed backup `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd` read-only, then point out:

1. The inbox row shows Jordan using the linked synthetic customer name, even though the optional caller-name field is blank.
2. The selected call header shows `COMPLAINT`, `HIGH` priority, cancellation risk, and analyzed status.
3. The original recording and source transcript sit beside the AI findings for direct review.
4. The transcript evidence quotes show their speakers, so they can be checked against the source conversation.
5. The deterministic follow-up result is separate from AI findings. Its approval state, customer status, and activity timeline remain visible.

For the no-action case, select `21621eaa-0215-4d5f-88c6-c79977e4fd3b` and show the booking transcript, positive/resolved findings, and **No follow-up action required** result. Do not process the saved call again.

For a fresh recording, use **Add recording**. Choose audio, optionally enter the caller name, link a synthetic customer if applicable, and upload. Blank caller names use the linked customer name; without a customer link the inbox says **Unassigned call**. The app selects the new call and starts processing automatically. Use Retry processing only for a saved call in `FAILED` or `NEEDS_REVIEW`. Only approve or reject the new recommendation during the live walkthrough; the backup call is already complete.

## Backup path

If live Gemini processing fails during the interview, open the verified call `53d0f8b5-e520-42fb-9c0a-a64fa1212cdd`, state briefly that the live model service is unavailable, and show its persisted transcript, analysis, evidence, completed retention action, and activity timeline. This backup has already been approved and executed; do not click **Process call** or **Approve** again. Use persisted application data; do not invent or manually seed model results. If synthetic data was reset immediately before taking the backup path, Jordan may show `HEALTHY` because reset preserves call/action history but restores customer fields; describe the saved timeline as the completed historical action in that case.

## What not to claim

- This is not integrated with live PestLaunch production or a live phone system.
- The prototype does not send customer messages autonomously.
- It is not a complete CRM replacement.

Describe it as a working prototype for a safe, observable call-intelligence and action-approval architecture.

Jev is not integrated. Automatic email is limited to internal HIGH/URGENT escalation using server-configured recipients; it is not a customer-facing email agent.
