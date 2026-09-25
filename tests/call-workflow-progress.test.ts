import assert from "node:assert/strict";
import test from "node:test";
import { buildCallWorkflowSteps, shouldShowProposalAction, type CallWorkflowStep } from "../src/shared/callWorkflowProgress.js";

function step(steps: CallWorkflowStep[], label: string): CallWorkflowStep {
  const result = steps.find((item) => item.label === label);
  assert.ok(result, `Expected a ${label} workflow step.`);
  return result;
}

test("an analyzed call with no saved action does not imply human review is required", () => {
  const steps = buildCallWorkflowSteps({
    hasTranscript: true,
    hasIntelligence: true,
    isBusy: false,
    needsReview: false,
    actionPolicyState: "NO_ACTION_REQUIRED",
  });

  assert.equal(step(steps, "Human review").active, false);
  assert.equal(step(steps, "Human review").complete, false);
  assert.equal(step(steps, "Human review").notRequired, true);
  assert.equal(step(steps, "Outcome").complete, true);
  assert.equal(shouldShowProposalAction("NO_ACTION_REQUIRED"), false);
  assert.equal(shouldShowProposalAction("ACTION_AVAILABLE"), true);
});

test("a pending action marks human review as active", () => {
  const steps = buildCallWorkflowSteps({
    hasTranscript: true,
    hasIntelligence: true,
    isBusy: false,
    needsReview: false,
    actionPolicyState: "PENDING_ACTION",
  });

  assert.equal(step(steps, "Human review").active, true);
  assert.equal(step(steps, "Human review").complete, false);
});

test("a completed action marks the human review and outcome steps complete", () => {
  const steps = buildCallWorkflowSteps({
    hasTranscript: true,
    hasIntelligence: true,
    isBusy: false,
    needsReview: false,
    actionPolicyState: "COMPLETED_ACTION",
  });

  assert.equal(step(steps, "Human review").complete, true);
  assert.equal(step(steps, "Outcome").complete, true);
});

test("an eligible action has not started human review until a proposal is saved", () => {
  const steps = buildCallWorkflowSteps({
    hasTranscript: true,
    hasIntelligence: true,
    isBusy: false,
    needsReview: false,
    actionPolicyState: "ACTION_AVAILABLE",
  });

  assert.equal(step(steps, "Human review").active, false);
  assert.equal(step(steps, "Human review").complete, false);
  assert.equal(step(steps, "Human review").notRequired, false);
});
