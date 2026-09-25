import type { CallAnalysis } from "../src/shared/calls.js";
import {
  AgentActionPayloadSchema,
  DEMO_CUSTOMER_IDS,
  type AgentActionPayload,
  type AgentActionRow,
  type CallActionPolicyState,
  type DemoCustomer,
} from "../src/shared/actions.js";

export function proposeDeterministicAction(
  analysis: CallAnalysis,
  customer: DemoCustomer | null = null,
): AgentActionPayload | null {
  const targetDemoCustomerId = customer?.id ?? null;
  const expectedChanges: AgentActionPayload["expectedChanges"] = {};

  if (analysis.signals.cancellationRisk || analysis.callType === "CANCELLATION") {
    if (customer?.id === DEMO_CUSTOMER_IDS.retention) {
      expectedChanges.customer = { healthStatus: "AT_RISK" };
    }
    return buildProposal({
      actionType: "CREATE_RETENTION_FOLLOWUP",
      title: "Create retention follow-up",
      reason: "P2 detected cancellation risk or classified this call as a cancellation.",
      priority: "HIGH",
      targetDemoCustomerId,
      expectedChanges,
    });
  }

  if (analysis.signals.collectionsIssue || analysis.callType === "COLLECTIONS") {
    return buildProposal({
      actionType: "CREATE_COLLECTIONS_FOLLOWUP",
      title: "Create collections follow-up",
      reason: "P2 detected a collections issue that needs a follow-up task.",
      priority: analysis.priority,
      targetDemoCustomerId,
      expectedChanges,
    });
  }

  if ((analysis.signals.newLead || analysis.callType === "NEW_LEAD") && analysis.signals.followUpRequired) {
    if (customer?.id === DEMO_CUSTOMER_IDS.termiteLead) {
      expectedChanges.customer = { pipelineStage: "QUALIFIED" };
    }
    return buildProposal({
      actionType: "CREATE_SALES_FOLLOWUP",
      title: "Create sales follow-up",
      reason: "P2 detected a new lead that requires follow-up.",
      priority: analysis.priority,
      targetDemoCustomerId,
      expectedChanges,
    });
  }

  if (analysis.signals.reactivationOpportunity || analysis.callType === "REACTIVATION") {
    return buildProposal({
      actionType: "CREATE_REACTIVATION_FOLLOWUP",
      title: "Create reactivation follow-up",
      reason: "P2 detected a reactivation opportunity.",
      priority: analysis.priority,
      targetDemoCustomerId,
      expectedChanges,
    });
  }

  if (analysis.signals.upsellOpportunity) {
    return buildProposal({
      actionType: "CREATE_UPSELL_TASK",
      title: "Create upsell task",
      reason: "P2 detected an upsell opportunity.",
      priority: analysis.priority,
      targetDemoCustomerId,
      expectedChanges,
    });
  }

  return null;
}

export function deriveCallActionPolicyState(
  analysis: CallAnalysis | null,
  customer: DemoCustomer | null,
  actions: readonly AgentActionRow[],
): CallActionPolicyState {
  const savedAction = actions.at(-1);
  if (savedAction) {
    switch (savedAction.status) {
      case "PENDING": return "PENDING_ACTION";
      case "APPROVED": return "APPROVED_ACTION";
      case "EXECUTING": return "EXECUTING_ACTION";
      case "COMPLETED": return "COMPLETED_ACTION";
      case "REJECTED": return "REJECTED_ACTION";
      case "FAILED": return "FAILED_ACTION";
    }
  }

  if (!analysis) return "NOT_READY";
  return proposeDeterministicAction(analysis, customer) ? "ACTION_AVAILABLE" : "NO_ACTION_REQUIRED";
}

function buildProposal(
  proposal: Omit<AgentActionPayload, "version" | "requiresApproval">,
): AgentActionPayload {
  return AgentActionPayloadSchema.parse({
    version: 1,
    ...proposal,
    requiresApproval: true,
  });
}
