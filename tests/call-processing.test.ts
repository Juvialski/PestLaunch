import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";
import type { CallAnalysis, CallAnalysisRow, CallTranscriptRow } from "../src/shared/calls.js";
import type { AgentActionRow, DemoCustomer } from "../src/shared/actions.js";
import type { CallNotificationRow } from "../src/shared/notifications.js";
import { AiConfigurationError } from "../server/aiTypes.js";
import type { CallsAiService, CallTranscriptionResult } from "../server/aiTypes.js";
import { createCallsRouter } from "../server/callsRouter.js";
import { createHighRiskAlertDispatcher } from "../server/highRiskAlert.js";
import type { HighRiskAlertDispatcher } from "../server/highRiskAlert.js";

const CALL_ID = "3dd5d1a6-8118-43e4-b340-206825622cff";
const NOW = "2026-09-25T00:00:00.000Z";

type FakeCall = {
  id: string;
  caller_name: string | null;
  demo_customer_id: string | null;
  audio_path: string;
  original_filename: string;
  mime_type: string;
  status: string;
  duration: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type TranscriptValue = CallTranscriptionResult;
type AnalysisValue = CallAnalysis;
type AiDouble = CallsAiService;

function fakeCall(overrides: Partial<FakeCall> = {}): FakeCall {
  return {
    id: CALL_ID,
    caller_name: "Jamie Demo",
    demo_customer_id: null,
    audio_path: `calls/${CALL_ID}.mp3`,
    original_filename: "recording.mp3",
    mime_type: "audio/mpeg",
    status: "UPLOADED",
    duration: null,
    last_error: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

function transcript(overrides: Partial<TranscriptValue> = {}): TranscriptValue {
  return {
    text: "Your technicians have been late three times, and I am thinking about cancelling.",
    segments: [
      {
        speaker: "Speaker 1",
        startMs: 1200,
        endMs: 6200,
        text: "Your technicians have been late three times.",
      },
      {
        speaker: "Speaker 1",
        startMs: 6500,
        endMs: 8500,
        text: "I am thinking about cancelling.",
      },
    ],
    modelUsed: "gemini-3.5-transcribe",
    attemptCount: 1,
    ...overrides,
  };
}

function analysis(overrides: Partial<AnalysisValue> = {}): AnalysisValue {
  return {
    callType: "COMPLAINT",
    confidence: 0.96,
    summary: "The customer reports repeated late visits and may cancel service.",
    customerIntent: "The customer wants reliable service and a retention follow-up.",
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
    evidence: [
      { speaker: "Speaker 1", quote: "Your technicians have been late three times." },
      { speaker: "Speaker 1", quote: "I am thinking about cancelling." },
    ],
    recommendedAction: {
      type: "RETENTION_FOLLOW_UP",
      reason: "Address the repeated lateness and confirm a retention plan.",
      requiresApproval: true,
    },
    ...overrides,
  };
}

function transcriptRow(value: TranscriptValue): CallTranscriptRow {
  return {
    id: "transcript-row",
    call_id: CALL_ID,
    text: value.text,
    segments_json: value.segments,
    model_used: value.modelUsed,
    attempt_count: value.attemptCount,
    created_at: NOW,
  };
}

function analysisRow(value: AnalysisValue, modelUsed = "gemini-3.8-flash"): CallAnalysisRow {
  return {
    id: "analysis-row",
    call_id: CALL_ID,
    call_type: value.callType,
    confidence: value.confidence,
    summary: value.summary,
    analysis_json: value,
    model_used: modelUsed,
    created_at: NOW,
  };
}

function createAiDouble(options: {
  transcriptValue?: TranscriptValue;
  analysisValue?: AnalysisValue;
  transcribeError?: Error;
  analysisError?: Error;
  analysisModel?: string;
} = {}) {
  const calls = { transcribe: 0, analyze: 0 };
  const ai: AiDouble = {
    async transcribe() {
      calls.transcribe += 1;
      if (options.transcribeError) throw options.transcribeError;
      return options.transcriptValue ?? transcript();
    },
    async analyze() {
      calls.analyze += 1;
      if (options.analysisError) throw options.analysisError;
      return {
        analysis: options.analysisValue ?? analysis(),
        modelUsed: options.analysisModel ?? "gemini-3.8-flash",
        attemptCount: 1,
      };
    },
  };
  return { ai, calls };
}

function createMemorySupabase(options: {
  call?: FakeCall;
  transcript?: ReturnType<typeof transcriptRow> | null;
  analysis?: ReturnType<typeof analysisRow> | null;
  actions?: AgentActionRow[];
  notifications?: CallNotificationRow[];
  demoCustomer?: DemoCustomer | null;
  audioError?: Error;
  analysisUpsertError?: Error;
} = {}) {
  const state = {
    call: options.call ?? fakeCall(),
    transcript: options.transcript ?? null,
    analysis: options.analysis ?? null,
    actions: options.actions ?? [],
    notifications: options.notifications ?? [],
    demoCustomer: options.demoCustomer ?? null,
  };
  const calls = { audioDownloads: 0, signedUrls: 0, transcriptWrites: 0, analysisWrites: 0 };

  class Query {
    private filters: Record<string, unknown> = {};

    constructor(
      private readonly table: string,
      private readonly operation: "select" | "update" | "upsert",
      private readonly values?: Record<string, unknown>,
      private readonly upsertOptions?: { onConflict?: string; ignoreDuplicates?: boolean },
    ) {}

    select() { return this; }
    order() { return this; }
    eq(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    }
    async maybeSingle() { return this.execute(true); }
    async single() { return this.execute(true); }
    async limit() { return this.execute(false); }

    private async execute(single: boolean) {
      if (this.table === "calls") {
        if (this.operation === "select") {
          const found = this.matches(state.call) ? { ...state.call } : null;
          return { data: single ? found : found ? [found] : [], error: null };
        }
        if (this.operation === "update") {
          if (!this.matches(state.call)) return { data: null, error: null };
          Object.assign(state.call, this.values);
          return { data: { ...state.call }, error: null };
        }
      }
      if (this.table === "transcripts") {
        if (this.operation === "select") {
          const found = this.matches(state.transcript) ? state.transcript : null;
          return { data: single ? found : found ? [found] : [], error: null };
        }
        if (this.operation === "upsert") {
          calls.transcriptWrites += 1;
          state.transcript = {
            id: "transcript-row",
            call_id: CALL_ID,
            created_at: NOW,
            ...this.values,
          } as ReturnType<typeof transcriptRow>;
          return { data: state.transcript, error: null };
        }
      }
      if (this.table === "call_analysis") {
        if (this.operation === "select") {
          const found = this.matches(state.analysis) ? state.analysis : null;
          return { data: single ? found : found ? [found] : [], error: null };
        }
        if (this.operation === "upsert") {
          calls.analysisWrites += 1;
          if (options.analysisUpsertError) {
            return { data: null, error: { message: options.analysisUpsertError.message } };
          }
          state.analysis = {
            id: "analysis-row",
            call_id: CALL_ID,
            created_at: NOW,
            ...this.values,
          } as ReturnType<typeof analysisRow>;
          return { data: state.analysis, error: null };
        }
      }
      if (this.table === "agent_actions" && this.operation === "select") {
        const found = state.actions.filter((row) => this.matches(row as unknown as Record<string, unknown>));
        return { data: single ? found[0] ?? null : found, error: null };
      }
      if (this.table === "call_notifications" && this.operation === "select") {
        const found = state.notifications.filter((row) => this.matches(row as unknown as Record<string, unknown>));
        return { data: single ? found[0] ?? null : found, error: null };
      }
      if (this.table === "call_notifications" && this.operation === "upsert") {
        const values = this.values ?? {};
        const existing = state.notifications.find((row) =>
          row.call_id === values.call_id &&
          row.notification_type === values.notification_type &&
          row.recipient === values.recipient,
        );
        if (existing && this.upsertOptions?.ignoreDuplicates) return { data: null, error: null };
        if (existing) return { data: null, error: { message: "Unexpected duplicate notification upsert." } };
        const row = {
          id: "90000000-0000-4000-8000-000000000003",
          created_at: NOW,
          sent_at: null,
          provider_message_id: null,
          error_message: null,
          attempt_count: 0,
          ...values,
        } as unknown as CallNotificationRow;
        state.notifications.push(row);
        return { data: { ...row }, error: null };
      }
      if (this.table === "call_notifications" && this.operation === "update") {
        const found = state.notifications.find((row) => this.matches(row as unknown as Record<string, unknown>));
        if (!found) return { data: null, error: null };
        Object.assign(found, this.values);
        return { data: { ...found }, error: null };
      }
      if (this.table === "demo_customers" && this.operation === "select") {
        const found = this.matches(state.demoCustomer as unknown as Record<string, unknown> | null) ? state.demoCustomer : null;
        return { data: single ? found : found ? [found] : [], error: null };
      }
      throw new Error(`Unexpected Supabase ${this.operation} on ${this.table}.`);
    }

    private matches(row: Record<string, unknown> | FakeCall | null) {
      const values = row as Record<string, unknown> | null;
      return Boolean(values && Object.entries(this.filters).every(([key, value]) => values[key] === value));
    }
  }

  const supabase = {
    storage: {
      from() {
        return {
          async download(path: string) {
            assert.equal(path, state.call.audio_path);
            calls.audioDownloads += 1;
            if (options.audioError) return { data: null, error: { message: options.audioError.message } };
            return { data: new Blob([new Uint8Array([1, 2, 3])], { type: state.call.mime_type }), error: null };
          },
          async createSignedUrl(path: string, expiresIn: number) {
            assert.equal(path, state.call.audio_path);
            assert.equal(expiresIn, 300);
            calls.signedUrls += 1;
            return { data: { signedUrl: "https://storage.example.test/private-file?token=short-lived" }, error: null };
          },
        };
      },
    },
    from(table: string) {
      return {
        select() { return new Query(table, "select"); },
        update(values: Record<string, unknown>) { return new Query(table, "update", values); },
        upsert(values: Record<string, unknown>, upsertOptions?: { onConflict?: string; ignoreDuplicates?: boolean }) {
          return new Query(table, "upsert", values, upsertOptions);
        },
      };
    },
  };

  return {
    supabase: supabase as unknown as SupabaseClient,
    state,
    calls,
  };
}

function createTestApp(
  supabase: SupabaseClient,
  ai: AiDouble,
  logger = { info: () => undefined, warn: () => undefined, error: () => undefined },
  highRiskAlert?: HighRiskAlertDispatcher,
) {
  const app = express();
  const dependencies = {
    supabase,
    bucketName: "call-recordings",
    ai,
    logger,
    ...(highRiskAlert ? { highRiskAlert } : {}),
  } as Parameters<typeof createCallsRouter>[0];
  app.use(
    "/api/calls",
    createCallsRouter(dependencies),
  );
  return app;
}

test("loading call data and private audio never starts Gemini processing", async () => {
  const memory = createMemorySupabase({ call: fakeCall({ status: "ANALYZED" }), transcript: transcriptRow(transcript()), analysis: analysisRow(analysis()) });
  const ai = createAiDouble();
  const app = createTestApp(memory.supabase, ai.ai);

  const list = await request(app).get("/api/calls");
  const detail = await request(app).get(`/api/calls/${CALL_ID}`);
  const audio = await request(app).get(`/api/calls/${CALL_ID}/audio`);
  const processRead = await request(app).get(`/api/calls/${CALL_ID}/process`);

  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(audio.status, 302);
  assert.equal(processRead.status, 404);
  assert.equal(ai.calls.transcribe, 0);
  assert.equal(ai.calls.analyze, 0);
});

test("an explicit process request persists transcript and validated call intelligence", async () => {
  const memory = createMemorySupabase();
  const ai = createAiDouble();

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.call.status, "ANALYZED");
  assert.equal(response.body.call.last_error, null);
  assert.equal(response.body.transcript.model_used, "gemini-3.5-transcribe");
  assert.equal(response.body.transcript.attempt_count, 1);
  assert.equal(response.body.analysis.analysis_json.signals.cancellationRisk, true);
  assert.equal(memory.calls.audioDownloads, 1);
  assert.equal(memory.calls.transcriptWrites, 1);
  assert.equal(memory.calls.analysisWrites, 1);
  assert.deepEqual(ai.calls, { transcribe: 1, analyze: 1 });
});

test("high-risk notification failure does not turn persisted analysis into a failed call", async () => {
  const memory = createMemorySupabase();
  const ai = createAiDouble();
  let dispatchCount = 0;
  let observedPersistedAnalysis = false;
  const highRiskAlert: HighRiskAlertDispatcher = {
    async dispatch(input) {
      dispatchCount += 1;
      observedPersistedAnalysis = memory.state.analysis?.analysis_json.priority === input.analysis.priority;
      assert.equal(memory.state.call.status, "PROCESSING");
      throw new Error("notification storage unavailable");
    },
  };

  const response = await request(createTestApp(memory.supabase, ai.ai, undefined, highRiskAlert))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(dispatchCount, 1);
  assert.equal(observedPersistedAnalysis, true);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.call.status, "ANALYZED");
  assert.equal(response.body.analysis.analysis_json.priority, "HIGH");
  assert.equal(response.body.actionPolicyState, "ACTION_AVAILABLE");
});

test("a persisted Brevo rejection leaves the call ANALYZED and keeps the deterministic proposal available", async () => {
  const memory = createMemorySupabase();
  const ai = createAiDouble();
  const highRiskAlert = createHighRiskAlertDispatcher({
    supabase: memory.supabase,
    recipientConfig: "manager@example.com",
    sender: {
      async send() {
        return { status: "FAILED", providerMessageId: null, errorMessage: "Brevo returned HTTP 503." };
      },
    },
    logger: { error: () => undefined },
  });

  const response = await request(createTestApp(memory.supabase, ai.ai, undefined, highRiskAlert))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.call.status, "ANALYZED");
  assert.equal(response.body.analysis.analysis_json.priority, "HIGH");
  assert.equal(response.body.actionPolicyState, "ACTION_AVAILABLE");
  assert.equal(response.body.notifications[0].status, "FAILED");
  assert.equal(response.body.notifications[0].attempt_count, 1);
  assert.equal(Object.hasOwn(response.body.notifications[0], "recipient"), false);
  assert.equal(memory.state.notifications[0]?.recipient, "manager@example.com");
});

