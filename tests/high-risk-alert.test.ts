import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallAnalysis } from "../src/shared/calls.js";
import type { CallNotificationRow } from "../src/shared/notifications.js";
import { createHighRiskAlertDispatcher, type HighRiskAlertContext } from "../server/highRiskAlert.js";
import type { BrevoSendResult } from "../server/brevoService.js";

const CALL_ID = "91000000-0000-4000-8000-000000000002";

function analysis(priority: CallAnalysis["priority"]): CallAnalysis {
  return {
    callType: "COMPLAINT",
    confidence: 0.96,
    summary: "Repeated late visits have the customer considering cancellation.",
    customerIntent: "The customer wants reliable service and follow-up.",
    sentiment: "NEGATIVE",
    outcome: "FOLLOW_UP_REQUIRED",
    signals: {
      newLead: false,
      complaint: true,
      cancellationRisk: true,
      upsellOpportunity: false,
      reactivationOpportunity: false,
      collectionsIssue: false,
      followUpRequired: true,
    },
    priority,
    evidence: [
      { speaker: "Customer", quote: "Your technicians have been late three times." },
      { speaker: "Customer", quote: "I am thinking about cancelling." },
    ],
    recommendedAction: null,
  };
}

function context(priority: CallAnalysis["priority"]): HighRiskAlertContext {
  return {
    callId: CALL_ID,
    callerName: null,
    linkedCustomerName: "Jordan Example",
    analysis: analysis(priority),
    deterministicAction: {
      title: "Create retention follow-up",
      reason: "Cancellation risk was detected.",
      requiresApproval: true,
    },
  };
}

function createNotificationLedger() {
  const rows: CallNotificationRow[] = [];
  let nextId = 1;

  class Query {
    private readonly filters: Record<string, unknown> = {};

    constructor(
      private readonly operation: "upsert" | "update",
      private readonly values: Record<string, unknown>,
      private readonly options?: { onConflict?: string; ignoreDuplicates?: boolean },
    ) {}

    select() { return this; }
    eq(column: string, value: unknown) { this.filters[column] = value; return this; }
    async maybeSingle() { return this.execute(); }
    async single() { return this.execute(); }

    private async execute() {
      if (this.operation === "upsert") {
        const existing = rows.find((row) =>
          row.call_id === this.values.call_id &&
          row.notification_type === this.values.notification_type &&
          row.recipient === this.values.recipient,
        );
        if (existing && this.options?.ignoreDuplicates) return { data: null, error: null };
        if (existing) return { data: null, error: { message: "Unexpected duplicate upsert." } };
        const row = {
          id: `91000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
          created_at: "2026-09-25T00:00:00.000Z",
          sent_at: null,
          provider_message_id: null,
          error_message: null,
          attempt_count: 0,
          ...this.values,
        } as unknown as CallNotificationRow;
        rows.push(row);
        return { data: { ...row }, error: null };
      }

      const row = rows.find((candidate) => Object.entries(this.filters).every(([key, value]) => candidate[key as keyof CallNotificationRow] === value));
      if (!row) return { data: null, error: null };
      Object.assign(row, this.values);
      return { data: { ...row }, error: null };
    }
  }

  const supabase = {
    from() {
      return {
        upsert(values: Record<string, unknown>, options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          return new Query("upsert", values, options);
        },
        update(values: Record<string, unknown>) {
          return new Query("update", values);
        },
      };
    },
  } as unknown as SupabaseClient;

  return { supabase, rows };
}

test("each configured recipient receives at most one high-risk alert across repeated dispatch", async () => {
  const ledger = createNotificationLedger();
  const sentTo: string[] = [];
  const dispatcher = createHighRiskAlertDispatcher({
    supabase: ledger.supabase,
    recipientConfig: " Ops@Company.com,manager@example.org,ops@company.com ",
    sender: {
      async send({ recipient }): Promise<BrevoSendResult> {
        sentTo.push(recipient);
        return { status: "SENT", providerMessageId: `message-${sentTo.length}`, errorMessage: null };
      },
    },
    logger: { error: () => undefined },
  });

  await dispatcher.dispatch(context("HIGH"));
  await dispatcher.dispatch(context("HIGH"));

  assert.deepEqual(sentTo, ["ops@company.com", "manager@example.org"]);
  assert.equal(ledger.rows.length, 2);
  assert.deepEqual(ledger.rows.map((row) => row.status), ["SENT", "SENT"]);
  assert.deepEqual(ledger.rows.map((row) => row.provider_message_id), ["message-1", "message-2"]);
  assert.deepEqual(ledger.rows.map((row) => row.attempt_count), [1, 1]);
});

test("LOW and MEDIUM analysis creates no notification or send even with recipients configured", async () => {
  const ledger = createNotificationLedger();
  let sends = 0;
  const dispatcher = createHighRiskAlertDispatcher({
    supabase: ledger.supabase,
    recipientConfig: "manager@example.org",
    sender: { async send() { sends += 1; return { status: "SENT", providerMessageId: "unexpected", errorMessage: null }; } },
    logger: { error: () => undefined },
  });

  await dispatcher.dispatch(context("LOW"));
  await dispatcher.dispatch(context("MEDIUM"));

  assert.equal(sends, 0);
  assert.deepEqual(ledger.rows, []);
});

test("missing and invalid recipient configuration skips URGENT delivery safely", async () => {
  const ledger = createNotificationLedger();
  let sends = 0;
  const sender = { async send() { sends += 1; return { status: "SENT" as const, providerMessageId: "unexpected", errorMessage: null }; } };
  const missingRecipients = createHighRiskAlertDispatcher({
    supabase: ledger.supabase,
    recipientConfig: undefined,
    sender,
    logger: { error: () => undefined },
  });
  const invalidRecipients = createHighRiskAlertDispatcher({
    supabase: ledger.supabase,
    recipientConfig: "broken-address, ,",
    sender,
    logger: { error: () => undefined },
  });

  await missingRecipients.dispatch(context("URGENT"));
  await invalidRecipients.dispatch(context("URGENT"));

  assert.equal(sends, 0);
  assert.deepEqual(ledger.rows, []);
});

test("provider rejection is persisted as FAILED without retrying or throwing", async () => {
  const ledger = createNotificationLedger();
  let sends = 0;
  const dispatcher = createHighRiskAlertDispatcher({
    supabase: ledger.supabase,
    recipientConfig: "manager@example.org",
    sender: {
      async send(): Promise<BrevoSendResult> {
        sends += 1;
        return { status: "FAILED", providerMessageId: null, errorMessage: "Brevo returned HTTP 503." };
      },
    },
    logger: { error: () => undefined },
  });

  await dispatcher.dispatch(context("URGENT"));
  await dispatcher.dispatch(context("URGENT"));

  assert.equal(sends, 1);
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0]?.status, "FAILED");
  assert.equal(ledger.rows[0]?.error_message, "Brevo returned HTTP 503.");
  assert.equal(ledger.rows[0]?.attempt_count, 1);
});
