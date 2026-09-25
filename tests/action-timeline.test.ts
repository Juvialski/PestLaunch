import assert from "node:assert/strict";
import test from "node:test";
import type { CallAnalysisRow, CallRecord, CallTranscriptRow } from "../src/shared/calls.js";
import type { AgentActionRow, DemoCustomer } from "../src/shared/actions.js";
import { buildCallTimeline } from "../src/shared/actionTimeline.js";
import { DEMO_CUSTOMER_IDS } from "../server/demoFixtures.js";

const CALL_ID = "3dd5d1a6-8118-43e4-b340-206825622cff";

const call: CallRecord = {
  id: CALL_ID,
  caller_name: "Jordan Example",
  demo_customer_id: DEMO_CUSTOMER_IDS.retention,
  original_filename: "synthetic-retention.mp3",
  mime_type: "audio/mpeg",
  status: "ANALYZED",
  duration: null,
  created_at: "2026-09-25T00:00:00.000Z",
  updated_at: "2026-09-25T00:03:00.000Z",
  audio_path: `calls/${CALL_ID}.mp3`,
  last_error: null,
};

const transcript: CallTranscriptRow = {
  id: "c0000000-0000-4000-8000-000000000001",
  call_id: CALL_ID,
  text: "Your technicians have been late twice. I am considering cancelling.",
  segments_json: [],
  model_used: "gemini-3.5-transcribe",
  attempt_count: 1,
  created_at: "2026-09-25T00:01:00.000Z",
};

const analysis: CallAnalysisRow = {
  id: "c0000000-0000-4000-8000-000000000002",
  call_id: CALL_ID,
  call_type: "COMPLAINT",
  confidence: 0.96,
  summary: "Repeated late visits put the relationship at risk.",
  analysis_json: {
    callType: "COMPLAINT",
    confidence: 0.96,
    summary: "Repeated late visits put the relationship at risk.",
    customerIntent: "The customer is considering cancellation.",
    sentiment: "NEGATIVE",
    outcome: "FOLLOW_UP_REQUIRED",
    signals: {
      newLead: false,
      complaint: true,
      cancellationRisk: true,
      upsellOpportunity: false,
      reactivationOpportunity: false,
      collectionsIssue: false,
      followUpRequired: true,
    },
    priority: "HIGH",
    evidence: [{ quote: "Your technicians have been late twice." }],
    recommendedAction: null,
  },
  model_used: "gemini-3.8-flash",
  created_at: "2026-09-25T00:02:00.000Z",
};

const customer: DemoCustomer = {
  id: DEMO_CUSTOMER_IDS.retention,
  name: "Jordan Example (Synthetic Retention Customer)",
  customer_type: "EXISTING_CUSTOMER",
  pipeline_stage: "WON",
  health_status: "AT_RISK",
  assigned_to: null,
  created_at: "2026-09-25T00:00:00.000Z",
  updated_at: "2026-09-25T00:03:00.000Z",
};

function action(overrides: Partial<AgentActionRow> = {}): AgentActionRow {
  return {
    id: "d0000000-0000-4000-8000-000000000001",
    call_id: CALL_ID,
    action_type: "CREATE_RETENTION_FOLLOWUP",
    payload_json: {
      version: 1,
      actionType: "CREATE_RETENTION_FOLLOWUP",
      title: "Create retention follow-up",
      reason: "P2 detected cancellation risk.",
      priority: "HIGH",
      requiresApproval: true,
      targetDemoCustomerId: DEMO_CUSTOMER_IDS.retention,
      expectedChanges: { customer: { healthStatus: "AT_RISK" } },
    },
    status: "PENDING",
    requires_approval: true,
    error_message: null,
    created_at: "2026-09-25T00:02:30.000Z",
    approved_at: null,
    executed_at: null,
    ...overrides,
  };
}

test("timeline derives the complete approved retention sequence from saved timestamps and action state", () => {
  const completed = action({
    status: "COMPLETED",
    approved_at: "2026-09-25T00:03:00.000Z",
    executed_at: "2026-09-25T00:04:00.000Z",
    payload_json: {
      ...action().payload_json,
      execution: {
        startedAt: "2026-09-25T00:03:30.000Z",
        completedAt: "2026-09-25T00:04:00.000Z",
        attemptCount: 1,
        customerMutation: "HEALTH_AT_RISK",
        result: "Retention follow-up created; synthetic customer health marked AT_RISK.",
      },
    },
  });

  const entries = buildCallTimeline({
    call,
    transcript,
    analysis,
    demoCustomer: { ...customer, health_status: "HEALTHY" },
    actions: [completed],
  });

  assert.deepEqual(entries.map((entry) => entry.label), [
    "Recording received",
    "Transcription completed",
    "Call classified",
    "Cancellation risk detected",
    "Retention follow-up proposed",
    "Action approved",
    "Customer marked AT_RISK",
    "Retention follow-up created",
  ]);
  assert.equal(entries[0]?.occurredAt, call.created_at);
  assert.equal(entries.at(-1)?.occurredAt, completed.executed_at);
});

test("rejected actions show no business-state mutation in the persisted timeline", () => {
  const rejected = action({
    status: "REJECTED",
    payload_json: {
      ...action().payload_json,
      rejection: { rejectedAt: "2026-09-25T00:03:00.000Z" },
    },
  });

  const entries = buildCallTimeline({ call, transcript, analysis, demoCustomer: { ...customer, health_status: "HEALTHY" }, actions: [rejected] });

  assert.deepEqual(entries.slice(-3).map((entry) => entry.label), [
    "Retention follow-up proposed",
    "Action rejected",
    "No business state changed",
  ]);
  assert.equal(entries.some((entry) => entry.label === "Customer marked AT_RISK"), false);
});

test("timeline retains an earlier failed attempt after a safe retry completes", () => {
  const retried = action({
    status: "COMPLETED",
    approved_at: "2026-09-25T00:03:00.000Z",
    executed_at: "2026-09-25T00:05:00.000Z",
    payload_json: {
      ...action().payload_json,
      execution: {
        startedAt: "2026-09-25T00:04:30.000Z",
        completedAt: "2026-09-25T00:05:00.000Z",
        attemptCount: 2,
        customerMutation: "HEALTH_AT_RISK",
        result: "Retention follow-up created; synthetic customer health marked AT_RISK.",
        previousAttempts: [{
          startedAt: "2026-09-25T00:03:30.000Z",
          finishedAt: "2026-09-25T00:04:00.000Z",
          outcome: "FAILED",
          errorMessage: "The synthetic customer update failed.",
        }],
      },
    },
  });

  const entries = buildCallTimeline({ call, transcript, analysis, demoCustomer: customer, actions: [retried] });

  assert.ok(entries.some((entry) => entry.label === "Action execution failed" && entry.occurredAt === "2026-09-25T00:04:00.000Z"));
  assert.ok(entries.some((entry) => entry.label === "Retention follow-up created" && entry.occurredAt === "2026-09-25T00:05:00.000Z"));
});
