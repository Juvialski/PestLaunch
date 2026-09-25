import assert from "node:assert/strict";
import test from "node:test";
import {
  CallProcessingCoordinator,
  mapCallProcessingProgress,
  pollCallUntilTerminal,
} from "../src/shared/callProcessingLifecycle.js";
import type { CallStatus } from "../src/shared/calls.js";

const CALL_ID = "3dd5d1a6-8118-43e4-b340-206825622cff";

function call(status: CallStatus) {
  return { id: CALL_ID, status };
}

function progress(
  overrides: Partial<Parameters<typeof mapCallProcessingProgress>[0]> = {},
) {
  return mapCallProcessingProgress({
    status: "UPLOADED",
    hasTranscript: false,
    hasAnalysis: false,
    actionPolicyState: "NOT_READY",
    requestPending: true,
    ...overrides,
  });
}

test("a newly uploaded call starts exactly one process request for its upload id", async () => {
  const coordinator = new CallProcessingCoordinator();
  const requestedCallIds: string[] = [];
  const request = async (callId: string) => {
    requestedCallIds.push(callId);
    return { callId };
  };

  const first = await coordinator.run(call("UPLOADED"), "fresh-upload", request);
  const duplicate = await coordinator.run(call("UPLOADED"), "fresh-upload", request);

  assert.deepEqual(first, { started: true, value: { callId: CALL_ID } });
  assert.deepEqual(duplicate, { started: false, reason: "already_started" });
  assert.deepEqual(requestedCallIds, [CALL_ID]);
});

test("page load never auto-processes a historical UPLOADED call", async () => {
  const coordinator = new CallProcessingCoordinator();
  let requests = 0;

  const result = await coordinator.run(call("UPLOADED"), "page-load", async () => {
    requests += 1;
  });

  assert.deepEqual(result, { started: false, reason: "page_load_does_not_process" });
  assert.equal(requests, 0);
});

test("an analyzed call cannot be restarted as an upload or recovery", async () => {
  const coordinator = new CallProcessingCoordinator();
  let requests = 0;
  const request = async () => { requests += 1; };

  const automatic = await coordinator.run(call("ANALYZED"), "fresh-upload", request);
  const recovery = await coordinator.run(call("ANALYZED"), "manual-recovery", request);

  assert.deepEqual(automatic, { started: false, reason: "not_processable" });
  assert.deepEqual(recovery, { started: false, reason: "not_processable" });
  assert.equal(requests, 0);
});

test("an in-flight call rejects a second process request and later permits recovery from review", async () => {
  const coordinator = new CallProcessingCoordinator();
  let finishFirst: (() => void) | undefined;
  let requests = 0;
  const first = coordinator.run(call("UPLOADED"), "fresh-upload", async () => {
    requests += 1;
    await new Promise<void>((resolve) => { finishFirst = resolve; });
  });

  const duplicate = await coordinator.run(call("UPLOADED"), "manual-recovery", async () => {
    requests += 1;
  });
  finishFirst?.();
  await first;

  const retry = await coordinator.run(call("NEEDS_REVIEW"), "manual-recovery", async () => {
    requests += 1;
  });

  assert.deepEqual(duplicate, { started: false, reason: "already_in_flight" });
  assert.deepEqual(retry, { started: true, value: undefined });
  assert.equal(requests, 2);
});

test("a failed automatic request does not auto-retry but allows a manual FAILED recovery", async () => {
  const coordinator = new CallProcessingCoordinator();
  let requests = 0;

  await assert.rejects(
    coordinator.run(call("UPLOADED"), "fresh-upload", async () => {
      requests += 1;
      throw new Error("provider failed");
    }),
    /provider failed/,
  );
  const duplicate = await coordinator.run(call("UPLOADED"), "fresh-upload", async () => {
    requests += 1;
  });
  const recovery = await coordinator.run(call("FAILED"), "manual-recovery", async () => {
    requests += 1;
    return "retried";
  });

  assert.deepEqual(duplicate, { started: false, reason: "already_started" });
  assert.deepEqual(recovery, { started: true, value: "retried" });
  assert.equal(requests, 2);
});

test("persisted UPLOADED progress shows the saved recording while processing starts", () => {
  const mapped = progress({ status: "UPLOADED" });

  assert.equal(mapped.mode, "processing");
  assert.deepEqual(mapped.completed, ["recording"]);
  assert.equal(mapped.active, null);
});

test("persisted PROCESSING without a transcript maps to transcription", () => {
  const mapped = progress({ status: "PROCESSING" });

  assert.deepEqual(mapped.completed, ["recording"]);
  assert.equal(mapped.active, "transcription");
});

test("persisted PROCESSING with a transcript maps to analysis", () => {
  const mapped = progress({ status: "PROCESSING", hasTranscript: true });

  assert.deepEqual(mapped.completed, ["recording", "transcription"]);
  assert.equal(mapped.active, "analysis");
});

test("persisted TRANSCRIBED maps to analysis", () => {
  const mapped = progress({ status: "TRANSCRIBED", hasTranscript: true });

  assert.deepEqual(mapped.completed, ["recording", "transcription"]);
  assert.equal(mapped.active, "analysis");
});

test("a persisted analysis with downstream workflow still running maps to workflow rules", () => {
  const mapped = progress({
    status: "TRANSCRIBED",
    hasTranscript: true,
    hasAnalysis: true,
    actionPolicyState: "ACTION_AVAILABLE",
  });

  assert.deepEqual(mapped.completed, ["recording", "transcription", "analysis"]);
  assert.equal(mapped.active, "workflow");
});

