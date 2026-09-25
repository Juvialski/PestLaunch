export type HighRiskAlertEmailInput = {
  callerName: string;
  callType: string;
  priority: "HIGH" | "URGENT";
  sentiment: string;
  summary: string;
  riskSignals: string[];
  evidence: Array<{ speaker?: string; quote: string }>;
  recommendedAction: { title: string; reason: string } | null;
  approvalStatus: string;
  callId: string;
  appUrl: string;
};

export type HighRiskAlertEmail = { subject: string; textContent: string; htmlContent: string };
export type BrevoSendResult = {
  status: "SENT" | "FAILED";
  providerMessageId: string | null;
  errorMessage: string | null;
};

const BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email";
const EMAIL_PATTERN = /^[^\s@<>(),;:\\[\]\\]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function shouldSendHighRiskAlert(analysis: { priority: string } | null | undefined): boolean {
  return analysis?.priority === "HIGH" || analysis?.priority === "URGENT";
}

export function parseHighRiskAlertRecipients(value: string | null | undefined): string[] {
  const addresses = new Set<string>();
  for (const candidate of value?.split(",") ?? []) {
    const normalized = candidate.trim().toLowerCase();
    if (isEmailAddress(normalized)) addresses.add(normalized);
  }
  return [...addresses];
}

