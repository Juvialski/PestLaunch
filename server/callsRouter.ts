import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AgentActionRowSchema, DemoCustomerSchema, type AgentActionRow, type CallActionPolicyState, type DemoCustomer } from "../src/shared/actions.js";
import {
  analysisEvidenceIsGrounded,
  CallAnalysisSchema,
  CallTranscriptSchema,
  type ApiErrorResponse,
  type CallAnalysisRow,
  type CallRecord,
  type CallSummary,
  type CallTranscriptRow,
} from "../src/shared/calls.js";
import { MAX_AUDIO_UPLOAD_BYTES } from "../src/shared/calls.js";
import { AiConfigurationError, isRecoverableAiError, RecoverableAiError, type CallsAiService } from "./aiTypes.js";
import { deriveCallActionPolicyState } from "./actionPolicy.js";
import { formatMaxUploadSize, validateAudioUpload } from "./audioValidation.js";

const CALL_SUMMARY_COLUMNS =
  "id,caller_name,demo_customer_id,original_filename,mime_type,status,duration,created_at,updated_at";
const CALL_RECORD_COLUMNS = `${CALL_SUMMARY_COLUMNS},audio_path,last_error`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNED_AUDIO_URL_TTL_SECONDS = 300;

type CallDetailPayload = {
  call: CallRecord;
  transcript: CallTranscriptRow | null;
  analysis: CallAnalysisRow | null;
  demoCustomer: DemoCustomer | null;
  actions: AgentActionRow[];
  actionPolicyState: CallActionPolicyState;
};

type RouterLogger = Pick<Console, "error"> & Partial<Pick<Console, "info" | "warn">>;

export type CallsRouterDependencies = {
  supabase: SupabaseClient;
  bucketName: string;
  ai: CallsAiService;
  maxUploadBytes?: number;
  logger?: RouterLogger;
};