test("persisted ANALYZED with an available proposal maps to workflow rules", () => {
  const mapped = progress({
    status: "ANALYZED",
    hasTranscript: true,
    hasAnalysis: true,
    actionPolicyState: "ACTION_AVAILABLE",
  });

  assert.deepEqual(mapped.completed, ["recording", "transcription", "analysis"]);
  assert.equal(mapped.active, "workflow");
});

test("persisted no-action, pending, and completed outcomes finish at Ready for review", () => {
  const noAction = progress({
    status: "ANALYZED",
    hasTranscript: true,
    hasAnalysis: true,
    actionPolicyState: "NO_ACTION_REQUIRED",
  });
  const pending = progress({
    status: "ANALYZED",
    hasTranscript: true,
    hasAnalysis: true,
    actionPolicyState: "PENDING_ACTION",
  });
  const completed = progress({
    status: "ANALYZED",
    hasTranscript: true,
    hasAnalysis: true,
    actionPolicyState: "COMPLETED_ACTION",
  });

  assert.equal(noAction.mode, "ready");
  assert.equal(noAction.active, null);
  assert.equal(pending.mode, "ready");
  assert.equal(pending.active, null);
  assert.deepEqual(pending.completed, ["recording", "transcription", "analysis", "workflow", "review"]);
  assert.equal(completed.mode, "ready");
  assert.equal(completed.active, null);
});

test("FAILED and NEEDS_REVIEW stop progress and identify the stage requiring attention", () => {
  const failed = progress({ status: "FAILED", hasTranscript: false });
  const review = progress({ status: "NEEDS_REVIEW", hasTranscript: true, hasAnalysis: false });

  assert.equal(failed.mode, "attention");
  assert.equal(failed.errorStage, "transcription");
  assert.equal(review.mode, "attention");
  assert.equal(review.errorStage, "analysis");
});

test("polling reads serially and stops after an analyzed persisted state", async () => {
  let activeReads = 0;
  let maxActiveReads = 0;
  const observed: CallStatus[] = [];
  const result = await pollCallUntilTerminal({
    callId: CALL_ID,
    intervalMs: 1,
    maxAttempts: 8,
    wait: async () => {},
    readCall: async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return { call: { status: observed.length === 0 ? "PROCESSING" : "ANALYZED" } };
    },
    onUpdate: (detail) => observed.push(detail.call.status),
  });

  assert.equal(result.reason, "terminal");
  assert.deepEqual(observed, ["PROCESSING", "ANALYZED"]);
  assert.equal(maxActiveReads, 1);
});

test("polling stops on FAILED, NEEDS_REVIEW, abort, and its attempt bound", async () => {
  const terminalStatuses: CallStatus[] = ["FAILED", "NEEDS_REVIEW"];
  for (const status of terminalStatuses) {
    let reads = 0;
    const result = await pollCallUntilTerminal({
      callId: CALL_ID,
      intervalMs: 1,
      maxAttempts: 4,
      wait: async () => {},
      readCall: async () => {
        reads += 1;
        return { call: { status } };
      },
    });
    assert.equal(result.reason, "terminal");
    assert.equal(reads, 1);
  }

  const controller = new AbortController();
  let abortedReads = 0;
  const aborted = await pollCallUntilTerminal({
    callId: CALL_ID,
    intervalMs: 1,
    maxAttempts: 4,
    signal: controller.signal,
    wait: async () => { controller.abort(); },
    readCall: async () => {
      abortedReads += 1;
      return { call: { status: "PROCESSING" } };
    },
  });

  let boundedReads = 0;
  const bounded = await pollCallUntilTerminal({
    callId: CALL_ID,
    intervalMs: 1,
    maxAttempts: 3,
    wait: async () => {},
    readCall: async () => {
      boundedReads += 1;
      return { call: { status: "PROCESSING" } };
    },
  });

  assert.equal(aborted.reason, "aborted");
  assert.equal(abortedReads, 0);
  assert.equal(bounded.reason, "limit");
  assert.equal(boundedReads, 3);
});

test("the default polling delay aborts cleanly before reading a call", async () => {
  const controller = new AbortController();
  let reads = 0;
  const timer = setTimeout(() => controller.abort(), 1);
  const result = await pollCallUntilTerminal({
    callId: CALL_ID,
    intervalMs: 20,
    maxAttempts: 2,
    signal: controller.signal,
    readCall: async () => {
      reads += 1;
      return { call: { status: "PROCESSING" } };
    },
  });
  clearTimeout(timer);

  assert.equal(result.reason, "aborted");
  assert.equal(reads, 0);
});

test("polling reports transient read errors and continues without overlapping requests", async () => {
  const errors: unknown[] = [];
  let reads = 0;
  const result = await pollCallUntilTerminal({
    callId: CALL_ID,
    intervalMs: 1,
    maxAttempts: 3,
    wait: async () => {},
    readCall: async () => {
      reads += 1;
      if (reads === 1) throw new Error("temporary GET failure");
      return { call: { status: "ANALYZED" } };
    },
    onError: (error) => errors.push(error),
  });

  assert.equal(result.reason, "terminal");
  assert.equal(reads, 2);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /temporary GET failure/);
});
