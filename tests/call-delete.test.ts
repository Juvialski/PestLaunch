import assert from "node:assert/strict";
import express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import request from "supertest";
import test from "node:test";
import { createCallsRouter } from "../server/callsRouter.js";
import type { CallsAiService } from "../server/aiTypes.js";
import type { CallStatus } from "../src/shared/calls.js";

const CALL_ID = "3dd5d1a6-8118-43e4-b340-206825622cff";

function createDeleteFixture(status: CallStatus) {
  const call = {
    id: CALL_ID,
    caller_name: "Failed demo",
    demo_customer_id: null,
    audio_path: `calls/${CALL_ID}.wav`,
    original_filename: "failed.wav",
    mime_type: "audio/wav",
    status,
    duration: null,
    last_error: status === "ANALYZED" ? null : "Provider failed.",
    created_at: "2026-09-25T00:00:00.000Z",
    updated_at: "2026-09-25T00:00:00.000Z",
  };
  let deleted = false;
  let removedPath: string | null = null;

  class Query {
    private id: string | null = null;
    constructor(private readonly operation: "select" | "delete") {}
    select() { return this; }
    eq(column: string, value: unknown) {
      if (column === "id" && typeof value === "string") this.id = value;
      return this;
    }
    async maybeSingle() {
      if (this.operation === "select") {
        return { data: !deleted && this.id === CALL_ID ? { ...call } : null, error: null };
      }
      if (this.id !== CALL_ID || deleted) return { data: null, error: null };
      deleted = true;
      return { data: { id: CALL_ID }, error: null };
    }
  }

  const supabase = {
    from(table: string) {
      assert.equal(table, "calls");
      return {
        select() { return new Query("select"); },
        delete() { return new Query("delete"); },
      };
    },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "call-recordings");
        return {
          async remove(paths: string[]) {
            assert.deepEqual(paths, [call.audio_path]);
            removedPath = paths[0] ?? null;
            return { data: [], error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;

  const ai: CallsAiService = {
    async transcribe() { throw new Error("delete must not invoke transcription"); },
    async analyze() { throw new Error("delete must not invoke analysis"); },
  };
  const app = express();
  app.use("/api/calls", createCallsRouter({ supabase, bucketName: "call-recordings", ai }));

  return {
    app,
    deleted: () => deleted,
    removedPath: () => removedPath,
  };
}

test("failed and review-required attempts can be deleted with their recording", async () => {
  for (const status of ["FAILED", "NEEDS_REVIEW"] as const) {
    const fixture = createDeleteFixture(status);
    const response = await request(fixture.app).delete(`/api/calls/${CALL_ID}`);

    assert.equal(response.status, 204);
    assert.equal(fixture.deleted(), true);
    assert.equal(fixture.removedPath(), `calls/${CALL_ID}.wav`);
  }
});

test("successful analyzed calls cannot be deleted through the failed-attempt endpoint", async () => {
  const fixture = createDeleteFixture("ANALYZED");
  const response = await request(fixture.app).delete(`/api/calls/${CALL_ID}`);

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, "CALL_DELETE_NOT_ALLOWED");
  assert.equal(fixture.deleted(), false);
  assert.equal(fixture.removedPath(), null);
});