export function createCallsRouter({
  supabase,
  bucketName,
  ai,
  maxUploadBytes = MAX_AUDIO_UPLOAD_BYTES,
  logger = console,
}: CallsRouterDependencies): express.Router {
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new Error("maxUploadBytes must be a positive safe integer.");
  }

  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxUploadBytes,
      files: 1,
      fields: 2,
      fieldSize: 1024,
      parts: 3,
    },
  });

  router.post("/ingest", upload.single("audio"), async (request, response) => {
    const file = request.file;
    if (!file) {
      sendError(response, 400, "AUDIO_REQUIRED", "Choose an audio file to upload.");
      return;
    }

    const validation = validateAudioUpload(
      {
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
      maxUploadBytes,
    );

    if (!validation.ok) {
      sendError(response, validation.statusCode, validation.code, validation.message);
      return;
    }

    const form = (request.body ?? {}) as Record<string, unknown>;
    const callerName = readCallerName(form.caller_name);
    if (callerName === undefined) {
      sendError(response, 400, "INVALID_CALLER_NAME", "Caller name must be 200 characters or fewer.");
      return;
    }

    const demoCustomerId = readDemoCustomerId(form.demo_customer_id);
    if (demoCustomerId === undefined) {
      sendError(response, 400, "INVALID_DEMO_CUSTOMER_ID", "Choose a valid demo customer.");
      return;
    }

    const callId = randomUUID();
    const audioPath = `calls/${callId}.${validation.extension}`;
    let audioUploaded = false;

    try {
      const { error: storageError } = await supabase.storage
        .from(bucketName)
        .upload(audioPath, file.buffer, {
          cacheControl: "3600",
          contentType: validation.mimeType,
          upsert: false,
        });

      if (storageError) {
        logger.error("Call recording upload failed.", storageError);
        sendError(response, 502, "AUDIO_STORAGE_FAILED", "The audio could not be stored. Please try again.");
        return;
      }
      audioUploaded = true;

      const record = {
        id: callId,
        caller_name: callerName,
        demo_customer_id: demoCustomerId,
        audio_path: audioPath,
        original_filename: validation.originalFilename,
        mime_type: validation.mimeType,
        status: "UPLOADED",
        duration: null,
        last_error: null,
      };

      const { data, error: databaseError } = await supabase
        .from("calls")
        .insert(record)
        .select(CALL_RECORD_COLUMNS)
        .single();

      if (databaseError || !data) {
        logger.error("Call record could not be persisted after audio upload.", databaseError);
        await removeUploadedRecording(supabase, bucketName, audioPath, logger);
        sendError(
          response,
          503,
          "CALL_PERSISTENCE_FAILED",
          "The call record could not be saved. Please retry the upload.",
        );
        return;
      }

      response.status(201).json({ call: data as CallRecord });
    } catch (error) {
      logger.error("Call ingestion failed.", error);
      if (audioUploaded) {
        await removeUploadedRecording(supabase, bucketName, audioPath, logger);
      }
      sendError(response, 503, "CALL_INGESTION_FAILED", "The call could not be saved. Please try again.");
    }
  });

  router.get("/", async (_request, response) => {
    try {
      const { data, error } = await supabase
        .from("calls")
        .select(CALL_SUMMARY_COLUMNS)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        logger.error("Recent calls could not be loaded.", error);
        sendError(response, 503, "CALLS_UNAVAILABLE", "Recent calls could not be loaded. Please try again.");
        return;
      }

      response.json({ calls: (data ?? []) as CallSummary[] });
    } catch (error) {
      logger.error("Recent calls request failed.", error);
      sendError(response, 503, "CALLS_UNAVAILABLE", "Recent calls could not be loaded. Please try again.");
    }
  });

  router.post("/:id/process", async (request, response) => {
    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      sendError(response, 400, "INVALID_CALL_ID", "Call ID must be a valid UUID.");
      return;
    }

    const callResult = await loadCall(supabase, id);
    if (callResult.error) {
      logger.error("Call processing could not load the call.", callResult.error);
      sendError(response, 503, "CALL_UNAVAILABLE", "Call processing could not start. Please try again.");
      return;
    }
    if (!callResult.call) {
      sendError(response, 404, "CALL_NOT_FOUND", "That call could not be found.");
      return;
    }

    const initialDetail = await loadCallDetail(supabase, callResult.call, logger);
    if (!initialDetail) {
      sendError(response, 503, "CALL_INTELLIGENCE_UNAVAILABLE", "Call intelligence could not be loaded. Please try again.");
      return;
    }

    if (callResult.call.status === "PROCESSING") {
      sendDetailError(response, 409, "CALL_ALREADY_PROCESSING", "This call is already processing.", initialDetail);
      return;
    }

    if (initialDetail.analysis) {
      if (callResult.call.status === "ANALYZED") {
        response.json(initialDetail);
        return;
      }

      const recovered = await setCallStatus(supabase, id, callResult.call.status, "ANALYZED", null);
      if (recovered.error) {
        logger.error("Call status could not be reconciled with its persisted analysis.", recovered.error);
        sendError(response, 503, "CALL_UNAVAILABLE", "Saved call intelligence could not be finalized. Please retry.");
        return;
      }
      if (recovered.call) {
        const recoveredDetail = await loadCallDetail(supabase, recovered.call, logger);
        if (recoveredDetail) {
          response.json(recoveredDetail);
          return;
        }
      }

      const latest = await loadCallDetailById(supabase, id, logger);
      if (latest?.call.status === "ANALYZED" && latest.analysis) {
        response.json(latest);
        return;
      }
      sendDetailError(
        response,
        409,
        "CALL_STATE_CHANGED",
        "The call changed state before its saved analysis could be finalized. Refresh and try again.",
        latest ?? initialDetail,
      );
      return;
    }

    const processingCall = await setCallStatus(supabase, id, callResult.call.status, "PROCESSING");
    if (processingCall.error) {
      logger.error("Call processing status could not be set.", processingCall.error);
      sendError(response, 503, "CALL_UNAVAILABLE", "Call processing could not start. Please try again.");
      return;
    }
    if (!processingCall.call) {
      const latest = await loadCallDetailById(supabase, id, logger);
      sendDetailError(
        response,
        409,
        "CALL_STATE_CHANGED",
        "The call changed state before processing could start. Refresh and try again.",
        latest ?? initialDetail,
      );
      return;
    }

    let currentCall = processingCall.call;
    try {
      let transcriptRow = initialDetail.transcript;
      if (!transcriptRow) {
        const { data: audioBlob, error: audioError } = await supabase.storage
          .from(bucketName)
          .download(currentCall.audio_path);
        if (audioError || !audioBlob) {
          logger.error("Private call recording could not be downloaded for transcription.", audioError);
          throw new ProcessingFailure(
            "The private recording could not be loaded. Please retry processing.",
            "AUDIO_DOWNLOAD_FAILED",
          );
        }

        const audio = Buffer.from(await audioBlob.arrayBuffer());
        if (audio.length === 0) {
          throw new ProcessingFailure("The stored recording is empty and cannot be transcribed.", "EMPTY_AUDIO");
        }

        const transcription = await ai.transcribe(audio, currentCall.mime_type);
        const { attemptCount, ...transcriptContent } = transcription;
        const validatedTranscript = CallTranscriptSchema.safeParse(transcriptContent);
        if (!validatedTranscript.success || !Number.isSafeInteger(attemptCount) || attemptCount < 1) {
          throw new RecoverableAiError(
            "Transcription output did not pass validation. Retry processing to use the configured fallback.",
            "INVALID_OUTPUT",
            Number.isSafeInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1,
          );
        }

        const { data: savedTranscript, error: transcriptError } = await supabase
          .from("transcripts")
          .upsert(
            {
              call_id: id,
              text: validatedTranscript.data.text,
              segments_json: validatedTranscript.data.segments,
              model_used: validatedTranscript.data.modelUsed,
              attempt_count: attemptCount,
            },
            { onConflict: "call_id" },
          )
          .select("*")
          .single();
        if (transcriptError || !savedTranscript) {
          logger.error("Transcript could not be persisted.", transcriptError);
          throw new ProcessingFailure("The transcript could not be saved. Please retry processing.", "TRANSCRIPT_SAVE_FAILED");
        }

        transcriptRow = readTranscriptRow(savedTranscript);
        if (!transcriptRow) {
          throw new ProcessingFailure("The saved transcript could not be read back.", "TRANSCRIPT_READ_FAILED");
        }
      }

      const transcribed = await setCallStatus(supabase, id, "PROCESSING", "TRANSCRIBED");
      if (transcribed.error || !transcribed.call) {
        logger.error("Call status could not be advanced after transcription.", transcribed.error);
        throw new ProcessingFailure("The transcript is saved, but call status could not be updated.", "CALL_STATUS_FAILED");
      }
      currentCall = transcribed.call;

      const result = await ai.analyze(transcriptRow.text);
      const validatedAnalysis = CallAnalysisSchema.safeParse(result.analysis);
      if (
        !validatedAnalysis.success ||
        !analysisEvidenceIsGrounded(validatedAnalysis.data, transcriptRow.text) ||
        typeof result.modelUsed !== "string" ||
        !result.modelUsed.trim() ||
        !Number.isSafeInteger(result.attemptCount) ||
        result.attemptCount < 1
      ) {
        throw new RecoverableAiError(
          "Call analysis did not pass validation. Review the transcript and retry processing.",
          "INVALID_OUTPUT",
          Number.isSafeInteger(result.attemptCount) && result.attemptCount > 0 ? result.attemptCount : 1,
        );
      }

      const { data: savedAnalysis, error: analysisError } = await supabase
        .from("call_analysis")
        .upsert(
          {
            call_id: id,
            call_type: validatedAnalysis.data.callType,
            confidence: validatedAnalysis.data.confidence,
            summary: validatedAnalysis.data.summary,
            analysis_json: validatedAnalysis.data,
            model_used: result.modelUsed,
          },
          { onConflict: "call_id" },
        )
        .select("*")
        .single();
      if (analysisError || !savedAnalysis || !readAnalysisRow(savedAnalysis)) {
        logger.error("Validated call analysis could not be persisted.", analysisError);
        throw new ProcessingFailure("The call analysis could not be saved. Please retry processing.", "ANALYSIS_SAVE_FAILED");
      }

      const analyzed = await setCallStatus(supabase, id, currentCall.status, "ANALYZED", null);
      if (analyzed.error || !analyzed.call) {
        logger.error("Call status could not be finalized after analysis.", analyzed.error);
        throw new ProcessingFailure("Call intelligence is saved, but call status could not be finalized.", "CALL_STATUS_FAILED");
      }
      currentCall = analyzed.call;

      const detail = await loadCallDetail(supabase, analyzed.call, logger);
      if (!detail) {
        sendError(response, 503, "CALL_INTELLIGENCE_UNAVAILABLE", "Call intelligence was saved but could not be reloaded.");
        return;
      }
      response.json(detail);
    } catch (error) {
      const recoverable = isRecoverableAiError(error);
      if (!recoverable && !(error instanceof ProcessingFailure)) {
        logger.error("Call processing failed unexpectedly.", error);
      }
      const status = recoverable ? "NEEDS_REVIEW" : "FAILED";
      const message = safeProcessingError(error);
      const failed = await setCallStatus(supabase, id, currentCall.status, status, message);
      if (failed.error) logger.error("Call processing failure state could not be persisted.", failed.error);
      const detail = await loadCallDetailById(supabase, id, logger);
      sendDetailError(
        response,
        recoverable ? 422 : 503,
        recoverable ? "AI_REVIEW_REQUIRED" : "CALL_PROCESSING_FAILED",
        message,
        detail ?? { ...initialDetail, call: failed.call ?? currentCall },
      );
    }
  });

  router.get("/:id/audio", async (request, response) => {
    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      sendError(response, 400, "INVALID_CALL_ID", "Call ID must be a valid UUID.");
      return;
    }

    const result = await loadCall(supabase, id);
    if (result.error) {
      logger.error("Call recording lookup failed.", result.error);
      sendError(response, 503, "AUDIO_UNAVAILABLE", "The recording could not be opened. Please try again.");
      return;
    }
    if (!result.call) {
      sendError(response, 404, "CALL_NOT_FOUND", "That call could not be found.");
      return;
    }

    try {
      const { data, error } = await supabase.storage
        .from(bucketName)
        .createSignedUrl(result.call.audio_path, SIGNED_AUDIO_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) {
        logger.error("Private call recording URL could not be signed.", error);
        sendError(response, 503, "AUDIO_UNAVAILABLE", "The recording could not be opened. Please try again.");
        return;
      }
      response.redirect(302, data.signedUrl);
    } catch (error) {
      logger.error("Private call recording URL request failed.", error);
      sendError(response, 503, "AUDIO_UNAVAILABLE", "The recording could not be opened. Please try again.");
    }
  });

  router.get("/:id", async (request, response) => {
    const { id } = request.params;
    if (!UUID_PATTERN.test(id)) {
      sendError(response, 400, "INVALID_CALL_ID", "Call ID must be a valid UUID.");
      return;
    }

    const result = await loadCall(supabase, id);
    if (result.error) {
      logger.error("Call details could not be loaded.", result.error);
      sendError(response, 503, "CALL_UNAVAILABLE", "Call details could not be loaded. Please try again.");
      return;
    }
    if (!result.call) {
      sendError(response, 404, "CALL_NOT_FOUND", "That call could not be found.");
      return;
    }

    const detail = await loadCallDetail(supabase, result.call, logger);
    if (!detail) {
      sendError(response, 503, "CALL_INTELLIGENCE_UNAVAILABLE", "Call intelligence could not be loaded. Please try again.");
      return;
    }
    response.json(detail);
  });

  const handleUploadError: ErrorRequestHandler = (error, _request, response, _next) => {
    void _next;
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      sendError(
        response,
        413,
        "UPLOAD_TOO_LARGE",
        `Audio must be ${formatMaxUploadSize(maxUploadBytes)} or smaller.`,
      );
      return;
    }

    if (error instanceof multer.MulterError) {
      sendError(response, 400, "INVALID_UPLOAD", "Upload one audio file using the audio field.");
      return;
    }

    logger.error("Call API request failed.", error);
    sendError(response, 500, "INTERNAL_ERROR", "The request could not be completed.");
  };

  router.use(handleUploadError);
  return router;
}

