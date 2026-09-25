import { z } from "zod";

export const CALL_STATUSES = [
  "UPLOADED",
  "PROCESSING",
  "TRANSCRIBED",
  "ANALYZED",
  "NEEDS_REVIEW",
  "FAILED",
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

export type CallSummary = {
  id: string;
  caller_name: string | null;
  demo_customer_id: string | null;
  original_filename: string;
  mime_type: string;
  status: CallStatus;
  duration: number | null;
  created_at: string;
  updated_at: string;
};

export type CallRecord = CallSummary & {
  audio_path: string;
  last_error: string | null;
};

export const CALL_TYPES = [
  "NEW_LEAD",
  "BOOKING",
  "SERVICE",
  "COMPLAINT",
  "CANCELLATION",
  "COLLECTIONS",
  "UPSELL",
  "REACTIVATION",
  "INTERNAL",
  "OTHER",
] as const;

export const SENTIMENTS = ["POSITIVE", "NEUTRAL", "NEGATIVE", "MIXED"] as const;
export const CALL_OUTCOMES = ["RESOLVED", "UNRESOLVED", "FOLLOW_UP_REQUIRED", "UNKNOWN"] as const;
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export const TranscriptSegmentSchema = z
  .object({
    speaker: z.string().trim().min(1).max(80),
    startMs: z.number().int().nonnegative().optional(),
    endMs: z.number().int().nonnegative().optional(),
    text: z.string().trim().min(1).max(10_000),
  })
  .strict();

export const TranscriptContentSchema = z
  .object({
    text: z.string().trim().min(1).max(500_000),
    segments: z.array(TranscriptSegmentSchema).max(10_000),
  })
  .strict();

export const CallTranscriptSchema = TranscriptContentSchema.extend({
  modelUsed: z.string().trim().min(1).max(120),
})
  .strict()
  .superRefine((transcript, context) => {
    transcript.segments.forEach((segment, index) => {
      if (segment.startMs !== undefined && segment.endMs !== undefined && segment.endMs < segment.startMs) {
        context.addIssue({
          code: "custom",
          message: "Segment endMs must be after startMs.",
          path: ["segments", index, "endMs"],
        });
      }
    });
  });

export const CallAnalysisSchema = z
  .object({
    callType: z.enum(CALL_TYPES),
    confidence: z.number().min(0).max(1),
    summary: z.string().trim().min(1).max(1_000),
    customerIntent: z.string().trim().min(1).max(1_000),
    sentiment: z.enum(SENTIMENTS),
    outcome: z.enum(CALL_OUTCOMES),
    signals: z
      .object({
        newLead: z.boolean(),
        complaint: z.boolean(),
        cancellationRisk: z.boolean(),
        upsellOpportunity: z.boolean(),
        reactivationOpportunity: z.boolean(),
        collectionsIssue: z.boolean(),
        followUpRequired: z.boolean(),
      })
      .strict(),
    priority: z.enum(PRIORITIES),
    evidence: z
      .array(
        z
          .object({
            speaker: z.string().trim().min(1).max(80).optional(),
            quote: z.string().trim().min(1).max(300),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    recommendedAction: z
      .object({
        type: z.string().trim().min(1).max(80),
        reason: z.string().trim().min(1).max(500),
        requiresApproval: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type CallTranscript = z.infer<typeof CallTranscriptSchema>;
export type CallTranscriptRow = {
  id: string;
  call_id: string;
  text: string;
  segments_json: TranscriptSegment[];
  model_used: string;
  attempt_count: number;
  created_at: string;
};
export type CallAnalysis = z.infer<typeof CallAnalysisSchema>;

export function analysisEvidenceIsGrounded(analysis: CallAnalysis, transcript: string): boolean {
  const normalizedTranscript = normalizeEvidenceText(transcript);
  return analysis.evidence.every((item) => normalizedTranscript.includes(normalizeEvidenceText(item.quote)));
}

function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}' ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type CallAnalysisRow = {
  id: string;
  call_id: string;
  call_type: string | null;
  confidence: number | null;
  summary: string | null;
  analysis_json: CallAnalysis;
  model_used: string;
  created_at: string;
};

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
