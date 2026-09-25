import assert from "node:assert/strict";
import test from "node:test";
import { buildSourceTranscriptDisplay } from "../src/shared/sourceTranscript.js";

test("source transcript display preserves speakers and text without inventing timestamps", () => {
  const display = buildSourceTranscriptDisplay([
    { speaker: "spk:0", startMs: 0, endMs: 30_000, text: "The technicians arrived late." },
    { speaker: "Customer", startMs: 90_000, text: "I would like someone to follow up." },
    { speaker: "spk:2", text: "No timestamp was supplied." },
  ]);

  assert.deepEqual(display, [
    { speaker: "Speaker 1", timestamp: "0:00–0:30", text: "The technicians arrived late." },
    { speaker: "Customer", timestamp: "1:30", text: "I would like someone to follow up." },
    { speaker: "Speaker 3", timestamp: null, text: "No timestamp was supplied." },
  ]);
});
