import assert from "node:assert/strict";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";
import test from "node:test";
import type { CallAnalysis, CallAnalysisRow, CallRecord, CallTranscriptRow } from "../src/shared/calls.js";
import type { AgentActionRow, DemoCustomer } from "../src/shared/actions.js";
import { createActionsRouter } from "../server/actionsRouter.js";
import { createCallsRouter } from "../server/callsRouter.js";
import { DEMO_CUSTOMER_IDS, DEMO_CUSTOMERS } from "../server/demoFixtures.js";

const CALL_ID = "3dd5d1a6-8118-43e4-b340-206825622cff";
const OTHER_CUSTOMER_ID = "a1000000-0000-4000-8000-000000000004";
const NOW = "2026-09-25T00:00:00.000Z";

type FakeState = {
  calls: CallRecord[];
  transcripts: CallTranscriptRow[];
  analyses: CallAnalysisRow[];
  actions: AgentActionRow[];
  notifications: Record<string, unknown>[];
  customers: DemoCustomer[];
  customerMutations: number;
  failCustomerUpdates: number;
};

type DbError = { code?: string; message: string };
type DbResult = { data: unknown; error: DbError | null };
type Filter = { column: string; value: unknown; kind: "eq" | "in" };

function callRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    id: CALL_ID,
    caller_name: "Jordan Example",
    demo_customer_id: DEMO_CUSTOMER_IDS.retention,
    original_filename: "synthetic-retention.mp3",
    mime_type: "audio/mpeg",
    status: "ANALYZED",
    duration: null,
    created_at: NOW,
    updated_at: NOW,
    audio_path: `calls/${CALL_ID}.mp3`,
    last_error: null,
    ...overrides,
  };
}

function analysis(overrides: Partial<CallAnalysis> = {}): CallAnalysis {
  return {
    callType: "COMPLAINT",
    confidence: 0.96,
    summary: "The synthetic customer reports repeated late visits.",
    customerIntent: "The customer is considering cancellation.",
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
    priority: "HIGH",
    evidence: [{ quote: "Your technicians have been late twice." }],
    recommendedAction: { type: "MODEL_COMMAND", reason: "untrusted", requiresApproval: false },
    ...overrides,
  };
}

function analysisRow(value = analysis()): CallAnalysisRow {
  return {
    id: "analysis-row",
    call_id: CALL_ID,
    call_type: value.callType,
    confidence: value.confidence,
    summary: value.summary,
    analysis_json: value,
    model_used: "gemini-3.8-flash",
    created_at: NOW,
  };
}

function transcriptRow(): CallTranscriptRow {
  return {
    id: "transcript-row",
    call_id: CALL_ID,
    text: "Your technicians have been late twice. I am considering cancelling.",
    segments_json: [{ speaker: "Caller", text: "Your technicians have been late twice." }],
    model_used: "gemini-3.5-transcribe",
    attempt_count: 1,
    created_at: NOW,
  };
}