test("repeated Process requests for an already analyzed call do not backfill a new alert", async () => {
  const memory = createMemorySupabase({
    call: fakeCall({ status: "ANALYZED" }),
    transcript: transcriptRow(transcript()),
    analysis: analysisRow(analysis()),
  });
  const ai = createAiDouble();
  let dispatchCount = 0;
  const highRiskAlert: HighRiskAlertDispatcher = {
    async dispatch() { dispatchCount += 1; },
  };

  const response = await request(createTestApp(memory.supabase, ai.ai, undefined, highRiskAlert))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 200);
  assert.equal(dispatchCount, 0);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("a valid analyzed call returns persisted results without another AI request", async () => {
  const memory = createMemorySupabase({
    call: fakeCall({ status: "ANALYZED" }),
    transcript: transcriptRow(transcript()),
    analysis: analysisRow(analysis()),
  });
  const ai = createAiDouble();

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 200);
  assert.equal(response.body.analysis.analysis_json.callType, "COMPLAINT");
  assert.equal(memory.calls.audioDownloads, 0);
  assert.equal(memory.calls.transcriptWrites, 0);
  assert.equal(memory.calls.analysisWrites, 0);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("retry reuses a valid persisted transcript and spends no transcription quota", async () => {
  const memory = createMemorySupabase({
    call: fakeCall({ status: "NEEDS_REVIEW", last_error: "Analysis fallbacks exhausted." }),
    transcript: transcriptRow(transcript({ modelUsed: "gemini-3.8-flash", attemptCount: 2 })),
  });
  const ai = createAiDouble();

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 200);
  assert.equal(response.body.call.status, "ANALYZED");
  assert.equal(response.body.call.last_error, null);
  assert.equal(response.body.transcript.model_used, "gemini-3.8-flash");
  assert.equal(response.body.transcript.attempt_count, 2);
  assert.equal(memory.calls.audioDownloads, 0);
  assert.equal(memory.calls.transcriptWrites, 0);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 1 });
});