export function buildHighRiskAlertEmail(input: HighRiskAlertEmailInput): HighRiskAlertEmail {
  const callerName = singleLine(input.callerName.trim()) || "Unknown caller";
  const actionTitle = input.recommendedAction?.title ?? "No deterministic action proposed";
  const actionReason = input.recommendedAction?.reason;
  const evidence = input.evidence.slice(0, 3);
  const risks = input.riskSignals.length > 0 ? input.riskSignals : ["High or urgent priority flagged"];
  const subjectName = callerName.slice(0, 120);
  const subject = `[PestLaunch] ${input.priority}-risk call — ${subjectName}`;

  const textContent = [
    "PestLaunch High-Risk Call Alert",
    "",
    `Customer: ${callerName}`,
    `Classification: ${input.callType}`,
    `Priority: ${input.priority}`,
    `Sentiment: ${input.sentiment}`,
    `Risk signals: ${risks.join("; ")}`,
    "",
    `Summary: ${input.summary}`,
    "",
    "Supporting evidence:",
    ...evidence.map((item) => `- ${item.speaker ? `${item.speaker}: ` : ""}"${item.quote}"`),
    "",
    `Recommended action: ${actionTitle}${actionReason ? ` — ${actionReason}` : ""}`,
    `Approval: ${input.approvalStatus}`,
    `Call ID: ${input.callId}`,
    "",
    `Review in PestLaunch: ${input.appUrl}`,
  ].join("\n");

  const htmlContent = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f7f4;font-family:Arial,sans-serif;color:#24352a">
    <main style="max-width:640px;margin:0 auto;padding:28px;background:#fff;border:1px solid #e3e9e2;border-radius:12px">
      <p style="margin:0 0 8px;color:#52705a;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">PestLaunch</p>
      <h1 style="margin:0 0 22px;font-size:22px">High-Risk Call Alert</h1>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr><th align="left" style="padding:7px 12px 7px 0">Customer</th><td>${escapeHtml(callerName)}</td></tr>
        <tr><th align="left" style="padding:7px 12px 7px 0">Classification</th><td>${escapeHtml(input.callType)}</td></tr>
        <tr><th align="left" style="padding:7px 12px 7px 0">Priority</th><td>${escapeHtml(input.priority)}</td></tr>
        <tr><th align="left" style="padding:7px 12px 7px 0">Sentiment</th><td>${escapeHtml(input.sentiment)}</td></tr>
        <tr><th align="left" style="padding:7px 12px 7px 0">Risk</th><td>${risks.map(escapeHtml).join(", ")}</td></tr>
      </table>
      <h2 style="margin:24px 0 8px;font-size:16px">Summary</h2><p style="margin:0;line-height:1.55">${escapeHtml(input.summary)}</p>
      <h2 style="margin:24px 0 8px;font-size:16px">Supporting evidence</h2>
      <ul style="padding-left:20px;line-height:1.55">${evidence.map((item) => `<li style="margin:0 0 8px">${item.speaker ? `<strong>${escapeHtml(item.speaker)}:</strong> ` : ""}&ldquo;${escapeHtml(item.quote)}&rdquo;</li>`).join("")}</ul>
      <h2 style="margin:24px 0 8px;font-size:16px">Recommended action</h2>
      <p style="margin:0;line-height:1.55">${escapeHtml(actionTitle)}${actionReason ? ` — ${escapeHtml(actionReason)}` : ""}</p>
      <p style="margin:8px 0 0;color:#735b31"><strong>Approval:</strong> ${escapeHtml(input.approvalStatus)}</p>
      <p style="margin:20px 0 0;color:#607066;font-size:12px">Call ID: ${escapeHtml(input.callId)}</p>
      <p style="margin:22px 0 0"><a href="${escapeHtml(input.appUrl)}" style="display:inline-block;padding:11px 16px;border-radius:7px;background:#355a42;color:#fff;text-decoration:none;font-weight:700">Review in PestLaunch</a></p>
    </main></body></html>`;

  return { subject, textContent, htmlContent };
}

export function createBrevoService(config: {
  apiKey?: string;
  senderEmail?: string;
  senderName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sandboxMode?: boolean;
}) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeoutMs = Number.isSafeInteger(config.timeoutMs) && (config.timeoutMs ?? 0) > 0
    ? Math.min(config.timeoutMs ?? 10_000, 30_000)
    : 10_000;

  return {
    async send(input: { recipient: string; message: HighRiskAlertEmail }): Promise<BrevoSendResult> {
      const apiKey = config.apiKey?.trim();
      const senderEmail = config.senderEmail?.trim().toLowerCase();
      const senderName = singleLine(config.senderName?.trim() || "PestLaunch Alerts").slice(0, 100);
      const recipient = input.recipient.trim().toLowerCase();
      if (!apiKey || !senderEmail || !isEmailAddress(senderEmail)) {
        return { status: "FAILED", providerMessageId: null, errorMessage: "Brevo configuration is incomplete." };
      }
      if (!isEmailAddress(recipient)) {
        return { status: "FAILED", providerMessageId: null, errorMessage: "The configured alert recipient is invalid." };
      }

      const body = {
        sender: { email: senderEmail, name: senderName },
        to: [{ email: recipient }],
        subject: input.message.subject,
        htmlContent: input.message.htmlContent,
        textContent: input.message.textContent,
        ...(config.sandboxMode ? { headers: { "X-Sib-Sandbox": "drop" } } : {}),
      };

      try {
        const response = await fetchImpl(BREVO_SEND_URL, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "api-key": apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          return { status: "FAILED", providerMessageId: null, errorMessage: `Brevo returned HTTP ${response.status}.` };
        }

        let providerMessageId: string | null = null;
        try {
          const result: unknown = await response.json();
          if (typeof result === "object" && result !== null && "messageId" in result) {
            const value = (result as { messageId?: unknown }).messageId;
            if (typeof value === "string" && value.trim()) providerMessageId = value.trim().slice(0, 500);
          }
        } catch {
          // An accepted response remains SENT even if optional response metadata is malformed.
        }
        return { status: "SENT", providerMessageId, errorMessage: null };
      } catch {
        return { status: "FAILED", providerMessageId: null, errorMessage: "Brevo request failed before an acceptance response." };
      }
    },
  };
}

function isEmailAddress(value: string): boolean {
  return value.length <= 320 && EMAIL_PATTERN.test(value);
}

function singleLine(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
