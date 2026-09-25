import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiService } from "../server/geminiService.js";
import type { CustomerCommunicationDraftInput } from "../server/aiTypes.js";

const input: CustomerCommunicationDraftInput = {
  customerName: "Jordan Example",
  transcript: "Your technicians have been late twice. I am considering cancelling.",
  analysis: {
    summary: "The caller reports repeated late visits.",
    customerIntent: "The customer is considering cancellation.",
    outcome: "FOLLOW_UP_REQUIRED",
    signals: { complaint: true, cancellationRisk: true, followUpRequired: true },
  },
  actionType: "CREATE_RETENTION_FOLLOWUP",
  actionReason: "P2 detected cancellation risk or classified this call as a cancellation.",
};

function createService(output: string) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    interactions: {
      async create(request: Record<string, unknown>) {
        requests.push(request);
        return { output_text: output };
      },
    },
  };
  const service = createGeminiService("test-key", { info() {}, warn() {} }, client as never);
  return { service, requests };
}

test("customer draft uses one high-thinking Flash-Lite call with only review context", async () => {
  const { service, requests } = createService(JSON.stringify({
    subject: "Following up on your pest control service",
    body: "Hi Jordan, I am sorry for the repeated delays. We are reviewing the scheduling issue and will follow up before your next visit.",
  }));

  const result = await service.draftCustomerCommunication(input);

  assert.deepEqual(result, {
    subject: "Following up on your pest control service",
    body: "Hi Jordan, I am sorry for the repeated delays. We are reviewing the scheduling issue and will follow up before your next visit.",
    modelUsed: "gemini-3.5-flash-lite",
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.model, "gemini-3.5-flash-lite");
  assert.deepEqual(requests[0]?.generation_config, { thinking_level: "high" });
  assert.match(String(requests[0]?.input), /Jordan/);
  assert.match(String(requests[0]?.input), /late twice/);
  assert.match(String(requests[0]?.input), /CREATE_RETENTION_FOLLOWUP/);
  assert.doesNotMatch(String(requests[0]?.input), /demo_customer_id|SUPABASE|customer email/i);
});

test("customer draft rejects incomplete and unsupported customer promises", async () => {
  const outputs = [
    JSON.stringify({ body: "Hi Jordan, we will follow up." }),
    JSON.stringify({ subject: "Following up", body: "   " }),
    JSON.stringify({ subject: "A discount", body: "Hi Jordan, we will apply a 20% discount to your account." }),
    JSON.stringify({ subject: "Service update", body: "Hi Jordan, our technician will arrive tomorrow." }),
    JSON.stringify({ subject: "Service update", body: "Hi Jordan, the cancellationRisk is high." }),
    JSON.stringify({ subject: "Service update", body: "Hi Jordan, our manager has already contacted you." }),
    JSON.stringify({ subject: "Service update", body: "Hi Jordan, the issue is resolved." }),
    JSON.stringify({ subject: "Service update", body: "Hi Jordan, we accept legal liability for this." }),
  ];

  for (const output of outputs) {
    const { service, requests } = createService(output);
    await assert.rejects(service.draftCustomerCommunication(input));
    assert.equal(requests.length, 1);
  }
});

test("customer draft rejects a different remedy or amount than the call evidence supports", async () => {
  const offerInput = {
    ...input,
    transcript: "We will provide a 10% discount on your next service visit.",
  };
  const outputs = [
    JSON.stringify({ subject: "A service update", body: "Hi Jordan, we will issue a refund on your next service visit." }),
    JSON.stringify({ subject: "A service update", body: "Hi Jordan, we will apply a 20% discount on your next service visit." }),
  ];

  for (const output of outputs) {
    const { service } = createService(output);
    await assert.rejects(service.draftCustomerCommunication(offerInput));
  }

  const supportedOffer = {
    subject: "Following up on your service",
    body: "Hi Jordan, we will provide the 10% discount discussed for your next visit.",
  };
  const supportedService = createService(JSON.stringify(supportedOffer));
  assert.equal((await supportedService.service.draftCustomerCommunication(offerInput)).body, supportedOffer.body);
});

test("a timing word elsewhere in the transcript does not authorize a technician arrival promise", async () => {
  const timingInput = {
    ...input,
    transcript: `${input.transcript} I can speak with the office tomorrow.`,
  };
  const output = JSON.stringify({
    subject: "Service update",
    body: "Hi Jordan, our technician will arrive tomorrow.",
  });
  const { service } = createService(output);

  await assert.rejects(service.draftCustomerCommunication(timingInput));
});
