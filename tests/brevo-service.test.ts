import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHighRiskAlertEmail,
  createBrevoService,
  parseHighRiskAlertRecipients,
  shouldSendHighRiskAlert,
} from "../server/brevoService.js";

const alertInput = {
  callerName: "<Jordan & Co>",
  callType: "COMPLAINT",
  priority: "HIGH" as const,
  sentiment: "NEGATIVE",
  summary: "Repeated late visits have the customer considering cancellation.",
  riskSignals: ["Cancellation risk", "Complaint", "Follow-up required"],
  evidence: [
    { speaker: "Customer", quote: "Your technicians have been late three times." },
    { speaker: "Customer", quote: "I am thinking about cancelling." },
    { speaker: "Customer", quote: "Please have a manager call me." },
    { speaker: "Customer", quote: "This fourth quote must not be included." },
  ],
  recommendedAction: { title: "Create retention follow-up", reason: "Cancellation risk was detected." },
  approvalStatus: "Human approval required",
  callId: "53d0f8b5-e520-42fb-9c0a-a64fa1212cdd",
  appUrl: "https://pestlaunch.onrender.com",
};

test("only HIGH and URGENT analysis qualifies for an escalation", () => {
  assert.equal(shouldSendHighRiskAlert({ priority: "HIGH" }), true);
  assert.equal(shouldSendHighRiskAlert({ priority: "URGENT" }), true);
  assert.equal(shouldSendHighRiskAlert({ priority: "LOW" }), false);
  assert.equal(shouldSendHighRiskAlert({ priority: "MEDIUM" }), false);
  assert.equal(shouldSendHighRiskAlert(null), false);
});

test("configured recipients are normalized, deduplicated, and invalid entries are skipped", () => {
  assert.deepEqual(
    parseHighRiskAlertRecipients("  Ops@Company.com,invalid-address,ops@company.com, , manager+alert@example.org "),
    ["ops@company.com", "manager+alert@example.org"],
  );
  assert.deepEqual(parseHighRiskAlertRecipients(undefined), []);
  assert.deepEqual(parseHighRiskAlertRecipients(" , broken, not-an-email "), []);
});

test("alert content is concise, grounded, approval-aware, and HTML-safe", () => {
  const message = buildHighRiskAlertEmail(alertInput);

  assert.match(message.subject, /^\[PestLaunch\] HIGH-risk call/);
  assert.match(message.textContent, /COMPLAINT/);
  assert.match(message.textContent, /NEGATIVE/);
  assert.match(message.textContent, /Repeated late visits have the customer considering cancellation/);
  assert.match(message.textContent, /Your technicians have been late three times\./);
  assert.match(message.textContent, /I am thinking about cancelling\./);
  assert.doesNotMatch(message.textContent, /This fourth quote/);
  assert.match(message.textContent, /Create retention follow-up/);
  assert.match(message.textContent, /Human approval required/);
  assert.match(message.textContent, /53d0f8b5-e520-42fb-9c0a-a64fa1212cdd/);
  assert.match(message.textContent, /https:\/\/pestlaunch\.onrender\.com/);
  assert.doesNotMatch(message.textContent, /Action executed|full transcript/i);
  assert.match(message.htmlContent, /&lt;Jordan &amp; Co&gt;/);
  assert.doesNotMatch(message.htmlContent, /<Jordan & Co>/);
});

test("Brevo success normalizes the provider message ID and keeps credentials out of the body", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const service = createBrevoService({
    apiKey: "test-only-secret",
    senderEmail: "alerts@example.com",
    senderName: "PestLaunch Alerts",
    fetchImpl: async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ messageId: "<brevo-message-123>" }), { status: 201 });
    },
  });

  const result = await service.send({ recipient: "ops@example.com", message: buildHighRiskAlertEmail(alertInput) });

  assert.deepEqual(result, { status: "SENT", providerMessageId: "<brevo-message-123>", errorMessage: null });
  assert.equal(capturedUrl, "https://api.brevo.com/v3/smtp/email");
  assert.equal((capturedInit?.headers as Record<string, string>)?.["api-key"], "test-only-secret");
  assert.doesNotMatch(String(capturedInit?.body), /test-only-secret/);
  const requestBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  assert.deepEqual(requestBody.to, [{ email: "ops@example.com" }]);
  assert.match(String(requestBody.htmlContent), /High-Risk Call Alert/);
  assert.match(String(requestBody.textContent), /Supporting evidence/);
});

test("Brevo rejection returns a safe FAILED result without provider response details", async () => {
  const service = createBrevoService({
    apiKey: "test-only-secret",
    senderEmail: "alerts@example.com",
    senderName: "PestLaunch Alerts",
    fetchImpl: async () => new Response(JSON.stringify({ message: "private provider detail test-only-secret" }), { status: 429 }),
  });

  const result = await service.send({ recipient: "ops@example.com", message: buildHighRiskAlertEmail(alertInput) });

  assert.equal(result.status, "FAILED");
  assert.equal(result.errorMessage, "Brevo returned HTTP 429.");
  assert.equal(result.providerMessageId, null);
  assert.doesNotMatch(result.errorMessage ?? "", /private|secret/i);
});

test("sandbox mode marks the Brevo request to validate configuration without sending", async () => {
  let capturedBody: Record<string, unknown> = {};
  const service = createBrevoService({
    apiKey: "test-only-secret",
    senderEmail: "alerts@example.com",
    senderName: "PestLaunch Alerts",
    sandboxMode: true,
    fetchImpl: async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ messageId: "<sandbox-message>" }), { status: 201 });
    },
  });

  const result = await service.send({ recipient: "ops@example.com", message: buildHighRiskAlertEmail(alertInput) });

  assert.equal(result.status, "SENT");
  assert.deepEqual(capturedBody.headers, { "X-Sib-Sandbox": "drop" });
});

test("missing Brevo configuration fails safely without making a request", async () => {
  let requests = 0;
  const service = createBrevoService({
    apiKey: "",
    senderEmail: "",
    senderName: "PestLaunch Alerts",
    fetchImpl: async () => {
      requests += 1;
      return new Response(null, { status: 201 });
    },
  });

  const result = await service.send({ recipient: "ops@example.com", message: buildHighRiskAlertEmail(alertInput) });

  assert.equal(result.status, "FAILED");
  assert.equal(result.errorMessage, "Brevo configuration is incomplete.");
  assert.equal(requests, 0);
});