test("a saved valid analysis is reconciled without Gemini when the call status update was interrupted", async () => {
  const memory = createMemorySupabase({
    call: fakeCall({ status: "FAILED", last_error: "Status update interrupted." }),
    transcript: transcriptRow(transcript()),
    analysis: analysisRow(analysis()),
  });
  const ai = createAiDouble();

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 200);
  assert.equal(response.body.call.status, "ANALYZED");
  assert.equal(response.body.call.last_error, null);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("fallback model and attempt metadata are persisted from the injected AI boundary", async () => {
  const memory = createMemorySupabase();
  const ai = createAiDouble({
    transcriptValue: transcript({ modelUsed: "gemini-3.8-flash", attemptCount: 2 }),
    analysisModel: "gemini-3.7-flash",
  });

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 200);
  assert.equal(response.body.transcript.model_used, "gemini-3.8-flash");
  assert.equal(response.body.transcript.attempt_count, 2);
  assert.equal(response.body.analysis.model_used, "gemini-3.7-flash");
});

test("exhausted recoverable AI failures leave the call in NEEDS_REVIEW", async () => {
  const memory = createMemorySupabase();
  const recoverable = Object.assign(new Error("Gemini options exhausted."), { recoverable: true });
  const ai = createAiDouble({ transcribeError: recoverable });

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 422);
  assert.equal(response.body.call.status, "NEEDS_REVIEW");
  assert.match(response.body.call.last_error, /Gemini options exhausted/);
  assert.equal(memory.calls.analysisWrites, 0);
});

