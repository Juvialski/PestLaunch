import type { CallAnalysis } from "../src/shared/calls.js";
import {
  AgentActionPayloadSchema,
  DEMO_CUSTOMER_IDS,
  type AgentActionPayload,
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

function buildProposal(
  proposal: Omit<AgentActionPayload, "version" | "requiresApproval">,
): AgentActionPayload {
  return AgentActionPayloadSchema.parse({
    version: 1,
    ...proposal,
    requiresApproval: true,
  });
}