function makeMemory(options: {
  call?: CallRecord;
  analysis?: CallAnalysisRow | null;
  transcript?: CallTranscriptRow | null;
  customers?: DemoCustomer[];
  otherCustomer?: boolean;
  failCustomerUpdates?: number;
} = {}) {
  const otherCustomer: DemoCustomer = {
    id: OTHER_CUSTOMER_ID,
    name: "Unrelated synthetic customer",
    customer_type: "EXISTING_CUSTOMER",
    pipeline_stage: "WON",
    health_status: "HEALTHY",
    assigned_to: null,
    created_at: NOW,
    updated_at: NOW,
  };
  const state: FakeState = {
    calls: [options.call ?? callRecord()],
    transcripts: options.transcript ? [options.transcript] : [transcriptRow()],
    analyses: options.analysis === null ? [] : [options.analysis ?? analysisRow()],
    actions: [],
    notifications: [],
    customers: [...(options.customers ?? []), ...(options.otherCustomer ? [otherCustomer] : [])],
    customerMutations: 0,
    failCustomerUpdates: options.failCustomerUpdates ?? 0,
  };
  const transitions: string[] = [];

  class Query implements PromiseLike<DbResult> {
    private readonly filters: Filter[] = [];
    private sort: { column: string; ascending: boolean } | null = null;
    private maxRows: number | null = null;

    constructor(
      private readonly table: string,
      private readonly operation: "select" | "insert" | "update" | "upsert",
      private readonly values?: Record<string, unknown> | Record<string, unknown>[],
    ) {}

    select() { return this; }
    eq(column: string, value: unknown) {
      this.filters.push({ column, value, kind: "eq" });
      return this;
    }
    in(column: string, values: unknown[]) {
      this.filters.push({ column, value: values, kind: "in" });
      return this;
    }
    order(column: string, options: { ascending?: boolean } = {}) {
      this.sort = { column, ascending: options.ascending ?? true };
      return this;
    }
    limit(value: number) {
      this.maxRows = value;
      return this;
    }
    maybeSingle() { return Promise.resolve(this.execute(true)); }
    single() { return Promise.resolve(this.execute(true)); }
    then<TResult1 = DbResult, TResult2 = never>(
      onfulfilled?: ((value: DbResult) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(this.execute(false)).then(onfulfilled ?? undefined, onrejected ?? undefined);
    }

    private execute(single: boolean): DbResult {
      if (this.operation === "insert") {
        const inserted = this.values as Record<string, unknown>;
        if (this.table === "agent_actions") {
          if (state.actions.some((action) => action.id === inserted.id)) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          }
          const row = { ...inserted, created_at: NOW, approved_at: null, executed_at: null, error_message: null } as unknown as AgentActionRow;
          state.actions.push(row);
          return { data: row, error: null };
        }
      }

      if (this.operation === "upsert" && this.table === "demo_customers") {
        const seeds = Array.isArray(this.values) ? this.values : [this.values as Record<string, unknown>];
        const rows = seeds.map((seed) => {
          const existing = state.customers.find((customer) => customer.id === seed.id);
          if (existing) {
            Object.assign(existing, seed, { updated_at: NOW });
            return existing;
          }
          const created = { ...seed, created_at: NOW, updated_at: NOW } as DemoCustomer;
          state.customers.push(created);
          return created;
        });
        return { data: single ? rows[0] ?? null : rows, error: null };
      }

      const rows = this.tableRows().filter((row) => this.matches(row));
      if (this.operation === "select") {
        let selected = rows;
        if (this.sort) {
          const { column, ascending } = this.sort;
          selected = [...selected].sort((left, right) => {
            const a = String(left[column] ?? "");
            const b = String(right[column] ?? "");
            return (a.localeCompare(b)) * (ascending ? 1 : -1);
          });
        }
        if (this.maxRows !== null) selected = selected.slice(0, this.maxRows);
        return { data: single ? selected[0] ?? null : selected, error: null };
      }

      if (this.operation === "update") {
        if (this.table === "demo_customers" && state.failCustomerUpdates > 0) {
          state.failCustomerUpdates -= 1;
          return { data: null, error: { message: "synthetic customer write failure" } };
        }
        const values = this.values as Record<string, unknown>;
        for (const row of rows) {
          const changed = Object.entries(values).some(([key, value]) => row[key] !== value);
          Object.assign(row, values);
          if (this.table === "demo_customers" && changed && ("health_status" in values || "pipeline_stage" in values)) {
            state.customerMutations += 1;
            row.updated_at = NOW;
          }
          if (this.table === "agent_actions" && "status" in values) {
            transitions.push(`${String(row.status)}->${String(values.status)}`);
          }
        }
        return { data: single ? rows[0] ?? null : rows, error: null };
      }

      throw new Error(`Unexpected fake Supabase ${this.operation} for ${this.table}.`);
    }

    private tableRows(): Record<string, unknown>[] {
      const tables: Record<string, Record<string, unknown>[]> = {
        calls: state.calls,
        transcripts: state.transcripts,
        call_analysis: state.analyses,
        agent_actions: state.actions,
        call_notifications: state.notifications,
        demo_customers: state.customers,
      };
      const rows = tables[this.table];
      if (!rows) throw new Error(`Unexpected fake Supabase table ${this.table}.`);
      return rows;
    }

    private matches(row: Record<string, unknown>) {
      return this.filters.every((filter) =>
        filter.kind === "eq"
          ? row[filter.column] === filter.value
          : (filter.value as unknown[]).includes(row[filter.column]),
      );
    }
  }

  const supabase = {
    from(table: string) {
      return {
        select() { return new Query(table, "select"); },
        insert(values: Record<string, unknown>) { return new Query(table, "insert", values); },
        update(values: Record<string, unknown>) { return new Query(table, "update", values); },
        upsert(values: Record<string, unknown> | Record<string, unknown>[]) { return new Query(table, "upsert", values); },
      };
    },
    storage: {
      from() {
        return {
          async download() { return { data: null, error: { message: "not used by P3 tests" } }; },
          async createSignedUrl() { return { data: { signedUrl: "https://example.test/recording" }, error: null }; },
        };
      },
    },
  };

  return { state, transitions, supabase: supabase as unknown as SupabaseClient };
}

