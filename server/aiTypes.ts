import type { CallAnalysis, CallTranscript } from "../src/shared/calls.js";

export type CustomerCommunicationDraftInput = {
  customerName?: string;
  transcript: string;
  analysis: {
    summary: string;
    customerIntent: string;
    outcome: CallAnalysis["outcome"];
    signals: Pick<
      CallAnalysis["signals"],
      "newLead" | "complaint" | "cancellationRisk" | "upsellOpportunity" | "reactivationOpportunity" | "followUpRequired"
    >;
  };
  actionType:
    | "CREATE_RETENTION_FOLLOWUP"
    | "CREATE_SALES_FOLLOWUP"
    | "CREATE_UPSELL_TASK"
    | "CREATE_REACTIVATION_FOLLOWUP";
  actionReason: string;
};

export type CustomerCommunicationDraftResult = {
  subject: string;
  body: string;
  modelUsed: "gemini-3.5-flash-lite";
};

export type AiFailureCategory =
  | "QUOTA"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "MODEL_UNAVAILABLE"
  | "INVALID_OUTPUT"
  | "UNSUPPORTED_INPUT"
  | "CONFIGURATION";

export type CallTranscriptionResult = CallTranscript & { attemptCount: number };
export type CallAnalysisResult = { analysis: CallAnalysis; modelUsed: string; attemptCount: number };

export type CallsAiService = {
  transcribe(audio: Buffer, mimeType: string): Promise<CallTranscriptionResult>;
  analyze(transcript: string): Promise<CallAnalysisResult>;
  draftCustomerCommunication(input: CustomerCommunicationDraftInput): Promise<CustomerCommunicationDraftResult>;
};

export class RecoverableAiError extends Error {
  readonly recoverable = true;

  constructor(
    message: string,
    readonly category: AiFailureCategory,
    readonly attemptCount: number,
  ) {
    super(message);
    this.name = "RecoverableAiError";
  }
}

export class AiConfigurationError extends Error {
  readonly recoverable = false;
  readonly category = "CONFIGURATION" satisfies AiFailureCategory;

  constructor(message = "GEMINI_API_KEY is not configured on the server.") {
    super(message);
    this.name = "AiConfigurationError";
  }
}

export function isRecoverableAiError(error: unknown): error is RecoverableAiError {
  return (
    error instanceof RecoverableAiError ||
    (error instanceof Error && "recoverable" in error && error.recoverable === true)
  );
}
