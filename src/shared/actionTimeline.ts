import type { AgentActionRow, DemoCustomer } from "./actions.js";
import type { CallAnalysisRow, CallRecord, CallTranscriptRow } from "./calls.js";
import type { CallNotificationSummary } from "./notifications.js";

export type CallTimelineEvent = {
  label: string;
  occurredAt: string;
  detail?: string;
};

export type CallTimelineSource = {
  call: CallRecord;
  transcript: CallTranscriptRow | null;
  analysis: CallAnalysisRow | null;
  demoCustomer: DemoCustomer | null;
  actions: AgentActionRow[];
  notifications?: CallNotificationSummary[];
};

const COMPLETION_LABELS: Record<AgentActionRow["action_type"], string> = {
  CREATE_RETENTION_FOLLOWUP: "Retention follow-up created",
  CREATE_SALES_FOLLOWUP: "Sales follow-up created",
  CREATE_UPSELL_TASK: "Upsell task created",
  CREATE_COLLECTIONS_FOLLOWUP: "Collections follow-up created",
  CREATE_REACTIVATION_FOLLOWUP: "Reactivation follow-up created",
};

const PROPOSAL_LABELS: Record<AgentActionRow["action_type"], string> = {
  CREATE_RETENTION_FOLLOWUP: "Retention follow-up proposed",
  CREATE_SALES_FOLLOWUP: "Sales follow-up proposed",
  CREATE_UPSELL_TASK: "Upsell task proposed",
  CREATE_COLLECTIONS_FOLLOWUP: "Collections follow-up proposed",
  CREATE_REACTIVATION_FOLLOWUP: "Reactivation follow-up proposed",
};

export function buildCallTimeline(source: CallTimelineSource): CallTimelineEvent[] {
  const events: CallTimelineEvent[] = [];
  addEvent(events, source.call.created_at, "Recording received");

  if (source.transcript) addEvent(events, source.transcript.created_at, "Transcription completed");
  if (source.analysis) {
    addEvent(events, source.analysis.created_at, "Call classified");
    if (source.analysis.analysis_json.signals.cancellationRisk || source.analysis.analysis_json.callType === "CANCELLATION") {
      addEvent(events, source.analysis.created_at, "Cancellation risk detected");
    }
  }

  const notifications = source.notifications ?? [];
  const sentNotifications = notifications.filter((notification) => notification.status === "SENT");
  const failedNotifications = notifications.filter((notification) => notification.status === "FAILED");
  const pendingNotifications = notifications.filter((notification) => notification.status === "PENDING");
  if (sentNotifications.length > 0) {
    const sentAt = sentNotifications.map((notification) => notification.sent_at).filter((value): value is string => Boolean(value)).at(-1);
    addEvent(
      events,
      sentAt,
      "High-risk alert sent",
      sentNotifications.length === 1
        ? "Brevo accepted the escalation email."
        : `Brevo accepted ${sentNotifications.length} escalation emails.`,
    );
  }
  if (failedNotifications.length > 0) {
    addEvent(events, failedNotifications.at(-1)?.created_at, "High-risk alert failed", "The call analysis remains available.");
  }
  if (pendingNotifications.length > 0) {
    addEvent(events, pendingNotifications.at(-1)?.created_at, "High-risk alert pending", "Delivery to configured contacts is pending.");
  }

  for (const action of source.actions) {
    addEvent(events, action.created_at, PROPOSAL_LABELS[action.action_type], `${action.payload_json.priority} priority`);

    const execution = action.payload_json.execution;
    for (const previous of execution?.previousAttempts ?? []) {
      if (previous.outcome === "FAILED") {
        addEvent(events, previous.finishedAt, "Action execution failed", previous.errorMessage);
      }
    }

    if (action.approved_at) addEvent(events, action.approved_at, "Action approved");
    if (action.status === "REJECTED" && action.payload_json.rejection) {
      addEvent(events, action.payload_json.rejection.rejectedAt, "Action rejected");
      addEvent(events, action.payload_json.rejection.rejectedAt, "No business state changed");
    }
    if (action.status === "FAILED") {
      addEvent(events, execution?.failedAt ?? action.approved_at, "Action execution failed", action.error_message ?? execution?.lastError);
    }
    if (action.status === "COMPLETED" && action.executed_at) {
      if (execution?.customerMutation === "HEALTH_AT_RISK") {
        addEvent(events, action.executed_at, "Customer marked AT_RISK", source.demoCustomer?.name);
      }
      if (execution?.customerMutation === "PIPELINE_QUALIFIED") {
        addEvent(events, action.executed_at, "Lead moved to QUALIFIED", source.demoCustomer?.name);
      }
      addEvent(events, action.executed_at, COMPLETION_LABELS[action.action_type]);
    }
  }

  return events
    .map((event, index) => ({ event, index, timestamp: Date.parse(event.occurredAt) }))
    .filter((entry) => Number.isFinite(entry.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
    .map(({ event }) => event);
}

function addEvent(events: CallTimelineEvent[], occurredAt: string | null | undefined, label: string, detail?: string): void {
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) return;
  events.push({ label, occurredAt, ...(detail ? { detail } : {}) });
}
