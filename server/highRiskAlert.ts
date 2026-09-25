import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallAnalysis } from "../src/shared/calls.js";
import { CallNotificationRowSchema, HIGH_RISK_ALERT_TYPE } from "../src/shared/notifications.js";
import {
  buildHighRiskAlertEmail,
  parseHighRiskAlertRecipients,
  shouldSendHighRiskAlert,
  type BrevoSendResult,
  type HighRiskAlertEmail,
} from "./brevoService.js";

export type HighRiskAlertContext = {
  callId: string;
  callerName: string | null;
  linkedCustomerName: string | null;
  analysis: CallAnalysis;
  deterministicAction: { title: string; reason: string; requiresApproval: boolean } | null;
};

export type HighRiskAlertSender = {
  send(input: { recipient: string; message: HighRiskAlertEmail }): Promise<BrevoSendResult>;
};

export type HighRiskAlertDispatcher = {
  hasConfiguredRecipients?: boolean;
  dispatch(context: HighRiskAlertContext): Promise<void>;
};

export function createHighRiskAlertDispatcher(dependencies: {
  supabase: SupabaseClient;
  recipientConfig: string | undefined;
  sender: HighRiskAlertSender;
  appUrl?: string;
  logger?: Pick<Console, "error">;
}): HighRiskAlertDispatcher {
  const recipients = parseHighRiskAlertRecipients(dependencies.recipientConfig);
  const appUrl = dependencies.appUrl ?? "https://pestlaunch.onrender.com";
  const logger = dependencies.logger ?? console;

  return {
    hasConfiguredRecipients: recipients.length > 0,
    async dispatch(context) {
      if (!shouldSendHighRiskAlert(context.analysis) || recipients.length === 0) return;

      const deterministicAction = context.deterministicAction;
      const message = buildHighRiskAlertEmail({
        callerName: context.callerName?.trim() || context.linkedCustomerName?.trim() || "Unknown caller",
        callType: context.analysis.callType,
        priority: context.analysis.priority as "HIGH" | "URGENT",
        sentiment: context.analysis.sentiment,
        summary: context.analysis.summary,
        riskSignals: formatRiskSignals(context.analysis),
        evidence: context.analysis.evidence,
        recommendedAction: deterministicAction ? {
          title: deterministicAction.title,
          reason: deterministicAction.reason,
        } : null,
        approvalStatus: deterministicAction?.requiresApproval
          ? "Human approval required"
          : "No approval-gated action applies",
        callId: context.callId,
        appUrl,
      });

      for (const recipient of recipients) {
        const claimResult = await dependencies.supabase
          .from("call_notifications")
          .upsert(
            {
              call_id: context.callId,
              notification_type: HIGH_RISK_ALERT_TYPE,
              recipient,
              provider: "BREVO",
              status: "PENDING",
              provider_message_id: null,
              attempt_count: 1,
              error_message: null,
              sent_at: null,
            },
            {
              onConflict: "call_id,notification_type,recipient",
              ignoreDuplicates: true,
            },
          )
          .select("*")
          .maybeSingle();

        if (claimResult.error) {
          logger.error("High-risk notification claim could not be persisted.");
          throw new Error("The high-risk notification ledger is unavailable.");
        }
        if (!claimResult.data) continue;

        const claimedRow = CallNotificationRowSchema.safeParse(claimResult.data);
        if (!claimedRow.success || claimedRow.data.call_id !== context.callId || claimedRow.data.recipient !== recipient) {
          logger.error("High-risk notification claim failed runtime validation.");
          throw new Error("The high-risk notification ledger could not be validated.");
        }

        let result: BrevoSendResult;
        try {
          result = await dependencies.sender.send({ recipient, message });
        } catch {
          result = {
            status: "FAILED",
            providerMessageId: null,
            errorMessage: "Brevo request failed before an acceptance response.",
          };
        }

        const updated = await dependencies.supabase
          .from("call_notifications")
          .update({
            status: result.status,
            provider_message_id: result.providerMessageId,
            attempt_count: 1,
            error_message: result.errorMessage,
            sent_at: result.status === "SENT" ? new Date().toISOString() : null,
          })
          .eq("id", claimedRow.data.id)
          .eq("status", "PENDING")
          .select("*")
          .maybeSingle();

        if (updated.error || !updated.data || !CallNotificationRowSchema.safeParse(updated.data).success) {
          logger.error("High-risk notification result could not be persisted.");
          throw new Error("The high-risk notification result could not be recorded.");
        }
      }
    },
  };
}

function formatRiskSignals(analysis: CallAnalysis): string[] {
  const labels: Array<[keyof CallAnalysis["signals"], string]> = [
    ["cancellationRisk", "Cancellation risk detected"],
    ["complaint", "Complaint detected"],
    ["collectionsIssue", "Collections issue detected"],
    ["newLead", "New lead detected"],
    ["upsellOpportunity", "Upsell opportunity detected"],
    ["reactivationOpportunity", "Reactivation opportunity detected"],
    ["followUpRequired", "Follow-up required"],
  ];
  return labels.filter(([key]) => analysis.signals[key]).map(([, label]) => label);
}
