import assert from "node:assert/strict";
import test from "node:test";
import { AUDIO_PLAYBACK_ERROR, visibleCallError } from "../src/shared/callErrorFeedback.js";
import {
  classifyGeminiFileUploadFailure,
  geminiFileUploadFailureMessage,
  geminiInlineAudio,
} from "../server/geminiService.js";

test("a process failure matching the persisted call error is shown once", () => {
  const message = "Gemini could not receive the recording. Check provider availability, then retry.";
  assert.equal(visibleCallError(message, message), message);
});

test("a persisted call error remains visible when there is no request error", () => {
  assert.equal(visibleCallError(null, "The transcript could not be saved. Please retry processing."), "The transcript could not be saved. Please retry processing.");
});

test("a Gemini file API 404 is reported as a provider failure rather than a model failure", () => {
  assert.equal(classifyGeminiFileUploadFailure({ status: 404, message: "" }), "PROVIDER_ERROR");
  assert.equal(
    geminiFileUploadFailureMessage("PROVIDER_ERROR"),
    "Gemini could not receive the recording. Check provider availability, then retry.",
  );
});

test("audio playback failure has a clear retry instruction", () => {
  assert.equal(AUDIO_PLAYBACK_ERROR, "This recording could not be played. Reopen the call and try again.");
});


test("small recordings are constructed as inline Gemini audio without a Files upload", () => {
  assert.deepEqual(geminiInlineAudio(Buffer.from([0, 1, 2, 255]), "audio/wav"), {
    type: "audio",
    data: "AAEC/w==",
    mime_type: "audio/wav",
  });
});