test("Gemini configuration failures give a safe administrator next step", async () => {
  const memory = createMemorySupabase();
  const ai = createAiDouble({ transcribeError: new AiConfigurationError() });

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 503);
  assert.equal(response.body.call.status, "FAILED");
  assert.equal(response.body.error.message, "AI processing is unavailable right now. Please contact the administrator.");
  assert.equal(response.body.call.last_error, response.body.error.message);
  assert.doesNotMatch(response.body.error.message, /GEMINI_API_KEY|credential/i);
});

test("a private storage failure marks the call FAILED without invoking Gemini", async () => {
  const memory = createMemorySupabase({ audioError: new Error("storage unavailable") });
  const ai = createAiDouble();

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 503);
  assert.equal(response.body.call.status, "FAILED");
  assert.equal(memory.calls.analysisWrites, 0);
  assert.deepEqual(ai.calls, { transcribe: 0, analyze: 0 });
});

test("a database failure while saving analysis marks the call FAILED and preserves its transcript", async () => {
  const memory = createMemorySupabase({ analysisUpsertError: new Error("database unavailable") });
  const ai = createAiDouble();

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 503);
  assert.equal(response.body.call.status, "FAILED");
  assert.match(response.body.call.last_error, /analysis could not be saved/);
  assert.equal(response.body.transcript.text, transcript().text);
  assert.equal(response.body.analysis, null);
  assert.deepEqual(ai.calls, { transcribe: 1, analyze: 1 });
});

