import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";
import { createCallsRouter } from "../server/callsRouter.js";
import type { CallsAiService } from "../server/aiTypes.js";

const unusedAi: CallsAiService = {
  async transcribe() { throw new Error("Audio ingestion tests must not transcribe."); },
  async analyze() { throw new Error("Audio ingestion tests must not analyze."); },
};

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

type FakeClientOptions = {
  insertError?: { message: string };
  calls?: FakeCall[];
  call?: FakeCall | null;
};

function fakeCall(overrides: Partial<FakeCall> = {}): FakeCall {
  return {
    id: "3dd5d1a6-8118-43e4-b340-206825622cff",
    caller_name: null,
    demo_customer_id: null,
    audio_path: "calls/3dd5d1a6-8118-43e4-b340-206825622cff.mp3",
    original_filename: "recording.mp3",
    mime_type: "audio/mpeg",
    status: "UPLOADED",
    duration: null,
    last_error: null,
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

function createFakeSupabase(options: FakeClientOptions = {}) {
  const uploads: Array<{ bucket: string; path: string; options: object }> = [];
  const removals: Array<{ bucket: string; paths: string[] }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const rows = options.calls ?? [];
  const supabase = {
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, _file: Buffer, uploadOptions: object) {
            uploads.push({ bucket, path, options: uploadOptions });
            return { data: { path }, error: null };
          },
          async remove(paths: string[]) {
            removals.push({ bucket, paths });
            return { data: [], error: null };
          },
        };
      },
    },
    from(table: string) {
      if (table === "transcripts" || table === "call_analysis" || table === "demo_customers") {
        return {
          select() {
            return {
              eq() {
                return { async maybeSingle() { return { data: null, error: null }; } };
              },
            };
          },
        };
      }
      if (table === "agent_actions" || table === "call_notifications") {
        return {
          select() {
            return {
              eq() {
                return {
                  order() {
                    return { async limit() { return { data: [], error: null }; } };
                  },
                };
              },
            };
          },
        };
      }
      assert.equal(table, "calls");
      return {
        insert(record: Record<string, unknown>) {
          inserts.push(record);
          return {
            select() {
              return {
                async single() {
                  if (options.insertError) {
                    return { data: null, error: options.insertError };
                  }
                  return {
                    data: fakeCall(record as Partial<FakeCall>),
                    error: null,
                  };
                },
              };
            },
          };
        },
        select() {
          return {
            order() {
              return {
                async limit() {
                  return { data: rows, error: null };
                },
              };
            },
            eq() {
              return {
                async maybeSingle() {
                  return { data: options.call ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };

  return {
    supabase: supabase as unknown as SupabaseClient,
    uploads,
    removals,
    inserts,
  };
}

function createTestApp(supabase: SupabaseClient, maxUploadBytes = 1024) {
  const app = express();
  app.use(
    "/api/calls",
    createCallsRouter({
      supabase,
      bucketName: "call-recordings",
      ai: unusedAi,
      maxUploadBytes,
      logger: { error: () => undefined },
    }),
  );
  return app;
}

test("rejects unsupported audio before touching Supabase", async () => {
  const fake = createFakeSupabase();
  const response = await request(createTestApp(fake.supabase))
    .post("/api/calls/ingest")
    .attach("audio", Buffer.from("not audio"), {
      filename: "notes.txt",
      contentType: "text/plain",
    });

  assert.equal(response.status, 415);
  assert.equal(response.body.error.code, "UNSUPPORTED_AUDIO_TYPE");
  assert.equal(fake.uploads.length, 0);
  assert.equal(fake.inserts.length, 0);
});

test("rejects a supported extension when its explicit MIME type does not match", async () => {
  const fake = createFakeSupabase();
  const response = await request(createTestApp(fake.supabase))
    .post("/api/calls/ingest")
    .attach("audio", Buffer.from("synthetic audio"), {
      filename: "recording.mp3",
      contentType: "audio/mp4",
    });

  assert.equal(response.status, 415);
  assert.equal(response.body.error.code, "UNSUPPORTED_AUDIO_TYPE");
  assert.equal(fake.uploads.length, 0);
  assert.equal(fake.inserts.length, 0);
});

test("enforces the configured upload-size limit", async () => {
  const fake = createFakeSupabase();
  const response = await request(createTestApp(fake.supabase, 8))
    .post("/api/calls/ingest")
    .attach("audio", Buffer.alloc(9), {
      filename: "recording.mp3",
      contentType: "audio/mpeg",
    });

  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, "UPLOAD_TOO_LARGE");
  assert.equal(response.body.error.message, "Audio must be 8 bytes or smaller.");
  assert.equal(fake.uploads.length, 0);
  assert.equal(fake.inserts.length, 0);
});

test("accepts the supported audio formats and normalizes their stored MIME types", async () => {
  const formats = [
    { filename: "call.mp3", contentType: "audio/mp3", normalized: "audio/mpeg" },
    { filename: "call.wav", contentType: "audio/x-wav", normalized: "audio/wav" },
    { filename: "call.m4a", contentType: "audio/x-m4a", normalized: "audio/mp4" },
    { filename: "call.webm", contentType: "audio/webm", normalized: "audio/webm" },
  ];

  for (const format of formats) {
    const fake = createFakeSupabase();
    const response = await request(createTestApp(fake.supabase))
      .post("/api/calls/ingest")
      .attach("audio", Buffer.from("synthetic audio"), {
        filename: format.filename,
        contentType: format.contentType,
      });

    assert.equal(response.status, 201, format.filename);
    assert.equal(response.body.call.mime_type, format.normalized, format.filename);
  }
});

test("stores supported audio and returns the created call", async () => {
  const fake = createFakeSupabase();
  const response = await request(createTestApp(fake.supabase))
    .post("/api/calls/ingest")
    .field("caller_name", "Jamie Demo")
    .attach("audio", Buffer.from("synthetic audio"), {
      filename: "C:\\fakepath\\visit.m4a",
      contentType: "audio/mp4",
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.call.status, "UPLOADED");
  assert.equal(response.body.call.caller_name, "Jamie Demo");
  assert.equal(response.body.call.original_filename, "visit.m4a");
  assert.equal(response.body.call.mime_type, "audio/mp4");
  assert.match(response.body.call.audio_path, /^calls\/[0-9a-f-]+\.m4a$/i);
  assert.equal(fake.uploads.length, 1);
  assert.equal(fake.uploads[0]?.bucket, "call-recordings");
  assert.equal(fake.uploads[0]?.path, response.body.call.audio_path);
  assert.deepEqual(fake.uploads[0]?.options, {
    cacheControl: "3600",
    contentType: "audio/mp4",
    upsert: false,
  });
  assert.equal(fake.inserts.length, 1);
});

test("removes uploaded audio when the call record cannot be created", async () => {
  const fake = createFakeSupabase({
    insertError: { message: "database unavailable" },
  });
  const response = await request(createTestApp(fake.supabase))
    .post("/api/calls/ingest")
    .attach("audio", Buffer.from("synthetic audio"), {
      filename: "recording.webm",
      contentType: "audio/webm",
    });

  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "CALL_PERSISTENCE_FAILED");
  assert.equal(fake.uploads.length, 1);
  assert.deepEqual(fake.removals, [
    { bucket: "call-recordings", paths: [fake.uploads[0]?.path] },
  ]);
});

test("lists calls and retrieves one call by id", async () => {
  const row = fakeCall();
  const fake = createFakeSupabase({ calls: [row], call: row });
  const app = createTestApp(fake.supabase);

  const listResponse = await request(app).get("/api/calls");
  const detailResponse = await request(app).get(`/api/calls/${row.id}`);

  assert.equal(listResponse.status, 200);
  assert.deepEqual(listResponse.body.calls, [row]);
  assert.equal(detailResponse.status, 200);
  assert.deepEqual(detailResponse.body.call, row);
});