function readCallerName(value: unknown): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length > 200) {
    return undefined;
  }
  return normalized || null;
}

function readDemoCustomerId(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return undefined;
  }
  return value;
}

async function removeUploadedRecording(
  supabase: SupabaseClient,
  bucketName: string,
  audioPath: string,
  logger: Pick<Console, "error">,
): Promise<void> {
  try {
    const { error } = await supabase.storage.from(bucketName).remove([audioPath]);
    if (error) {
      logger.error("Uploaded recording cleanup failed.", error);
    }
  } catch (error) {
    logger.error("Uploaded recording cleanup failed.", error);
  }
}

async function loadCall(
  supabase: SupabaseClient,
  id: string,
): Promise<{ call: CallRecord | null; error: unknown | null }> {
  try {
    const { data, error } = await supabase
      .from("calls")
      .select(CALL_RECORD_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    return { call: data ? (data as CallRecord) : null, error };
  } catch (error) {
    return { call: null, error };
  }
}

async function loadCallDetail(
  supabase: SupabaseClient,
  call: CallRecord,
  logger: RouterLogger,
): Promise<CallDetailPayload | null> {
  try {
    const [transcriptResult, analysisResult, actionResult, customerResult] = await Promise.all([
      supabase.from("transcripts").select("*").eq("call_id", call.id).maybeSingle(),
      supabase.from("call_analysis").select("*").eq("call_id", call.id).maybeSingle(),
      supabase.from("agent_actions").select("*").eq("call_id", call.id).order("created_at", { ascending: true }).limit(50),
      call.demo_customer_id
        ? supabase.from("demo_customers").select("*").eq("id", call.demo_customer_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (transcriptResult.error || analysisResult.error || actionResult.error || customerResult.error) {
      logger.error("Persisted call detail could not be loaded.", {
        transcript: transcriptResult.error,
        analysis: analysisResult.error,
        actions: actionResult.error,
        demoCustomer: customerResult.error,
      });
      return null;
    }

    const transcript = readTranscriptRow(transcriptResult.data);
    const analysis = readAnalysisRow(analysisResult.data);
    const actionRows = Array.isArray(actionResult.data) ? actionResult.data : [];
    const actions: AgentActionRow[] = [];
    for (const row of actionRows) {
      const parsed = AgentActionRowSchema.safeParse(row);
      if (!parsed.success || parsed.data.call_id !== call.id) {
        logger.error("Persisted agent action failed runtime validation.");
        return null;
      }
      actions.push(parsed.data);
    }
    const parsedCustomer = customerResult.data ? DemoCustomerSchema.safeParse(customerResult.data) : null;
    if (parsedCustomer && !parsedCustomer.success) {
      logger.error("Linked demo customer failed runtime validation.");
      return null;
    }
    const demoCustomer = parsedCustomer?.success ? parsedCustomer.data : null;
    const analysisIsGrounded = Boolean(
      transcript && analysis && analysisEvidenceIsGrounded(analysis.analysis_json, transcript.text),
    );
    const validatedAnalysis =
      transcript && analysis && !analysisIsGrounded
        ? null
        : analysis;
    return {
      call,
      transcript,
      demoCustomer,
      actions,
      analysis: validatedAnalysis,
      actionPolicyState: deriveCallActionPolicyState(
        analysisIsGrounded ? analysis?.analysis_json ?? null : null,
        demoCustomer,
        actions,
      ),
    };
  } catch (error) {
    logger.error("Persisted call intelligence request failed.", error);
    return null;
  }
}

async function loadCallDetailById(
  supabase: SupabaseClient,
  id: string,
  logger: RouterLogger,
): Promise<CallDetailPayload | null> {
  const result = await loadCall(supabase, id);
  if (result.error || !result.call) return null;
  return loadCallDetail(supabase, result.call, logger);
}

function readTranscriptRow(value: unknown): CallTranscriptRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const parsed = CallTranscriptSchema.safeParse({
    text: row.text,
    segments: row.segments_json,
    modelUsed: row.model_used,
  });
  if (
    !parsed.success ||
    typeof row.id !== "string" ||
    typeof row.call_id !== "string" ||
    typeof row.created_at !== "string" ||
    !Number.isSafeInteger(row.attempt_count) ||
    Number(row.attempt_count) < 1
  ) {
    return null;
  }

  return {
    id: row.id,
    call_id: row.call_id,
    text: parsed.data.text,
    segments_json: parsed.data.segments,
    model_used: parsed.data.modelUsed,
    attempt_count: Number(row.attempt_count),
    created_at: row.created_at,
  };
}

function readAnalysisRow(value: unknown): CallAnalysisRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const parsed = CallAnalysisSchema.safeParse(row.analysis_json);
  const hasConfidence =
    typeof row.confidence === "number" || (typeof row.confidence === "string" && Boolean(row.confidence.trim()));
  const confidence = hasConfidence ? Number(row.confidence) : Number.NaN;
  if (
    !parsed.success ||
    typeof row.id !== "string" ||
    typeof row.call_id !== "string" ||
    typeof row.model_used !== "string" ||
    !row.model_used.trim() ||
    typeof row.created_at !== "string" ||
    row.call_type !== parsed.data.callType ||
    row.summary !== parsed.data.summary ||
    !Number.isFinite(confidence) ||
    Math.abs(confidence - parsed.data.confidence) > 0.00011
  ) {
    return null;
  }

  return {
    id: row.id,
    call_id: row.call_id,
    call_type: typeof row.call_type === "string" ? row.call_type : null,
    confidence,
    summary: parsed.data.summary,
    analysis_json: parsed.data,
    model_used: row.model_used,
    created_at: row.created_at,
  };
}

async function setCallStatus(
  supabase: SupabaseClient,
  id: string,
  expectedStatus: string,
  status: string,
  lastError?: string | null,
): Promise<{ call: CallRecord | null; error: unknown | null }> {
  try {
    const values: Record<string, unknown> = { status };
    if (lastError !== undefined) values.last_error = lastError;
    const { data, error } = await supabase
      .from("calls")
      .update(values)
      .eq("id", id)
      .eq("status", expectedStatus)
      .select(CALL_RECORD_COLUMNS)
      .maybeSingle();
    return { call: data ? (data as CallRecord) : null, error };
  } catch (error) {
    return { call: null, error };
  }
}

class ProcessingFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProcessingFailure";
  }
}

function safeProcessingError(error: unknown): string {
  if (error instanceof ProcessingFailure) return error.message;
  if (error instanceof AiConfigurationError) {
    return "AI processing is unavailable right now. Please contact the administrator.";
  }
  if (isRecoverableAiError(error) && error.message.trim()) return error.message.slice(0, 500);
  return "Call processing failed because of an internal error. Please retry.";
}

function sendDetailError(
  response: express.Response,
  statusCode: number,
  code: string,
  message: string,
  detail: CallDetailPayload,
): void {
  response.status(statusCode).json({
    ...detail,
    error: { code, message },
  });
}

function sendError(
  response: express.Response,
  statusCode: number,
  code: string,
  message: string,
): void {
  const payload: ApiErrorResponse = { error: { code, message } };
  response.status(statusCode).json(payload);
}
