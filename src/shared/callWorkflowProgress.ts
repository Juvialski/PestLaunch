import type { AgentActionStatus } from "./actions.js";

export type CallWorkflowStep = {
  label: string;
  complete: boolean;
  active: boolean;
  attention: boolean;
};

type WorkflowProgressInput = {
  hasTranscript: boolean;
  hasIntelligence: boolean;
  isBusy: boolean;
  needsReview: boolean;
  actionStatuses: readonly AgentActionStatus[];
};

export function buildCallWorkflowSteps({
  hasTranscript,
  hasIntelligence,
  isBusy,
  needsReview,
  actionStatuses,
}: WorkflowProgressInput): CallWorkflowStep[] {
  const hasResolvedAction = actionStatuses.some((status) => status === "COMPLETED" || status === "REJECTED");
  const hasPendingAction = actionStatuses.includes("PENDING");
  const hasApprovedAction = actionStatuses.some((status) => status === "APPROVED" || status === "EXECUTING");

  return [
    { label: "Call", complete: true, active: false, attention: false },
    { label: "Transcript", complete: hasTranscript, active: isBusy && !hasTranscript, attention: needsReview && !hasTranscript },
    { label: "AI insights", complete: hasIntelligence, active: isBusy && hasTranscript, attention: needsReview && hasTranscript && !hasIntelligence },
    { label: "Human review", complete: hasResolvedAction, active: hasPendingAction, attention: false },
    { label: "Outcome", complete: actionStatuses.includes("COMPLETED"), active: hasApprovedAction, attention: false },
  ];
}
