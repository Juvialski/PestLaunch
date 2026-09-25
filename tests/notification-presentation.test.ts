import assert from "node:assert/strict";
import test from "node:test";
import {
  notificationPresentationState,
  toCallNotificationSummary,
  type CallNotificationRow,
} from "../src/shared/notifications.js";

function notification(overrides: Partial<CallNotificationRow> = {}): CallNotificationRow {
  return {
    id: "91000000-0000-4000-8000-000000000001",
    call_id: "91000000-0000-4000-8000-000000000002",
    notification_type: "HIGH_RISK_ALERT",
    recipient: "manager@example.com",
    provider: "BREVO",
    status: "SENT",
    provider_message_id: "<provider-message>",
    attempt_count: 1,
    error_message: null,
    created_at: "2026-09-25T00:00:00.000Z",
    sent_at: "2026-09-25T00:00:02.000Z",
    ...overrides,
  };
}

test("high-risk notification presentation distinguishes unconfigured, pending, sent, failed, and partial states", () => {
  assert.equal(notificationPresentationState([]), "NOT_CONFIGURED");
  assert.equal(notificationPresentationState([], true), "NOT_SENT");
  assert.equal(notificationPresentationState([notification({ status: "PENDING", sent_at: null, provider_message_id: null })]), "PENDING");
  assert.equal(notificationPresentationState([notification()]), "SENT");
  assert.equal(notificationPresentationState([notification({ status: "FAILED", sent_at: null, provider_message_id: null })]), "FAILED");
  assert.equal(
    notificationPresentationState([
      notification(),
      notification({ id: "91000000-0000-4000-8000-000000000003", recipient: "other@example.com", status: "FAILED", sent_at: null }),
    ]),
    "PARTIAL",
  );
});

test("notification summaries do not include configured recipient addresses", () => {
  const summary = toCallNotificationSummary(notification());

  assert.equal(summary.status, "SENT");
  assert.equal(Object.hasOwn(summary, "recipient"), false);
  assert.equal(JSON.stringify(summary).includes("manager@example.com"), false);
});
