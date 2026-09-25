import { z } from "zod";

export const CALL_NOTIFICATION_STATUSES = ["PENDING", "SENT", "FAILED"] as const;
export const HIGH_RISK_ALERT_TYPE = "HIGH_RISK_ALERT" as const;

export const CallNotificationRowSchema = z
  .object({
    id: z.string().uuid(),
    call_id: z.string().uuid(),
    notification_type: z.literal(HIGH_RISK_ALERT_TYPE),
    recipient: z.email().max(320),
    provider: z.literal("BREVO"),
    status: z.enum(CALL_NOTIFICATION_STATUSES),
    provider_message_id: z.string().max(500).nullable(),
    attempt_count: z.number().int().min(0).max(10),
    error_message: z.string().max(1000).nullable(),
    created_at: z.string().min(1),
    sent_at: z.string().min(1).nullable(),
  })
  .strict();

export type CallNotificationRow = z.infer<typeof CallNotificationRowSchema>;
export type CallNotificationSummary = Omit<CallNotificationRow, "recipient">;
export type NotificationPresentationState = "NOT_CONFIGURED" | "NOT_SENT" | "PENDING" | "SENT" | "FAILED" | "PARTIAL";

export function toCallNotificationSummary(row: CallNotificationRow): CallNotificationSummary {
  const { recipient, ...summary } = row;
  void recipient;
  return summary;
}

export function notificationPresentationState(
  notifications: readonly Pick<CallNotificationRow, "status">[],
  hasConfiguredRecipients = false,
): NotificationPresentationState {
  if (notifications.length === 0) return hasConfiguredRecipients ? "NOT_SENT" : "NOT_CONFIGURED";
  if (notifications.some((notification) => notification.status === "PENDING")) return "PENDING";

  const sentCount = notifications.filter((notification) => notification.status === "SENT").length;
  if (sentCount === notifications.length) return "SENT";
  return sentCount > 0 ? "PARTIAL" : "FAILED";
}
