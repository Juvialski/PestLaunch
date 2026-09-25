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

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
  };
};

export const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
