import type { CallActionPolicyState } from "./actions.js";

export type CallWorkflowStep = {
  label: string;
  complete: boolean;
  active: boolean;
  attention: boolean;
  notRequired?: boolean;
};

type WorkflowProgressInput = {
  hasTranscript: boolean;
  hasIntelligence: boolean;
  isBusy: boolean;
  needsReview: boolean;
  actionPolicyState: CallActionPolicyState;
};

export function buildCallWorkflowSteps({
  hasTranscript,
  hasIntelligence,
  isBusy,
  needsReview,
  actionPolicyState,
}: WorkflowProgressInput): CallWorkflowStep[] {
  const reviewComplete = [
    "APPROVED_ACTION",
    "EXECUTING_ACTION",
    "COMPLETED_ACTION",
    "REJECTED_ACTION",
    "FAILED_ACTION",
  ].includes(actionPolicyState);
  const actionInProgress = actionPolicyState === "APPROVED_ACTION" || actionPolicyState === "EXECUTING_ACTION";
  const noActionRequired = actionPolicyState === "NO_ACTION_REQUIRED";

  return [
    { label: "Call", complete: true, active: false, attention: false },
    { label: "Transcript", complete: hasTranscript, active: isBusy && !hasTranscript, attention: needsReview && !hasTranscript },
    { label: "AI insights", complete: hasIntelligence, active: isBusy && hasTranscript, attention: needsReview && hasTranscript && !hasIntelligence },
    {
      label: "Human review",
      complete: reviewComplete,
      active: actionPolicyState === "PENDING_ACTION",
      attention: false,
      notRequired: noActionRequired,
    },
    {
      label: "Outcome",
      complete: actionPolicyState === "COMPLETED_ACTION" || noActionRequired,
      active: actionInProgress,
      attention: actionPolicyState === "FAILED_ACTION",
    },
  ];
}

export function shouldShowProposalAction(actionPolicyState: CallActionPolicyState): boolean {
  return actionPolicyState === "ACTION_AVAILABLE";
}