function createAiSpy() {
  const calls = { transcribe: 0, analyze: 0 };
  const drafts: {
    count: number;
    requests: Record<string, unknown>[];
    error: Error | null;
    response: { subject: string; body: string; modelUsed: "gemini-3.5-flash-lite" };
  } = {
    count: 0,
    requests: [],
    error: null,
    response: {
      subject: "Following up on your pest control service",
      body: "Hi Jordan, we are reviewing the scheduling issue and will follow up before your next visit.",
      modelUsed: "gemini-3.5-flash-lite" as const,
    },
  };
  const ai = {
    async transcribe() { calls.transcribe += 1; throw new Error("P3 must not transcribe"); },
    async analyze() { calls.analyze += 1; throw new Error("P3 must not analyze"); },
    async draftCustomerCommunication(input: Record<string, unknown>) {
      drafts.count += 1;
      drafts.requests.push(input);
      if (drafts.error) throw drafts.error;
      return drafts.response;
    },
  };
  return { calls, drafts, ai };
}

function createTestApp(supabase: SupabaseClient, ai: ReturnType<typeof createAiSpy>["ai"]) {
  const app = express();
  app.use(express.json());
  const logger = { error: () => undefined };
  app.use("/api/calls", createCallsRouter({ supabase, bucketName: "call-recordings", ai, logger }));
  app.use("/api", createActionsRouter({ supabase, ai, logger }));
  return app;
}

function withCustomer(id: string = DEMO_CUSTOMER_IDS.retention) {
  const seed = DEMO_CUSTOMERS.find((customer) => customer.id === id);
  assert.ok(seed);
  return { ...seed, created_at: NOW, updated_at: NOW } as DemoCustomer;
}

async function propose(app: express.Express) {
  return request(app).post(`/api/calls/${CALL_ID}/actions/propose`);
}

