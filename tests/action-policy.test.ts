import assert from "node:assert/strict";
import test from "node:test";
import type { CallAnalysis } from "../src/shared/calls.js";
import {
  AgentActionPayloadSchema,
  AgentActionRowSchema,
  type AgentActionStatus,
  type DemoCustomer,
} from "../src/shared/actions.js";
import { deriveCallActionPolicyState, proposeDeterministicAction } from "../server/actionPolicy.js";

const RETENTION_CUSTOMER_ID = "a1000000-0000-4000-8000-000000000001";
const TERMITE_LEAD_ID = "a1000000-0000-4000-8000-000000000002";
const UPSELL_CUSTOMER_ID = "a1000000-0000-4000-8000-000000000003";
const CALL_ID = "3dd5d1a6-8118-43e4-b340-206825622cff";
const NOW = "2026-09-25T00:00:00.000Z";

function analysis(overrides: Partial<CallAnalysis> = {}): CallAnalysis {
  return {
    callType: "OTHER",
    confidence: 0.94,
    summary: "A synthetic demo call.",
    customerIntent: "The caller asks a question.",
    sentiment: "NEUTRAL",
    outcome: "UNKNOWN",
    signals: {
      newLead: false,
      complaint: false,
      cancellationRisk: false,
      upsellOpportunity: false,
      reactivationOpportunity: false,
      collectionsIssue: false,
      followUpRequired: false,
    },
    priority: "MEDIUM",
    evidence: [{ quote: "A synthetic demo call." }],
    recommendedAction: { type: "MODEL_COMMAND", reason: "untrusted model text", requiresApproval: false },
    ...overrides,
  };
}

function demoCustomer(id: string, customerType: string): DemoCustomer {
  return {
    id,
    name: "Synthetic demo record",
    customer_type: customerType,
    pipeline_stage: customerType === "LEAD" ? "NEW" : "WON",
    health_status: "HEALTHY",
    assigned_to: null,
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
  };
}

function savedAction(status: AgentActionStatus) {
  const customer = demoCustomer(RETENTION_CUSTOMER_ID, "EXISTING_CUSTOMER");
  const payload = proposeDeterministicAction(analysis({ callType: "CANCELLATION" }), customer);
  assert.ok(payload);
  const payloadJson = status === "REJECTED"
    ? { ...payload, rejection: { rejectedAt: NOW } }
    : status === "COMPLETED"
      ? { ...payload, execution: { startedAt: NOW, completedAt: NOW, result: "Retention follow-up created." } }
      : payload;
  return AgentActionRowSchema.parse({
    id: "a2000000-0000-4000-8000-000000000001",
    call_id: CALL_ID,
    action_type: payload.actionType,
    payload_json: payloadJson,
    status,
    requires_approval: true,
    error_message: null,
    created_at: NOW,
    approved_at: status === "COMPLETED" ? NOW : null,
    executed_at: status === "COMPLETED" ? NOW : null,
  });
}

test("cancellation risk wins policy precedence and cannot be overridden by the model action name", () => {
  const proposed = proposeDeterministicAction(
    analysis({
      callType: "COMPLAINT",
      priority: "LOW",
      signals: {
        newLead: true,
        complaint: true,
        cancellationRisk: true,
        upsellOpportunity: true,
        reactivationOpportunity: true,
        collectionsIssue: true,
        followUpRequired: true,
      },
    }),
    demoCustomer(RETENTION_CUSTOMER_ID, "EXISTING_CUSTOMER"),
  );

  assert.ok(proposed);
  assert.equal(proposed.actionType, "CREATE_RETENTION_FOLLOWUP");
  assert.equal(proposed.priority, "HIGH");
  assert.equal(proposed.requiresApproval, true);
  assert.equal(proposed.targetDemoCustomerId, RETENTION_CUSTOMER_ID);
  assert.deepEqual(proposed.expectedChanges, { customer: { healthStatus: "AT_RISK" } });
  assert.match(proposed.reason, /cancellation/i);
});

test("cancellation call type proposes retention even when the cancellation signal is false", () => {
  const proposed = proposeDeterministicAction(
    analysis({ callType: "CANCELLATION" }),
    demoCustomer(RETENTION_CUSTOMER_ID, "EXISTING_CUSTOMER"),
  );

  assert.equal(proposed?.actionType, "CREATE_RETENTION_FOLLOWUP");
  assert.deepEqual(proposed?.expectedChanges, { customer: { healthStatus: "AT_RISK" } });
});

test("collections takes precedence over new-lead, reactivation, and upsell signals", () => {
  const proposed = proposeDeterministicAction(analysis({
    signals: {
      newLead: true,
      complaint: false,
      cancellationRisk: false,
      upsellOpportunity: true,
      reactivationOpportunity: true,
      collectionsIssue: true,
      followUpRequired: true,
    },
  }));

  assert.equal(proposed?.actionType, "CREATE_COLLECTIONS_FOLLOWUP");
  assert.equal(proposed?.requiresApproval, true);
});

test("collections call type is enough for a deterministic collections follow-up", () => {
  const proposed = proposeDeterministicAction(analysis({ callType: "COLLECTIONS" }));

  assert.equal(proposed?.actionType, "CREATE_COLLECTIONS_FOLLOWUP");
});

