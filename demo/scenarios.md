# Synthetic interview scenarios

All three WAV recordings in `recordings/` were generated locally from these scripts with the installed Windows speech synthesizer. They contain synthetic dialogue only; no customer recordings or cloud speech service were used.

For each rehearsal, reset the fixed demo customers, upload a fresh copy of the recording, select the matching synthetic customer, process once, then review the deterministic proposal before deciding whether to approve or reject it. Existing calls and actions remain as audit history.

## Retention — primary

Recording: `recordings/retention-risk.wav`

Customer: Jordan Example (Synthetic Retention Customer)

> Hi, this is Jordan. I'm calling about my pest control service. The technicians have been late several times over the last few visits. I planned my day around the appointment windows, but they arrived well after the agreed time. I'm frustrated because this keeps happening. If it happens again, I'm considering cancelling my service. Could someone please follow up and tell me how you'll make sure the next visit is on time?

Expected: `COMPLAINT` or `CANCELLATION`, cancellation risk true, high priority, and a deterministic `CREATE_RETENTION_FOLLOWUP` proposal. Approval changes the fixed retention customer's health from `HEALTHY` to `AT_RISK` and completes the follow-up action.

## Termite lead

Recording: `recordings/termite-lead.wav`

Customer: Taylor Example (Synthetic Termite Lead)

> Hi, I'm looking into termite treatment for a house I'm buying. Do you inspect and treat active termite problems? Could you tell me the price for treatment and whether an inspection costs extra? I'm comparing a few options and I'm not ready to book an appointment yet. Please have someone follow up with pricing and availability.

Expected: `NEW_LEAD`, follow-up required, and a deterministic `CREATE_SALES_FOLLOWUP` proposal. Approval may move the fixed lead from `NEW` to `QUALIFIED`.

## Mosquito upsell

Recording: `recordings/mosquito-upsell.wav`

Customer: Morgan Example (Synthetic Mosquito Customer)

> Hi, this is Morgan. We already have your regular pest control service. I wanted to ask whether you also offer mosquito treatment for the yard. Could someone tell me what options are available? I'm interested, but I'm not asking to book today.

Expected: upsell opportunity true and a deterministic `CREATE_UPSELL_TASK` proposal. The completed action represents the task; no customer fields need to change.