test("malformed analysis is not persisted as successful intelligence", async () => {
  const memory = createMemorySupabase();
  const malformed = { ...analysis(), priority: "CRITICAL" } as unknown as AnalysisValue;
  const ai = createAiDouble({ analysisValue: malformed });

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .post(`/api/calls/${CALL_ID}/process`);

  assert.equal(response.status, 422);
  assert.equal(response.body.call.status, "NEEDS_REVIEW");
  assert.equal(memory.calls.analysisWrites, 0);
  assert.equal(response.body.analysis, null);
});

test("already-processing and simultaneous duplicate requests do not start a second run", async () => {
  const memory = createMemorySupabase();
  const aiCalls = { transcribe: 0, analyze: 0 };
  const ai: AiDouble = {
    async transcribe() {
      aiCalls.transcribe += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return transcript();
    },
    async analyze() {
      aiCalls.analyze += 1;
      return { analysis: analysis(), modelUsed: "gemini-3.8-flash", attemptCount: 1 };
    },
  };
  const app = createTestApp(memory.supabase, ai);

  const [first, second] = await Promise.all([
    request(app).post(`/api/calls/${CALL_ID}/process`),
    request(app).post(`/api/calls/${CALL_ID}/process`),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(aiCalls.transcribe, 1);
  assert.equal(aiCalls.analyze, 1);
  assert.equal(memory.calls.transcriptWrites, 1);
  assert.equal(memory.calls.analysisWrites, 1);

  const busyMemory = createMemorySupabase({ call: fakeCall({ status: "PROCESSING" }) });
  const busyAi = createAiDouble();
  const busy = await request(createTestApp(busyMemory.supabase, busyAi.ai))
    .post(`/api/calls/${CALL_ID}/process`);
  assert.equal(busy.status, 409);
  assert.deepEqual(busyAi.calls, { transcribe: 0, analyze: 0 });
});

test("call detail returns persisted transcript and analysis", async () => {
  const memory = createMemorySupabase({
    call: fakeCall({ status: "ANALYZED" }),
    transcript: transcriptRow(transcript()),
    analysis: analysisRow(analysis()),
  });
  const ai = createAiDouble();

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .get(`/api/calls/${CALL_ID}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.transcript.text, transcript().text);
  assert.equal(response.body.analysis.analysis_json.priority, "HIGH");
  assert.equal(ai.calls.transcribe, 0);
  assert.equal(ai.calls.analyze, 0);
});

test("call detail omits configured email addresses from public notification summaries", async () => {
  const memory = createMemorySupabase({
    call: fakeCall({ status: "ANALYZED" }),
    transcript: transcriptRow(transcript()),
    analysis: analysisRow(analysis()),
    notifications: [{
      id: "91000000-0000-4000-8000-000000000003",
      call_id: CALL_ID,
      notification_type: "HIGH_RISK_ALERT",
      recipient: "manager@example.com",
      provider: "BREVO",
      status: "SENT",
      provider_message_id: "<provider-message>",
      attempt_count: 1,
      error_message: null,
      created_at: NOW,
      sent_at: NOW,
    }],
  });
  const ai = createAiDouble();
  const highRiskAlert: HighRiskAlertDispatcher = {
    hasConfiguredRecipients: true,
    async dispatch() { throw new Error("GET call detail must not dispatch alerts."); },
  };

  const response = await request(createTestApp(memory.supabase, ai.ai, undefined, highRiskAlert)).get(`/api/calls/${CALL_ID}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.notifications[0].status, "SENT");
  assert.equal(response.body.highRiskAlertConfigured, true);
  assert.equal(Object.hasOwn(response.body.notifications[0], "recipient"), false);
  assert.doesNotMatch(response.text, /manager@example.com/);
});

test("private audio redirects to a short-lived URL without exposing server credentials", async () => {
  const memory = createMemorySupabase();
  const ai = createAiDouble();

  const response = await request(createTestApp(memory.supabase, ai.ai))
    .get(`/api/calls/${CALL_ID}/audio`);

  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "https://storage.example.test/private-file?token=short-lived");
  assert.doesNotMatch(response.text, /SUPABASE_SECRET_KEY|service_role|sb_secret/);
  assert.equal(memory.calls.signedUrls, 1);
});