test("a new lead needing follow-up proposes sales follow-up and only qualifies the fixed termite lead", () => {
  const proposed = proposeDeterministicAction(
    analysis({
      callType: "NEW_LEAD",
      signals: { ...analysis().signals, newLead: true, followUpRequired: true },
    }),
    demoCustomer(TERMITE_LEAD_ID, "LEAD"),
  );

  assert.equal(proposed?.actionType, "CREATE_SALES_FOLLOWUP");
  assert.deepEqual(proposed?.expectedChanges, { customer: { pipelineStage: "QUALIFIED" } });
});

test("new-lead analysis without required follow-up does not create an action", () => {
  const proposed = proposeDeterministicAction(analysis({
    callType: "NEW_LEAD",
    signals: { ...analysis().signals, newLead: true },
  }));

  assert.equal(proposed, null);
});

test("reactivation takes precedence over upsell and never manufactures a customer field change", () => {
  const proposed = proposeDeterministicAction(analysis({
    signals: {
      newLead: false,
      complaint: false,
      cancellationRisk: false,
      upsellOpportunity: true,
      reactivationOpportunity: true,
      collectionsIssue: false,
      followUpRequired: false,
    },
  }));

  assert.equal(proposed?.actionType, "CREATE_REACTIVATION_FOLLOWUP");
  assert.deepEqual(proposed?.expectedChanges, {});
});

test("reactivation call type is enough for a deterministic reactivation follow-up", () => {
  const proposed = proposeDeterministicAction(analysis({ callType: "REACTIVATION" }));

  assert.equal(proposed?.actionType, "CREATE_REACTIVATION_FOLLOWUP");
});

test("upsell signal proposes the allowlisted task", () => {
  const proposed = proposeDeterministicAction(
    analysis({ signals: { ...analysis().signals, upsellOpportunity: true } }),
    demoCustomer(UPSELL_CUSTOMER_ID, "EXISTING_CUSTOMER"),
  );

  assert.equal(proposed?.actionType, "CREATE_UPSELL_TASK");
  assert.deepEqual(proposed?.expectedChanges, {});
});

test("irrelevant analysis returns no executable action", () => {
  assert.equal(proposeDeterministicAction(analysis()), null);
});

test("derived policy state distinguishes an available action from a completed no-action result", () => {
  const eligible = analysis({ callType: "CANCELLATION" });
  const resolvedBooking = analysis({
    callType: "BOOKING",
    outcome: "RESOLVED",
    priority: "LOW",
    signals: { ...analysis().signals, newLead: true },
  });

  assert.equal(deriveCallActionPolicyState(eligible, demoCustomer(RETENTION_CUSTOMER_ID, "EXISTING_CUSTOMER"), []), "ACTION_AVAILABLE");
  assert.equal(deriveCallActionPolicyState(resolvedBooking, null, []), "NO_ACTION_REQUIRED");
  assert.equal(deriveCallActionPolicyState(null, null, []), "NOT_READY");
});

test("derived policy state preserves the persisted pending, completed, and rejected action lifecycle", () => {
  const eligible = analysis({ callType: "CANCELLATION" });
  const customer = demoCustomer(RETENTION_CUSTOMER_ID, "EXISTING_CUSTOMER");

  assert.equal(deriveCallActionPolicyState(eligible, customer, [savedAction("PENDING")]), "PENDING_ACTION");
  assert.equal(deriveCallActionPolicyState(eligible, customer, [savedAction("COMPLETED")]), "COMPLETED_ACTION");
  assert.equal(deriveCallActionPolicyState(eligible, customer, [savedAction("REJECTED")]), "REJECTED_ACTION");
});

test("action payload schema rejects arbitrary action names, patches, and approval bypasses", () => {
  const payload = proposeDeterministicAction(analysis());
  assert.equal(payload, null);

  const safeShape = {
    version: 1,
    actionType: "CREATE_RETENTION_FOLLOWUP",
    title: "Retention follow-up",
    reason: "Cancellation risk detected.",
    priority: "HIGH",
    requiresApproval: true,
    targetDemoCustomerId: RETENTION_CUSTOMER_ID,
    expectedChanges: { customer: { healthStatus: "AT_RISK" } },
  };

  assert.equal(AgentActionPayloadSchema.safeParse(safeShape).success, true);
  assert.equal(AgentActionPayloadSchema.safeParse({ ...safeShape, actionType: "MODEL_COMMAND" }).success, false);
  assert.equal(AgentActionPayloadSchema.safeParse({ ...safeShape, requiresApproval: false }).success, false);
  assert.equal(
    AgentActionPayloadSchema.safeParse({ ...safeShape, expectedChanges: { customer: { admin: true } } }).success,
    false,
  );
  assert.equal(
    AgentActionPayloadSchema.safeParse({ ...safeShape, targetDemoCustomerId: UPSELL_CUSTOMER_ID }).success,
    false,
  );
  assert.equal(
    AgentActionPayloadSchema.safeParse({ ...safeShape, actionType: "CREATE_UPSELL_TASK" }).success,
    false,
  );
});