test("new retention proposal generates and persists one draft reused by refresh and repeated proposal", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);

  const first = await propose(app);
  const second = await propose(app);

  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.action.action_type, "CREATE_RETENTION_FOLLOWUP");
  assert.equal(first.body.action.status, "PENDING");
  assert.equal(first.body.action.requires_approval, true);
  assert.equal(first.body.action.payload_json.priority, "HIGH");
  assert.deepEqual(first.body.action.payload_json.customerCommunication, {
    type: "EMAIL_DRAFT",
    subject: "Following up on your pest control service",
    body: "Hi Jordan, we are reviewing the scheduling issue and will follow up before your next visit.",
    modelUsed: "gemini-3.5-flash-lite",
  });
  assert.equal(ai.drafts.count, 1);
  assert.deepEqual(ai.drafts.requests[0], {
    customerName: "Jordan Example",
    transcript: "Your technicians have been late twice. I am considering cancelling.",
    analysis: {
      summary: "The synthetic customer reports repeated late visits.",
      customerIntent: "The customer is considering cancellation.",
      outcome: "FOLLOW_UP_REQUIRED",
      signals: { complaint: true, cancellationRisk: true, followUpRequired: true },
    },
    actionType: "CREATE_RETENTION_FOLLOWUP",
    actionReason: "P2 detected cancellation risk or classified this call as a cancellation.",
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.action.id, first.body.action.id);
  assert.deepEqual(second.body.action.payload_json.customerCommunication, first.body.action.payload_json.customerCommunication);
  assert.equal(memory.state.actions.length, 1);
  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");
  const detail = await request(app).get(`/api/calls/${CALL_ID}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.demoCustomer.id, DEMO_CUSTOMER_IDS.retention);
  assert.equal(detail.body.actions.length, 1);
  assert.equal(detail.body.actions[0].status, "PENDING");
  assert.deepEqual(detail.body.actions[0].payload_json.customerCommunication, first.body.action.payload_json.customerCommunication);
  assert.equal(detail.body.actionPolicyState, "PENDING_ACTION");
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
  assert.equal(ai.drafts.count, 1);
});

test("concurrent proposal requests produce one deterministic action row", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);

  const responses = await Promise.all([propose(app), propose(app)]);

  assert.equal(memory.state.actions.length, 1);
  assert.equal(responses.every((response) => response.status === 200 || response.status === 201), true);
  assert.equal(responses[0]?.body.action.id, responses[1]?.body.action.id);
  assert.equal(ai.drafts.count, 1);
  assert.ok(responses.some((response) => response.body.action.payload_json.customerCommunication));
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("later signal changes cannot create a second primary action for the same call", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const first = await propose(app);
  memory.state.analyses[0] = analysisRow(analysis({
    callType: "COLLECTIONS",
    signals: {
      newLead: false,
      complaint: false,
      cancellationRisk: false,
      upsellOpportunity: false,
      reactivationOpportunity: false,
      collectionsIssue: true,
      followUpRequired: true,
    },
  }));

  const second = await propose(app);

  assert.equal(first.body.action.action_type, "CREATE_RETENTION_FOLLOWUP");
  assert.equal(second.status, 200);
  assert.equal(second.body.action.id, first.body.action.id);
  assert.equal(second.body.action.action_type, "CREATE_RETENTION_FOLLOWUP");
  assert.equal(memory.state.actions.length, 1);
});

test("missing analysis is rejected and irrelevant validated analysis returns no action", async () => {
  const missingMemory = makeMemory({ analysis: null });
  const missingAi = createAiSpy();
  const missing = await propose(createTestApp(missingMemory.supabase, missingAi.ai));
  assert.equal(missing.status, 409);
  assert.equal(missing.body.error.code, "ANALYSIS_REQUIRED");
  assert.equal(missingMemory.state.actions.length, 0);

  const noSignal = analysis({
    callType: "OTHER",
    signals: {
      newLead: false,
      complaint: false,
      cancellationRisk: false,
      upsellOpportunity: false,
      reactivationOpportunity: false,
      collectionsIssue: false,
      followUpRequired: false,
    },
  });
  const noActionMemory = makeMemory({ analysis: analysisRow(noSignal) });
  const noActionAi = createAiSpy();
  const noAction = await propose(createTestApp(noActionMemory.supabase, noActionAi.ai));
  assert.equal(noAction.status, 200);
  assert.equal(noAction.body.action, null);
  assert.equal(noAction.body.reason, "NO_PERMITTED_ACTION");
  assert.equal(noActionMemory.state.actions.length, 0);
  const noActionDetail = await request(createTestApp(noActionMemory.supabase, noActionAi.ai)).get(`/api/calls/${CALL_ID}`);
  assert.equal(noActionDetail.status, 200);
  assert.equal(noActionDetail.body.actionPolicyState, "NO_ACTION_REQUIRED");
  assert.equal(noActionDetail.body.actions.length, 0);
  assert.deepEqual(noActionAi.calls, { transcribe: 0, analyze: 0 });
  assert.equal(noActionAi.drafts.count, 0);
});

test("draft failure leaves a pending retention action usable and repeated proposals do not retry", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  ai.drafts.error = new Error("draft provider unavailable");
  const app = createTestApp(memory.supabase, ai.ai);

  const first = await propose(app);
  const second = await propose(app);

  assert.equal(first.status, 201);
  assert.equal(first.body.action.action_type, "CREATE_RETENTION_FOLLOWUP");
  assert.equal(first.body.action.status, "PENDING");
  assert.equal(first.body.action.payload_json.customerCommunication, undefined);
  assert.equal(second.status, 200);
  assert.equal(second.body.action.status, "PENDING");
  assert.equal(ai.drafts.count, 1);
  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");
});

test("incomplete subject or body is rejected without invalidating the saved action", async () => {
  for (const response of [
    { subject: "", body: "A complete body.", modelUsed: "gemini-3.5-flash-lite" as const },
    { subject: "A complete subject", body: "   ", modelUsed: "gemini-3.5-flash-lite" as const },
  ]) {
    const memory = makeMemory({ customers: [withCustomer()] });
    const ai = createAiSpy();
    ai.drafts.response = response;

    const result = await propose(createTestApp(memory.supabase, ai.ai));

    assert.equal(result.status, 201);
    assert.equal(result.body.action.status, "PENDING");
    assert.equal(result.body.action.payload_json.customerCommunication, undefined);
    assert.equal(memory.state.actions.length, 1);
  }
});

test("call detail reports a server-derived available action before a proposal is saved", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  const detail = await request(createTestApp(memory.supabase, ai.ai)).get(`/api/calls/${CALL_ID}`);

  assert.equal(detail.status, 200);
  assert.equal(detail.body.actionPolicyState, "ACTION_AVAILABLE");
  assert.deepEqual(detail.body.actions, []);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("call detail does not derive policy from analysis whose evidence is not grounded", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  memory.state.transcripts[0]!.text = "A transcript with no matching evidence.";
  const ai = createAiSpy();
  const detail = await request(createTestApp(memory.supabase, ai.ai)).get(`/api/calls/${CALL_ID}`);

  assert.equal(detail.status, 200);
  assert.equal(detail.body.analysis, null);
  assert.equal(detail.body.actionPolicyState, "NOT_READY");
});

test("approval is required before retention mutation and completion preserves its audit timestamps", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const proposal = await propose(app);
  const actionId = proposal.body.action.id as string;

  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");
  assert.equal(proposal.body.action.status, "PENDING");

  const approved = await request(app).post(`/api/actions/${actionId}/approve`);

  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.action.status, "COMPLETED");
  assert.ok(approved.body.action.approved_at);
  assert.ok(approved.body.action.executed_at);
  assert.ok(approved.body.action.payload_json.execution.completedAt);
  assert.deepEqual(approved.body.action.payload_json.customerCommunication, {
    type: "EMAIL_DRAFT",
    subject: "Following up on your pest control service",
    body: "Hi Jordan, we are reviewing the scheduling issue and will follow up before your next visit.",
    modelUsed: "gemini-3.5-flash-lite",
  });
  assert.equal(memory.state.customers[0]?.health_status, "AT_RISK");
  assert.equal(memory.state.customerMutations, 1);
  const detail = await request(app).get(`/api/calls/${CALL_ID}`);
  assert.equal(detail.body.actionPolicyState, "COMPLETED_ACTION");
  assert.equal(ai.drafts.count, 1);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("approved termite lead follow-up applies only the fixed QUALIFIED pipeline transition", async () => {
  const lead = withCustomer(DEMO_CUSTOMER_IDS.termiteLead);
  const leadAnalysis = analysis({
    callType: "NEW_LEAD",
    signals: {
      newLead: true,
      complaint: false,
      cancellationRisk: false,
      upsellOpportunity: false,
      reactivationOpportunity: false,
      collectionsIssue: false,
      followUpRequired: true,
    },
  });
  const memory = makeMemory({
    call: callRecord({ demo_customer_id: DEMO_CUSTOMER_IDS.termiteLead }),
    analysis: analysisRow(leadAnalysis),
    customers: [lead],
  });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const proposal = await propose(app);
  const approved = await request(app).post(`/api/actions/${proposal.body.action.id}/approve`);

  assert.equal(proposal.body.action.action_type, "CREATE_SALES_FOLLOWUP");
  assert.equal(approved.body.action.status, "COMPLETED");
  assert.equal(memory.state.customers[0]?.pipeline_stage, "QUALIFIED");
  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");
  assert.equal(memory.state.customerMutations, 1);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
  assert.equal(ai.drafts.count, 0);
});

test("approved upsell is represented by the completed task action without a customer-field mutation", async () => {
  const customer = withCustomer(DEMO_CUSTOMER_IDS.upsell);
  const upsellAnalysis = analysis({
    callType: "SERVICE",
    signals: { ...analysis().signals, cancellationRisk: false, upsellOpportunity: true },
  });
  const memory = makeMemory({
    call: callRecord({ demo_customer_id: DEMO_CUSTOMER_IDS.upsell }),
    analysis: analysisRow(upsellAnalysis),
    customers: [customer],
  });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const proposal = await propose(app);
  const approved = await request(app).post(`/api/actions/${proposal.body.action.id}/approve`);

  assert.equal(proposal.body.action.action_type, "CREATE_UPSELL_TASK");
  assert.equal(approved.body.action.status, "COMPLETED");
  assert.match(approved.body.action.payload_json.execution.result, /task created/i);
  assert.equal(memory.state.customerMutations, 0);
  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("rejection is idempotent, records a timestamp, and can never execute", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const proposal = await propose(app);
  const actionId = proposal.body.action.id as string;

  const rejected = await request(app).post(`/api/actions/${actionId}/reject`);
  const repeated = await request(app).post(`/api/actions/${actionId}/reject`);
  const approval = await request(app).post(`/api/actions/${actionId}/approve`);

  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.action.status, "REJECTED");
  assert.ok(rejected.body.action.payload_json.rejection.rejectedAt);
  assert.equal(repeated.status, 200);
  assert.equal(approval.status, 409);
  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");
  assert.equal(memory.state.customerMutations, 0);
  assert.equal(memory.state.actions[0]?.status, "REJECTED");
  const detail = await request(app).get(`/api/calls/${CALL_ID}`);
  assert.equal(detail.body.actionPolicyState, "REJECTED_ACTION");
});

test("arbitrary client action types and customer patches are rejected", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const injectedProposal = await request(app)
    .post(`/api/calls/${CALL_ID}/actions/propose`)
    .send({ actionType: "DELETE_CUSTOMER", payload: { health_status: "AT_RISK" } });
  const proposal = await propose(app);
  const injectedApproval = await request(app)
    .post(`/api/actions/${proposal.body.action.id}/approve`)
    .send({ actionType: "DELETE_CUSTOMER", payload: { health_status: "AT_RISK" } });

  assert.equal(injectedProposal.status, 400);
  assert.equal(memory.state.actions.length, 1);
  assert.equal(injectedApproval.status, 400);
  assert.equal(memory.state.actions[0]?.status, "PENDING");
  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");
  assert.equal(memory.state.customerMutations, 0);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("repeated and simultaneous approvals complete a retention action only once", async () => {
  const memory = makeMemory({ customers: [withCustomer()] });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const proposal = await propose(app);
  const actionId = proposal.body.action.id as string;

  const simultaneous = await Promise.all([
    request(app).post(`/api/actions/${actionId}/approve`),
    request(app).post(`/api/actions/${actionId}/approve`),
  ]);
  const repeated = await request(app).post(`/api/actions/${actionId}/approve`);

  assert.equal(simultaneous.every((response) => response.status === 200 || response.status === 202), true);
  assert.equal(repeated.status, 200);
  assert.equal(memory.state.actions.length, 1);
  assert.equal(memory.state.actions[0]?.status, "COMPLETED");
  assert.equal(memory.state.customerMutations, 1);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
  assert.equal(ai.drafts.count, 1);
});

test("failed execution preserves approval and error, then safely retries the same stored action", async () => {
  const memory = makeMemory({ customers: [withCustomer()], failCustomerUpdates: 1 });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const proposal = await propose(app);
  const actionId = proposal.body.action.id as string;

  const failed = await request(app).post(`/api/actions/${actionId}/approve`);

  assert.equal(failed.status, 503);
  assert.equal(failed.body.action.status, "FAILED");
  assert.ok(failed.body.action.approved_at);
  assert.match(failed.body.action.error_message, /execution/i);
  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");

  const retried = await request(app).post(`/api/actions/${actionId}/approve`);

  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.action.status, "COMPLETED");
  assert.equal(retried.body.action.approved_at, failed.body.action.approved_at);
  assert.equal(retried.body.action.payload_json.execution.attemptCount, 2);
  assert.equal(
    retried.body.action.payload_json.execution.previousAttempts[0].errorMessage,
    failed.body.action.error_message,
  );
  assert.equal(memory.state.customers[0]?.health_status, "AT_RISK");
  assert.equal(memory.state.customerMutations, 1);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("approved execution retries are bounded and retain all failed attempt evidence", async () => {
  const memory = makeMemory({ customers: [withCustomer()], failCustomerUpdates: 3 });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);
  const proposal = await propose(app);
  const actionId = proposal.body.action.id as string;
  let lastAttemptCount = 0;
  let previousAttemptCount = 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const failed = await request(app).post(`/api/actions/${actionId}/approve`);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.action.status, "FAILED");
    lastAttemptCount = failed.body.action.payload_json.execution.attemptCount;
    previousAttemptCount = failed.body.action.payload_json.execution.previousAttempts?.length ?? 0;
  }
  const retryLimit = await request(app).post(`/api/actions/${actionId}/approve`);

  assert.equal(retryLimit.status, 409);
  assert.equal(retryLimit.body.error.code, "ACTION_RETRY_LIMIT");
  assert.equal(lastAttemptCount, 3);
  assert.equal(previousAttemptCount, 2);
  assert.equal(memory.state.customers[0]?.health_status, "HEALTHY");
  assert.equal(memory.state.customerMutations, 0);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("reset seeds only fixed synthetic customers and preserves unrelated records and action history", async () => {
  const fixed = withCustomer();
  fixed.health_status = "AT_RISK";
  const memory = makeMemory({ customers: [fixed], otherCustomer: true });
  const unrelated = memory.state.customers.find((customer) => customer.id === OTHER_CUSTOMER_ID);
  assert.ok(unrelated);
  unrelated.health_status = "AT_RISK";
  unrelated.pipeline_stage = "LOST";
  memory.state.calls[0]!.demo_customer_id = OTHER_CUSTOMER_ID;
  memory.state.actions.push({
    id: "a2000000-0000-4000-8000-000000000001",
    call_id: CALL_ID,
    action_type: "CREATE_RETENTION_FOLLOWUP",
    payload_json: {
      version: 1,
      actionType: "CREATE_RETENTION_FOLLOWUP",
      title: "Create retention follow-up",
      reason: "P2 detected cancellation risk.",
      priority: "HIGH",
      requiresApproval: true,
      targetDemoCustomerId: DEMO_CUSTOMER_IDS.retention,
      expectedChanges: { customer: { healthStatus: "AT_RISK" } },
      rejection: { rejectedAt: NOW },
    },
    status: "REJECTED",
    requires_approval: true,
    error_message: null,
    created_at: NOW,
    approved_at: null,
    executed_at: null,
  });
  const ai = createAiSpy();
  const app = createTestApp(memory.supabase, ai.ai);

  const invalidReset = await request(app).post("/api/demo/reset").send({ customerIds: [OTHER_CUSTOMER_ID] });
  assert.equal(invalidReset.status, 400);
  assert.equal(unrelated.health_status, "AT_RISK");
  assert.equal(unrelated.pipeline_stage, "LOST");

  const reset = await request(app).post("/api/demo/reset");

  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  assert.equal(reset.body.customers.length, 3);
  assert.equal(memory.state.customers.find((customer) => customer.id === DEMO_CUSTOMER_IDS.retention)?.health_status, "HEALTHY");
  assert.equal(memory.state.customers.find((customer) => customer.id === DEMO_CUSTOMER_IDS.termiteLead)?.pipeline_stage, "NEW");
  assert.equal(memory.state.customers.find((customer) => customer.id === OTHER_CUSTOMER_ID)?.health_status, "AT_RISK");
  assert.equal(memory.state.customers.find((customer) => customer.id === OTHER_CUSTOMER_ID)?.pipeline_stage, "LOST");
  assert.equal(memory.state.actions.length, 1);
  assert.equal(memory.state.calls.length, 1);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("demo customer listing includes only fixed fixture IDs", async () => {
  const memory = makeMemory({ customers: DEMO_CUSTOMERS.map((customer) => ({ ...customer, created_at: NOW, updated_at: NOW })), otherCustomer: true });
  const ai = createAiSpy();
  const response = await request(createTestApp(memory.supabase, ai.ai)).get("/api/demo/customers");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.customers.map((customer: DemoCustomer) => customer.id), [
    DEMO_CUSTOMER_IDS.retention,
    DEMO_CUSTOMER_IDS.termiteLead,
    DEMO_CUSTOMER_IDS.upsell,
  ]);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});
